import { createHash } from 'node:crypto';

import { createTaskV2LegacyAdoption } from './task-v2-legacy-adoption.js';

export const TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_SCHEMA =
  'zylos.feishu-task-v2-legacy-adoption/v1';
export const TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_REPORT_SCHEMA =
  'zylos.feishu-task-v2-legacy-adoption-run/v1';

const MAX_ENTRIES = 100;
const MANIFEST_FIELDS = new Set(['schema', 'appId', 'entries']);
const ENTRY_FIELDS = new Set(['taskGuid', 'coreTaskId', 'coreTaskVersion']);

function bootstrapError(message, code = 'INVALID_MANIFEST', cause) {
  const error = new TypeError(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bootstrapError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw bootstrapError(`${field} must be a non-empty string`);
  }
  if (value.trim() !== value) {
    throw bootstrapError(`${field} must not contain surrounding whitespace`);
  }
  if (/\s/.test(value)) throw bootstrapError(`${field} must not contain whitespace`);
  if (value.length > 512) throw bootstrapError(`${field} exceeds 512 characters`);
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw bootstrapError(`unsupported ${field} field: ${unknown}`);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeManifestEntry(rawEntry, index) {
  const entry = requireRecord(rawEntry, `entries[${index}]`);
  rejectUnknownFields(entry, ENTRY_FIELDS, `entries[${index}]`);
  const coreTaskVersion = entry.coreTaskVersion ?? 1;
  if (!Number.isSafeInteger(coreTaskVersion) || coreTaskVersion < 0) {
    throw bootstrapError(`entries[${index}].coreTaskVersion must be a non-negative safe integer`);
  }
  return Object.freeze({
    taskGuid: requireText(entry.taskGuid, `entries[${index}].taskGuid`),
    coreTaskId: requireText(entry.coreTaskId, `entries[${index}].coreTaskId`),
    coreTaskVersion,
  });
}

/** Parse the exact remote-card manifest. No implicit task discovery is allowed. */
export function parseTaskV2LegacyAdoptionBootstrapManifest(rawManifest) {
  const manifest = requireRecord(rawManifest, 'manifest');
  rejectUnknownFields(manifest, MANIFEST_FIELDS, 'manifest');
  if (manifest.schema !== TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_SCHEMA) {
    throw bootstrapError(
      `manifest.schema must be ${TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_SCHEMA}`,
    );
  }
  const appId = requireText(manifest.appId, 'manifest.appId');
  if (!/^cli_[A-Za-z0-9_-]+$/.test(appId)) {
    throw bootstrapError('manifest.appId must be a Feishu app id');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw bootstrapError('manifest.entries must be a non-empty array');
  }
  if (manifest.entries.length > MAX_ENTRIES) {
    throw bootstrapError(`manifest.entries must contain at most ${MAX_ENTRIES} items`);
  }

  const seenTaskGuids = new Set();
  const seenCoreTaskIds = new Set();
  const entries = manifest.entries.map((value, index) => {
    const entry = normalizeManifestEntry(value, index);
    if (seenTaskGuids.has(entry.taskGuid)) {
      throw bootstrapError(`manifest contains duplicate taskGuid: ${entry.taskGuid}`);
    }
    if (seenCoreTaskIds.has(entry.coreTaskId)) {
      throw bootstrapError(`manifest contains duplicate coreTaskId: ${entry.coreTaskId}`);
    }
    seenTaskGuids.add(entry.taskGuid);
    seenCoreTaskIds.add(entry.coreTaskId);
    return entry;
  });
  return Object.freeze({
    schema: TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_SCHEMA,
    appId,
    entries: Object.freeze(entries),
  });
}

function safeError(error) {
  return {
    code: error?.code ?? 'BOOTSTRAP_FAILED',
    message: error?.message ?? String(error),
    ...(error?.hold === true ? { hold: true } : {}),
  };
}

function summarizeTask(task) {
  const value = requireRecord(task, 'remote Task');
  const description = value.description ?? null;
  const extra = value.extra ?? null;
  return Object.freeze({
    guid: value.guid,
    status: value.status,
    creator: clone(value.creator),
    members: clone(value.members),
    summarySha256: sha256Json(value.summary ?? null),
    dueSha256: sha256Json(value.due ?? null),
    descriptionSha256: sha256Json(description),
    descriptionBytes: Buffer.byteLength(description ?? '', 'utf8'),
    extraSha256: sha256Json(extra),
    extraBytes: Buffer.byteLength(extra ?? '', 'utf8'),
  });
}

function planItem(entry, first, second) {
  const firstFingerprint = sha256Json(first.before);
  const secondFingerprint = sha256Json(second.before);
  if (firstFingerprint !== secondFingerprint) {
    return {
      index: null,
      taskGuid: entry.taskGuid,
      coreTaskId: entry.coreTaskId,
      ok: false,
      status: 'failed',
      error: {
        code: 'REMOTE_SNAPSHOT_UNSTABLE',
        message: 'remote Task changed during the stable precheck',
        hold: true,
      },
      before: summarizeTask(first.before),
      secondRead: summarizeTask(second.before),
    };
  }
  return {
    index: null,
    taskGuid: entry.taskGuid,
    coreTaskId: entry.coreTaskId,
    ok: true,
    status: first.status,
    changedFields: [...first.changedFields],
    before: summarizeTask(first.before),
    secondRead: summarizeTask(second.before),
  };
}

function reportStatus(results) {
  const failed = results.some(item => !item.ok);
  return failed ? 'HOLD' : 'PASS';
}

function baseReport({ mode, manifest, results, writes, stopped = false } = {}) {
  const succeeded = results.filter(item => item.ok).length;
  return {
    schema: TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_REPORT_SCHEMA,
    mode,
    appId: manifest.appId,
    writes,
    status: reportStatus(results),
    stopped,
    total: manifest.entries.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

/**
 * Orchestrates one exact manifest. Plan performs two stable reads and never
 * calls patchTask. Commit first requires a clean plan, then invokes only the
 * existing adoption Module, serially, stopping at the first failure.
 */
export function createTaskV2LegacyAdoptionBootstrap({ adapter, appId } = {}) {
  if (!adapter || typeof adapter.getTask !== 'function' || typeof adapter.patchTask !== 'function') {
    throw new TypeError('adapter must provide getTask and patchTask functions');
  }
  const expectedAppId = requireText(appId, 'appId');
  const adoption = createTaskV2LegacyAdoption({ adapter, appId: expectedAppId });

  async function readPlan(entry) {
    const first = await adoption.inspectTaskMarker(entry);
    const second = await adoption.inspectTaskMarker(entry);
    return planItem(entry, first, second);
  }

  async function plan(rawManifest) {
    const manifest = parseTaskV2LegacyAdoptionBootstrapManifest(rawManifest);
    if (manifest.appId !== expectedAppId) {
      throw bootstrapError('manifest.appId does not match the configured adapter appId');
    }
    const results = [];
    for (const [index, entry] of manifest.entries.entries()) {
      try {
        const result = await readPlan(entry);
        result.index = index;
        results.push(result);
      } catch (error) {
        results.push({
          index,
          taskGuid: entry.taskGuid,
          coreTaskId: entry.coreTaskId,
          ok: false,
          status: 'failed',
          error: safeError(error),
        });
      }
    }
    return baseReport({
      mode: 'plan',
      manifest,
      results,
      writes: false,
      stopped: false,
    });
  }

  async function commit(rawManifest, { conservationGate } = {}) {
    const manifest = parseTaskV2LegacyAdoptionBootstrapManifest(rawManifest);
    if (manifest.appId !== expectedAppId) {
      throw bootstrapError('manifest.appId does not match the configured adapter appId');
    }
    const preflight = await plan(manifest);
    if (preflight.failed > 0) {
      return {
        ...preflight,
        mode: 'commit',
        writes: false,
        commitAttempted: false,
        plan: preflight,
      };
    }

    const results = [];
    let writes = false;
    let stopped = false;
    for (const [index, entry] of manifest.entries.entries()) {
      try {
        const adoptionResult = await adoption.adoptTaskMarker(entry);
        writes ||= adoptionResult.status === 'adopted';
        let after;
        try {
          after = await adapter.getTask(entry.taskGuid);
        } catch (error) {
          const readbackError = new Error('post-commit audit readback failed', { cause: error });
          readbackError.code = 'POST_COMMIT_AUDIT_READBACK_FAILED';
          readbackError.hold = true;
          throw readbackError;
        }
        const normalizedAfter = summarizeTask(after);
        results.push({
          index,
          taskGuid: entry.taskGuid,
          coreTaskId: entry.coreTaskId,
          ok: true,
          status: adoptionResult.status,
          changedFields: [...(adoptionResult.changedFields ?? [])],
          recovered: adoptionResult.recovered === true,
          after: normalizedAfter,
        });
      } catch (error) {
        results.push({
          index,
          taskGuid: entry.taskGuid,
          coreTaskId: entry.coreTaskId,
          ok: false,
          status: 'failed',
          error: safeError(error),
        });
        stopped = true;
        break;
      }
    }
    if (results.length < manifest.entries.length) {
      for (let index = results.length; index < manifest.entries.length; index += 1) {
        const entry = manifest.entries[index];
        results.push({
          index,
          taskGuid: entry.taskGuid,
          coreTaskId: entry.coreTaskId,
          ok: false,
          status: 'not_run',
          error: {
            code: 'STOPPED_AFTER_FAILURE',
            message: 'entry was not attempted after the first commit failure',
          },
        });
      }
    }

    const report = baseReport({
      mode: 'commit',
      manifest,
      results,
      writes,
      stopped,
    });
    report.commitAttempted = true;
    report.plan = preflight;

    if (!stopped && typeof conservationGate === 'function') {
      try {
        report.conservationGate = await conservationGate({ manifest, report });
        if (report.conservationGate?.passed !== true) report.status = 'HOLD';
      } catch (error) {
        report.conservationGate = { passed: false, error: safeError(error) };
        report.status = 'HOLD';
      }
    }
    return report;
  }

  return Object.freeze({ plan, commit });
}

export function createSdkTaskV2LegacyAdoptionAdapter({ client } = {}) {
  const sdk = requireRecord(client, 'Feishu SDK client');
  const taskApi = sdk.task?.v2?.task;
  if (typeof taskApi?.get !== 'function' || typeof taskApi?.patch !== 'function') {
    throw new TypeError('client.task.v2.task.get and patch are required');
  }

  function apiError(response, operation) {
    const error = new Error(response?.msg || `Feishu Task v2 ${operation} failed`);
    error.code = response?.code ?? 'FEISHU_API_ERROR';
    error.retryable = response?.code === 429 || response?.code >= 500;
    return error;
  }

  function normalizeResponse(response, operation) {
    if (response?.code !== 0) throw apiError(response, operation);
    const task = response?.data?.task;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`Feishu Task v2 ${operation} returned no task`);
    }
    const completedAt = task.completed_at ?? task.completedAt;
    const status = task.status ?? (
      completedAt === undefined ? undefined : String(completedAt) === '0' ? 'todo' : 'done'
    );
    if (status === undefined) throw new Error(`Feishu Task v2 ${operation} returned no status`);
    return {
      guid: task.guid,
      summary: task.summary ?? null,
      description: task.description ?? null,
      due: task.due ?? null,
      status,
      creator: task.creator,
      members: task.members ?? [],
      extra: task.extra ?? null,
    };
  }

  return Object.freeze({
    async getTask(taskGuid) {
      try {
        const response = await taskApi.get({
          path: { task_guid: requireText(taskGuid, 'taskGuid') },
          params: { user_id_type: 'open_id' },
        });
        return normalizeResponse(response, 'get');
      } catch (error) {
        if (error?.code || error?.retryable !== undefined) throw error;
        const wrapped = new Error(error?.message || 'Feishu Task v2 get failed', { cause: error });
        wrapped.code = 'FEISHU_GET_FAILED';
        wrapped.retryable = true;
        throw wrapped;
      }
    },
    async patchTask(request) {
      const taskGuid = requireText(request?.taskGuid, 'patch.taskGuid');
      if (!Array.isArray(request?.updateFields) || request.updateFields.length === 0) {
        throw new TypeError('patch.updateFields must be a non-empty array');
      }
      if (new Set(request.updateFields).size !== request.updateFields.length
        || request.updateFields.some(field => !['description', 'extra'].includes(field))) {
        throw new TypeError('patch.updateFields may contain only unique description and extra fields');
      }
      const task = {};
      if (request.updateFields.includes('description')) task.description = request.description;
      if (request.updateFields.includes('extra')) task.extra = request.extra;
      try {
        const response = await taskApi.patch({
          path: { task_guid: taskGuid },
          params: { user_id_type: 'open_id' },
          data: { task, update_fields: [...request.updateFields] },
        });
        if (response?.code !== 0) throw apiError(response, 'patch');
        return response?.data?.task ?? null;
      } catch (error) {
        if (error?.code || error?.retryable !== undefined) throw error;
        const wrapped = new Error(error?.message || 'Feishu Task v2 patch failed', { cause: error });
        wrapped.code = 'FEISHU_PATCH_FAILED';
        wrapped.retryable = true;
        throw wrapped;
      }
    },
  });
}
