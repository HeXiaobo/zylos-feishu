import Database from 'better-sqlite3';

import { isLiveNativeTaskGateReader } from './native-task-closure-gate-remote.js';

const REPORT_SCHEMA = 'zylos.native-task-completion-gate/v1';
const LINK_BACKEND = 'feishu-task-v2';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 4_096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function canonicalInstant(value, field) {
  const parsed = new Date(requireText(value, field, 64));
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} must be an instant`);
  return parsed.toISOString();
}

function normalizeCases(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('native Task completion cases must be a non-empty array');
  }
  return value.map((rawCase, index) => {
    const item = requireRecord(rawCase, `native Task completion cases[${index}]`);
    const unknown = Object.keys(item).find(key => !['taskGuid', 'eventId'].includes(key));
    if (unknown) {
      throw new TypeError(`native Task completion cases[${index}] contains unsupported field: ${unknown}`);
    }
    return Object.freeze({
      taskGuid: requireText(item.taskGuid, `native Task completion cases[${index}].taskGuid`),
      eventId: requireText(item.eventId, `native Task completion cases[${index}].eventId`),
    });
  });
}

function openReadonly(dbPath, field) {
  return new Database(requireText(dbPath, field), { readonly: true, fileMustExist: true });
}

function parseJson(value, field) {
  try {
    return JSON.parse(requireText(value, field, 100_000));
  } catch (error) {
    throw new TypeError(`${field} must be valid JSON: ${error.message}`);
  }
}

function failedCase(item, code, message, details = {}) {
  return Object.freeze({
    taskGuid: item.taskGuid,
    eventId: item.eventId,
    coreTaskId: null,
    validationPassed: false,
    passed: false,
    failures: Object.freeze([Object.freeze({ code, message, details: Object.freeze(details) })]),
    status: null,
    core: null,
    remote: null,
  });
}

async function evaluateCase({ coreDb, statusDb, appId, item, remoteReader }) {
  const links = coreDb.prepare(`
    SELECT links.task_id AS taskId, tasks.title, tasks.state, tasks.version
    FROM commitment_external_links AS links
    JOIN commitment_tasks AS tasks ON tasks.id = links.task_id
    WHERE links.backend = ? AND links.external_id = ?
  `).all(LINK_BACKEND, item.taskGuid);
  if (links.length !== 1) {
    return failedCase(
      item,
      links.length === 0 ? 'CORE_LINK_MISSING' : 'CORE_LINK_NOT_UNIQUE',
      'Task GUID must have exactly one feishu-task-v2 ExternalLink',
      { matches: links.length },
    );
  }
  const link = links[0];
  const taskLinks = coreDb.prepare(`
    SELECT external_id AS taskGuid
    FROM commitment_external_links
    WHERE backend = ? AND task_id = ?
  `).all(LINK_BACKEND, link.taskId);
  if (taskLinks.length !== 1 || taskLinks[0].taskGuid !== item.taskGuid) {
    return failedCase(
      item,
      'CORE_TASK_LINK_NOT_UNIQUE',
      'Core Task must own exactly one feishu-task-v2 GUID',
      { coreTaskId: link.taskId, taskGuids: taskLinks.map(row => row.taskGuid).sort() },
    );
  }

  const statusRow = statusDb.prepare(`
    SELECT event_id AS eventId, task_id AS taskGuid, app_id AS appId,
           event_types_json AS eventTypesJson, status, result_json AS resultJson,
           settled_at AS settledAt
    FROM task_v2_status_events
    WHERE event_id = ?
  `).get(item.eventId);
  if (!statusRow) {
    return failedCase(item, 'STATUS_EVENT_MISSING', 'Exact status event is absent from SQLite inbox');
  }
  if (statusRow.taskGuid !== item.taskGuid || statusRow.appId !== appId) {
    return failedCase(
      item,
      'STATUS_EVENT_IDENTITY_MISMATCH',
      'Status event belongs to another Task GUID or App',
      {
        expectedTaskGuid: item.taskGuid,
        observedTaskGuid: statusRow.taskGuid,
        expectedAppId: appId,
        observedAppId: statusRow.appId,
      },
    );
  }
  const eventTypes = parseJson(statusRow.eventTypesJson, 'status event_types_json');
  if (!Array.isArray(eventTypes) || !eventTypes.includes('task_completed_update')) {
    return failedCase(
      item,
      'STATUS_EVENT_NOT_COMPLETION',
      'Exact status event does not contain task_completed_update',
      { eventTypes },
    );
  }
  if (statusRow.status !== 'acknowledged' || statusRow.resultJson === null) {
    return failedCase(
      item,
      'STATUS_EVENT_NOT_ACKNOWLEDGED',
      'Completion status event has no acknowledged settlement',
      { status: statusRow.status },
    );
  }
  const statusResult = requireRecord(
    parseJson(statusRow.resultJson, 'status result_json'),
    'status result',
  );
  if (
    statusResult.status !== 'submitted_for_review'
    || statusResult.taskId !== link.taskId
    || statusResult.taskGuid !== item.taskGuid
    || statusResult.state !== 'review'
    || !Array.isArray(statusResult.commands)
    || !statusResult.commands.includes('SubmitForReview')
    || statusResult.commands.includes('AcceptTask')
  ) {
    return failedCase(
      item,
      'STATUS_RESULT_NOT_REVIEW_SUBMISSION',
      'Status settlement is not the exact native completion to Core review result',
      { result: statusResult },
    );
  }

  const submitKey = `feishu-task-v2:${item.eventId}:submit`;
  const startKey = `feishu-task-v2:${item.eventId}:start`;
  const submitReceipt = coreDb.prepare(`
    SELECT result_json AS resultJson
    FROM commitment_commands
    WHERE idempotency_key = ? AND task_id = ?
  `).get(submitKey, link.taskId);
  if (!submitReceipt) {
    return failedCase(
      item,
      'CORE_SUBMIT_RECEIPT_MISSING',
      'Exact native completion has no Core SubmitForReview command receipt',
      { idempotencyKey: submitKey },
    );
  }
  const submitResult = requireRecord(
    parseJson(submitReceipt.resultJson, 'Core submit receipt result_json'),
    'Core submit receipt result',
  );
  if (submitResult.event?.type !== 'TaskSubmittedForReview') {
    return failedCase(
      item,
      'CORE_SUBMIT_RECEIPT_INVALID',
      'Exact Core command receipt is not TaskSubmittedForReview',
      { observedEventType: submitResult.event?.type ?? null },
    );
  }
  const startReceipt = coreDb.prepare(`
    SELECT result_json AS resultJson
    FROM commitment_commands
    WHERE idempotency_key = ? AND task_id = ?
  `).get(startKey, link.taskId);
  if (startReceipt) {
    const startResult = requireRecord(
      parseJson(startReceipt.resultJson, 'Core start receipt result_json'),
      'Core start receipt result',
    );
    if (startResult.event?.type !== 'TaskStarted') {
      return failedCase(
        item,
        'CORE_START_RECEIPT_INVALID',
        'Optional Core start receipt is not TaskStarted',
        { observedEventType: startResult.event?.type ?? null },
      );
    }
  }
  const counts = coreDb.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'TaskStarted' THEN 1 ELSE 0 END) AS started,
      SUM(CASE WHEN event_type = 'TaskSubmittedForReview' THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN event_type = 'TaskAccepted' THEN 1 ELSE 0 END) AS accepted
    FROM commitment_events
    WHERE task_id = ?
  `).get(link.taskId);
  if (
    link.state !== 'review'
    || counts.submitted !== 1
    || counts.accepted !== 0
    || counts.started < 0
    || counts.started > 1
  ) {
    return failedCase(
      item,
      'CORE_REVIEW_CLOSURE_INVALID',
      'Core task/event history does not prove one review submission and zero acceptance',
      { state: link.state, counts },
    );
  }

  let remoteRead;
  try {
    remoteRead = await remoteReader.getTask({ taskGuid: item.taskGuid });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_TASK_READ_ERROR',
      'Completed Feishu Task could not be read',
      { error: String(error?.message ?? error).slice(0, 4_000) },
    );
  }
  if (
    remoteRead?.kind !== 'found'
    || remoteRead.task?.guid !== item.taskGuid
    || remoteRead.task?.coreTaskId !== link.taskId
    || remoteRead.task?.summary !== link.title
    || remoteRead.task?.completedAt === undefined
    || remoteRead.task?.completedAt === null
    || remoteRead.task?.completedAt === '0'
  ) {
    return failedCase(
      item,
      'REMOTE_TASK_NOT_COMPLETED',
      'Remote Task does not prove the same linked Task is completed',
      { remote: remoteRead ?? null },
    );
  }

  return Object.freeze({
    taskGuid: item.taskGuid,
    eventId: item.eventId,
    coreTaskId: link.taskId,
    validationPassed: true,
    passed: false,
    failures: Object.freeze([]),
    status: Object.freeze({
      status: statusRow.status,
      eventTypes: Object.freeze(eventTypes),
      result: Object.freeze(statusResult),
      settledAt: statusRow.settledAt,
    }),
    core: Object.freeze({
      state: link.state,
      version: link.version,
      commandReceipts: Object.freeze([...(startReceipt ? [startKey] : []), submitKey]),
      eventCounts: Object.freeze(counts),
    }),
    remote: Object.freeze({
      completedAt: remoteRead.task.completedAt,
      summary: remoteRead.task.summary,
    }),
  });
}

export async function evaluateNativeTaskCompletionClosure({
  coreDbPath,
  statusInboxDbPath,
  appId,
  cases,
  remoteReader,
  clock = () => new Date().toISOString(),
} = {}) {
  const normalizedAppId = requireText(appId, 'native Task completion appId');
  const normalizedCases = normalizeCases(cases);
  const remote = requireRecord(remoteReader, 'native Task completion remoteReader');
  requireFunction(remote.getTask, 'native Task completion remoteReader.getTask');
  const attestable = isLiveNativeTaskGateReader(remote);
  const checkedAt = canonicalInstant(clock(), 'native Task completion clock result');
  const coreDb = openReadonly(coreDbPath, 'native Task completion coreDbPath');
  const statusDb = openReadonly(statusInboxDbPath, 'native Task completion statusInboxDbPath');
  try {
    const validations = [];
    for (const item of normalizedCases) {
      try {
        validations.push(await evaluateCase({
          coreDb,
          statusDb,
          appId: normalizedAppId,
          item,
          remoteReader: remote,
        }));
      } catch (error) {
        validations.push(failedCase(
          item,
          'GATE_CASE_READ_ERROR',
          'Completion case could not be evaluated from read-only evidence',
          { error: String(error?.message ?? error).slice(0, 4_000) },
        ));
      }
    }
    const validated = validations.filter(item => item.validationPassed).length;
    const reports = validations.map(report => Object.freeze({
      ...report,
      passed: attestable && report.validationPassed,
    }));
    return Object.freeze({
      schema: REPORT_SCHEMA,
      checkedAt,
      evidenceMode: attestable ? 'live' : 'injected',
      attestable,
      validationPassed: validated === reports.length,
      passed: attestable && validated === reports.length,
      failureCodes: Object.freeze([...new Set(validations.flatMap(item => (
        item.failures.map(({ code }) => code)
      )))].sort()),
      attestationFailureCodes: Object.freeze(attestable ? [] : ['NON_LIVE_EVIDENCE']),
      totals: Object.freeze({
        cases: reports.length,
        validated,
        validationFailed: reports.length - validated,
        passed: attestable ? validated : 0,
        failed: attestable ? reports.length - validated : reports.length,
      }),
      cases: Object.freeze(reports),
    });
  } finally {
    statusDb.close();
    coreDb.close();
  }
}

export const NATIVE_TASK_COMPLETION_GATE_SCHEMA = REPORT_SCHEMA;
