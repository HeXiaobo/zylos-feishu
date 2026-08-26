import Database from 'better-sqlite3';

const REPORT_SCHEMA = 'zylos.native-task-closure-gate/v1';
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

function requireLatency(value) {
  if (!Number.isInteger(value) || value < 0 || value > 86_400_000) {
    throw new TypeError('maxInboundLatencyMs must be between 0 and 86400000');
  }
  return value;
}

function canonicalInstant(value, field) {
  const parsed = new Date(requireText(value, field, 64));
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} must be an instant`);
  return parsed.toISOString();
}

function normalizeCases(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('native Task closure cases must be a non-empty array');
  }
  return value.map((rawCase, index) => {
    const item = requireRecord(rawCase, `native Task closure cases[${index}]`);
    const notification = requireRecord(
      item.notification,
      `native Task closure cases[${index}].notification`,
    );
    if (!Array.isArray(notification.recipientIds) || notification.recipientIds.length === 0) {
      throw new TypeError(`native Task closure cases[${index}].notification.recipientIds must be non-empty`);
    }
    return Object.freeze({
      taskGuid: requireText(item.taskGuid, `native Task closure cases[${index}].taskGuid`),
      commentId: requireText(item.commentId, `native Task closure cases[${index}].commentId`),
      notification: Object.freeze({
        eventId: requireText(
          notification.eventId,
          `native Task closure cases[${index}].notification.eventId`,
        ),
        recipientIds: Object.freeze(notification.recipientIds.map((recipientId, recipientIndex) => (
          requireText(
            recipientId,
            `native Task closure cases[${index}].notification.recipientIds[${recipientIndex}]`,
          )
        ))),
      }),
    });
  });
}

function openReadonly(dbPath, field) {
  return new Database(requireText(dbPath, field, 4_096), {
    readonly: true,
    fileMustExist: true,
  });
}

function latencyBetween(receivedAt, occurredAt) {
  return new Date(receivedAt).valueOf() - new Date(occurredAt).valueOf();
}

function failedCase(item, code, message, details = {}) {
  return Object.freeze({
    taskGuid: item.taskGuid,
    commentId: item.commentId,
    coreTaskId: null,
    passed: false,
    failures: Object.freeze([Object.freeze({ code, message, details: Object.freeze(details) })]),
    inbound: null,
    outbound: null,
    notifications: null,
  });
}

async function evaluateCase({ coreDb, commentsDb, appId, item, remoteReader, maxInboundLatencyMs }) {
  const links = coreDb.prepare(`
    SELECT links.task_id AS taskId, tasks.title AS title
    FROM commitment_external_links AS links
    JOIN commitment_tasks AS tasks ON tasks.id = links.task_id
    WHERE links.backend = ? AND links.external_id = ?
  `).all(LINK_BACKEND, item.taskGuid);
  if (links.length === 0) {
    return failedCase(
      item,
      'CORE_LINK_MISSING',
      'Task GUID has no feishu-task-v2 ExternalLink',
      { backend: LINK_BACKEND, taskGuid: item.taskGuid },
    );
  }
  if (links.length > 1) {
    return failedCase(
      item,
      'CORE_LINK_NOT_UNIQUE',
      'Task GUID is owned by more than one feishu-task-v2 ExternalLink',
      { backend: LINK_BACKEND, taskGuid: item.taskGuid, matches: links.length },
    );
  }
  const link = links[0];
  const taskLinks = coreDb.prepare(`
    SELECT external_id AS taskGuid
    FROM commitment_external_links
    WHERE backend = ? AND task_id = ?
    ORDER BY external_id
  `).all(LINK_BACKEND, link.taskId);
  if (taskLinks.length !== 1 || taskLinks[0].taskGuid !== item.taskGuid) {
    return failedCase(
      item,
      'CORE_TASK_LINK_NOT_UNIQUE',
      'Core Task does not own exactly one feishu-task-v2 GUID',
      {
        coreTaskId: link.taskId,
        observedTaskGuids: taskLinks.map(({ taskGuid }) => taskGuid),
      },
    );
  }

  const inboundRows = commentsDb.prepare(`
    SELECT event_id AS eventId, task_guid AS taskGuid, comment_id AS commentId,
           occurred_at AS occurredAt, source, status, received_at AS receivedAt
    FROM feishu_task_comment_inbox
    WHERE app_id = ? AND comment_id = ?
    ORDER BY received_at DESC, event_id DESC
  `).all(appId, item.commentId);
  if (inboundRows.length === 0) {
    return failedCase(
      item,
      'INBOUND_COMMENT_MISSING',
      'Comment is absent from the durable inbound ledger',
      { appId, commentId: item.commentId },
    );
  }
  const observedTaskGuids = [...new Set(inboundRows.map(row => row.taskGuid))].sort();
  if (
    observedTaskGuids.length > 0
    && (observedTaskGuids.length !== 1 || observedTaskGuids[0] !== item.taskGuid)
  ) {
    return failedCase(
      item,
      'COMMENT_TASK_MISMATCH',
      'Comment ledger identity belongs to a different Task GUID',
      { expectedTaskGuid: item.taskGuid, observedTaskGuids },
    );
  }
  const realtimeRows = inboundRows.filter(row => (
    row.taskGuid === item.taskGuid && row.source === 'event'
  ));
  if (inboundRows.length > 0 && realtimeRows.length === 0) {
    return failedCase(
      item,
      'INBOUND_SOURCE_NOT_REALTIME',
      'Comment was observed only by reconciliation, not the realtime event path',
      { observedSource: inboundRows[0].source },
    );
  }
  const inbound = inboundRows.find(row => (
    row.taskGuid === item.taskGuid && row.source === 'event' && row.status === 'processed'
  ));
  if (!inbound) {
    return failedCase(
      item,
      'INBOUND_NOT_PROCESSED',
      'Realtime comment intake did not reach processed status',
      { observedStatus: realtimeRows[0]?.status ?? null },
    );
  }
  const latencyMs = latencyBetween(inbound.receivedAt, inbound.occurredAt);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return failedCase(
      item,
      'INBOUND_LATENCY_INVALID',
      'Comment intake timestamps do not form a valid non-negative latency',
      { occurredAt: inbound.occurredAt, receivedAt: inbound.receivedAt },
    );
  }
  if (latencyMs > maxInboundLatencyMs) {
    return failedCase(
      item,
      'INBOUND_LATENCY_EXCEEDED',
      'Realtime comment intake exceeded the configured latency SLO',
      { latencyMs, maxInboundLatencyMs },
    );
  }

  const outboundRows = commentsDb.prepare(`
    SELECT idempotency_key AS idempotencyKey, reply_to_comment_id AS replyToCommentId,
           status, comment_id AS commentId
    FROM feishu_task_comment_outbound
    WHERE app_id = ? AND task_guid = ? AND reply_to_comment_id = ?
  `).all(appId, item.taskGuid, item.commentId);
  if (outboundRows.length === 0) {
    return failedCase(
      item,
      'OUTBOUND_REPLY_MISSING',
      'No Agent reply targets the exact inbound comment',
      { replyToCommentId: item.commentId },
    );
  }
  const sentOutboundRows = outboundRows.filter(row => row.status === 'sent');
  if (sentOutboundRows.length === 0) {
    return failedCase(
      item,
      'OUTBOUND_REPLY_NOT_SENT',
      'Exact Agent reply has no sent delivery receipt',
      { statuses: [...new Set(outboundRows.map(row => row.status))].sort() },
    );
  }
  if (sentOutboundRows.length > 1) {
    return failedCase(
      item,
      'OUTBOUND_REPLY_NOT_UNIQUE',
      'More than one sent Agent reply targets the same inbound comment',
      { sentReplies: sentOutboundRows.length },
    );
  }
  const outbound = sentOutboundRows[0];

  const notificationRows = commentsDb.prepare(`
    SELECT dedupe_key AS dedupeKey, recipient_id AS recipientId,
           status, sent_at AS sentAt
    FROM feishu_task_notifications
    WHERE event_id = ? AND task_id = ?
      AND recipient_id IN (${item.notification.recipientIds.map(() => '?').join(', ')})
  `).all(item.notification.eventId, link.taskId, ...item.notification.recipientIds);
  const sentRecipients = new Set(
    notificationRows.filter(row => row.status === 'sent' && row.sentAt).map(row => row.recipientId),
  );
  const missingRecipientIds = item.notification.recipientIds.filter(
    recipientId => !sentRecipients.has(recipientId),
  );
  if (missingRecipientIds.length > 0) {
    return failedCase(
      item,
      'NOTIFICATION_RECEIPT_MISSING',
      'Expected notification recipients do not all have sent delivery receipts',
      { eventId: item.notification.eventId, missingRecipientIds },
    );
  }

  let remoteTask;
  try {
    remoteTask = await remoteReader.getTask({ taskGuid: item.taskGuid });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_TASK_READ_ERROR',
      'Feishu Task could not be read',
      { error: String(error?.message ?? error ?? 'unknown remote Task read error').slice(0, 4_000) },
    );
  }
  if (remoteTask?.kind === 'missing') {
    return failedCase(
      item,
      'REMOTE_TASK_MISSING',
      'Feishu Task is deleted or no longer exists',
      { taskGuid: item.taskGuid },
    );
  }
  if (remoteTask?.kind !== 'found') {
    return failedCase(
      item,
      'REMOTE_TASK_UNREADABLE',
      'Feishu Task Adapter reported a non-readable result',
      { kind: remoteTask?.kind ?? null },
    );
  }
  if (remoteTask.task?.guid !== item.taskGuid) {
    return failedCase(
      item,
      'REMOTE_TASK_GUID_MISMATCH',
      'Remote Task GUID differs from the requested managed Task',
      { expectedTaskGuid: item.taskGuid, observedTaskGuid: remoteTask.task?.guid ?? null },
    );
  }
  if (remoteTask.task?.coreTaskId !== link.taskId) {
    return failedCase(
      item,
      'REMOTE_TASK_CORE_MISMATCH',
      'Remote Task marker differs from the linked Core Task',
      {
        expectedCoreTaskId: link.taskId,
        observedCoreTaskId: remoteTask.task?.coreTaskId ?? null,
      },
    );
  }
  if (remoteTask.task?.summary !== link.title) {
    return failedCase(
      item,
      'REMOTE_TASK_TITLE_MISMATCH',
      'Remote Task title differs from the linked Core Task title',
      { expectedTitle: link.title, observedTitle: remoteTask.task?.summary ?? null },
    );
  }
  let candidates;
  try {
    candidates = await remoteReader.findTasksBySummary({ summary: link.title });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_TASK_SEARCH_ERROR',
      'Feishu Tasks could not be searched for title collisions',
      { error: String(error?.message ?? error ?? 'unknown remote Task search error').slice(0, 4_000) },
    );
  }
  if (
    !Array.isArray(candidates)
    || candidates.length !== 1
    || candidates[0]?.guid !== item.taskGuid
  ) {
    return failedCase(
      item,
      'REMOTE_TASK_TITLE_COLLISION',
      'Remote Task title does not uniquely identify the requested GUID',
      {
        title: link.title,
        observedTaskGuids: Array.isArray(candidates)
          ? candidates.map(candidate => candidate?.guid ?? null)
          : [],
      },
    );
  }
  let remoteInbound;
  try {
    remoteInbound = await remoteReader.getComment({
      taskGuid: item.taskGuid,
      commentId: item.commentId,
    });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_COMMENT_READ_ERROR',
      'Inbound Feishu comment could not be read',
      { error: String(error?.message ?? error ?? 'unknown remote comment read error').slice(0, 4_000) },
    );
  }
  if (remoteInbound?.kind === 'missing') {
    return failedCase(
      item,
      'REMOTE_COMMENT_MISSING',
      'Inbound Feishu comment is deleted or no longer exists',
      { commentId: item.commentId },
    );
  }
  if (
    remoteInbound?.kind !== 'found'
    || remoteInbound.comment?.resourceType !== 'task'
    || remoteInbound.comment?.resourceId !== item.taskGuid
  ) {
    return failedCase(
      item,
      'REMOTE_COMMENT_TASK_MISMATCH',
      'Inbound Feishu comment belongs to a different resource or Task GUID',
      {
        expectedTaskGuid: item.taskGuid,
        observedTaskGuid: remoteInbound?.comment?.resourceId ?? null,
        observedResourceType: remoteInbound?.comment?.resourceType ?? null,
      },
    );
  }
  let remoteOutbound;
  try {
    remoteOutbound = await remoteReader.getComment({
      taskGuid: item.taskGuid,
      commentId: outbound.commentId,
    });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_REPLY_READ_ERROR',
      'Agent Feishu reply could not be read',
      { error: String(error?.message ?? error ?? 'unknown remote reply read error').slice(0, 4_000) },
    );
  }
  if (remoteOutbound?.kind === 'missing') {
    return failedCase(
      item,
      'REMOTE_REPLY_MISSING',
      'Agent Feishu reply is deleted or no longer exists',
      { commentId: outbound.commentId },
    );
  }
  if (
    remoteOutbound?.kind !== 'found'
    || remoteOutbound.comment?.resourceType !== 'task'
    || remoteOutbound.comment?.resourceId !== item.taskGuid
  ) {
    return failedCase(
      item,
      'REMOTE_REPLY_TASK_MISMATCH',
      'Agent Feishu reply belongs to a different resource or Task GUID',
      {
        expectedTaskGuid: item.taskGuid,
        observedTaskGuid: remoteOutbound?.comment?.resourceId ?? null,
        observedResourceType: remoteOutbound?.comment?.resourceType ?? null,
      },
    );
  }
  if (remoteOutbound.comment?.replyToCommentId !== item.commentId) {
    return failedCase(
      item,
      'REMOTE_REPLY_PARENT_MISMATCH',
      'Agent Feishu reply does not target the exact inbound comment',
      {
        expectedReplyToCommentId: item.commentId,
        observedReplyToCommentId: remoteOutbound.comment?.replyToCommentId ?? null,
      },
    );
  }

  return Object.freeze({
    taskGuid: item.taskGuid,
    commentId: item.commentId,
    coreTaskId: link.taskId,
    passed: true,
    failures: Object.freeze([]),
    inbound: Object.freeze({
      eventId: inbound.eventId,
      source: inbound.source,
      status: inbound.status,
      latencyMs,
      receivedAt: inbound.receivedAt,
    }),
    outbound: Object.freeze({
      idempotencyKey: outbound.idempotencyKey,
      replyToCommentId: outbound.replyToCommentId,
      status: outbound.status,
      commentId: outbound.commentId,
    }),
    notifications: Object.freeze({
      eventId: item.notification.eventId,
      recipients: Object.freeze([...item.notification.recipientIds]),
      receipts: Object.freeze(notificationRows
        .filter(row => row.status === 'sent' && row.sentAt)
        .map(row => Object.freeze({
          dedupeKey: row.dedupeKey,
          recipientId: row.recipientId,
          status: row.status,
          sentAt: row.sentAt,
        }))
        .sort((left, right) => (
          left.recipientId.localeCompare(right.recipientId)
          || left.dedupeKey.localeCompare(right.dedupeKey)
        ))),
    }),
  });
}

/**
 * Read-only acceptance gate for one or more managed Feishu Task comment closures.
 * SQLite ledgers are opened read-only and all remote reads cross the injected Adapter seam.
 */
export async function evaluateNativeTaskClosure({
  coreDbPath,
  taskCommentsDbPath,
  appId,
  cases,
  remoteReader,
  clock = () => new Date().toISOString(),
  maxInboundLatencyMs = 5_000,
} = {}) {
  const normalizedAppId = requireText(appId, 'native Task closure appId');
  const normalizedCases = normalizeCases(cases);
  const remote = requireRecord(remoteReader, 'native Task closure remoteReader');
  for (const operation of ['getTask', 'findTasksBySummary', 'getComment']) {
    requireFunction(remote[operation], `native Task closure remoteReader.${operation}`);
  }
  const checkedAt = canonicalInstant(clock(), 'native Task closure clock result');
  const latencyLimit = requireLatency(maxInboundLatencyMs);
  const coreDb = openReadonly(coreDbPath, 'native Task closure coreDbPath');
  const commentsDb = openReadonly(
    taskCommentsDbPath,
    'native Task closure taskCommentsDbPath',
  );
  try {
    const caseReports = [];
    for (const item of normalizedCases) {
      try {
        caseReports.push(await evaluateCase({
          coreDb,
          commentsDb,
          appId: normalizedAppId,
          item,
          remoteReader: remote,
          maxInboundLatencyMs: latencyLimit,
        }));
      } catch (error) {
        caseReports.push(failedCase(
          item,
          'GATE_CASE_READ_ERROR',
          'Closure case could not be evaluated from its read-only dependencies',
          { error: String(error?.message ?? error ?? 'unknown gate case read error').slice(0, 4_000) },
        ));
      }
    }
    const passed = caseReports.filter(item => item.passed).length;
    const failureCodes = [...new Set(caseReports.flatMap(item => (
      item.failures.map(({ code }) => code)
    )))].sort();
    return Object.freeze({
      schema: REPORT_SCHEMA,
      checkedAt,
      passed: passed === caseReports.length,
      failureCodes: Object.freeze(failureCodes),
      totals: Object.freeze({
        cases: caseReports.length,
        passed,
        failed: caseReports.length - passed,
      }),
      cases: Object.freeze(caseReports),
    });
  } finally {
    commentsDb.close();
    coreDb.close();
  }
}

export const NATIVE_TASK_CLOSURE_GATE_SCHEMA = REPORT_SCHEMA;
