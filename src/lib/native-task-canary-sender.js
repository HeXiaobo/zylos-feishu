import os from 'node:os';

const RECEIPT_SCHEMA = 'zylos.native-task-comment-sender/v1';
const MAX_ID_LENGTH = 512;
const MAX_HOSTNAME_LENGTH = 255;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function requireText(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} is too long`);
  }
  return value;
}

function requireBoolean(value, field) {
  if (value !== true) throw new TypeError(`${field} must be true`);
  return value;
}

function canonicalInstant(value, field) {
  const parsed = new Date(requireText(value, field, 64));
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} must be an instant`);
  return parsed.toISOString();
}

function exactKeys(value, allowed, field) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new TypeError(`${field} contains unsupported field: ${unknown}`);
}

function normalizeResponseBinding(value, { appId, taskGuid, commentId = null } = {}) {
  const response = requireRecord(value, 'native Task comment sender response');
  exactKeys(response, ['appId', 'taskGuid', 'commentId'], 'native Task comment sender response');
  const binding = Object.freeze({
    appId: requireText(response.appId, 'native Task comment sender response.appId'),
    taskGuid: requireText(response.taskGuid, 'native Task comment sender response.taskGuid'),
    commentId: requireText(response.commentId, 'native Task comment sender response.commentId'),
  });
  if (binding.appId !== appId) {
    throw new TypeError('native Task comment sender response appId does not match the configured App');
  }
  if (binding.taskGuid !== taskGuid) {
    throw new TypeError('native Task comment sender response taskGuid does not match the requested Task');
  }
  if (commentId !== null && binding.commentId !== commentId) {
    throw new TypeError('native Task comment sender response commentId does not match the requested comment');
  }
  return binding;
}

function normalizeSenderResponse(value, { commentId } = {}) {
  const response = requireRecord(value, 'native Task comment sender response');
  exactKeys(response, ['ok', 'identity', 'data'], 'native Task comment sender response');
  requireBoolean(response.ok, 'native Task comment sender response.ok');
  if (response.identity !== 'user') {
    throw new TypeError('native Task comment sender response.identity must be user');
  }
  const data = requireRecord(response.data, 'native Task comment sender response.data');
  exactKeys(data, ['id'], 'native Task comment sender response.data');
  const id = requireText(data.id, 'native Task comment sender response.data.id');
  if (commentId !== undefined && id !== commentId) {
    throw new TypeError('native Task comment sender response.data.id does not match the returned comment');
  }
  return Object.freeze({
    ok: true,
    identity: 'user',
    data: Object.freeze({ id }),
  });
}

function normalizeDryRunEvidence(value, { appId, taskGuid } = {}) {
  const evidence = requireRecord(value, 'native Task comment sender dry-run evidence');
  exactKeys(
    evidence,
    ['ok', 'identity', 'context', 'request'],
    'native Task comment sender dry-run evidence',
  );
  requireBoolean(evidence.ok, 'native Task comment sender dry-run evidence.ok');
  if (evidence.identity !== 'user') {
    throw new TypeError('native Task comment sender dry-run evidence.identity must be user');
  }
  const context = requireRecord(
    evidence.context,
    'native Task comment sender dry-run evidence.context',
  );
  exactKeys(context, ['appId', 'userOpenId'], 'native Task comment sender dry-run evidence.context');
  const contextAppId = requireText(
    context.appId,
    'native Task comment sender dry-run evidence.context.appId',
  );
  const userOpenId = requireText(
    context.userOpenId,
    'native Task comment sender dry-run evidence.context.userOpenId',
  );
  const request = requireRecord(
    evidence.request,
    'native Task comment sender dry-run evidence.request',
  );
  exactKeys(
    request,
    ['method', 'url', 'resourceType', 'taskGuid'],
    'native Task comment sender dry-run evidence.request',
  );
  if (request.method !== 'POST' || request.url !== '/open-apis/task/v2/comments') {
    throw new TypeError('native Task comment sender dry-run request is not Task v2 comment create');
  }
  if (request.resourceType !== 'task') {
    throw new TypeError('native Task comment sender dry-run request resourceType must be task');
  }
  const requestedTaskGuid = requireText(
    request.taskGuid,
    'native Task comment sender dry-run evidence.request.taskGuid',
  );
  if (contextAppId !== appId) {
    throw new TypeError('native Task comment sender dry-run context appId does not match the configured App');
  }
  if (requestedTaskGuid !== taskGuid) {
    throw new TypeError('native Task comment sender dry-run request taskGuid does not match the requested Task');
  }
  return Object.freeze({
    ok: true,
    identity: 'user',
    context: Object.freeze({ appId: contextAppId, userOpenId }),
    request: Object.freeze({
      method: 'POST',
      url: '/open-apis/task/v2/comments',
      resourceType: 'task',
      taskGuid: requestedTaskGuid,
    }),
  });
}

/**
 * Validate a sender receipt before it is used by the native Task closure gate.
 * The receipt is deliberately bound to the exact App, Task, and returned
 * comment. Timestamps are accepted only in the operator sender receipt shape;
 * callers cannot add a free timing field directly to a gate case. The receipt
 * is operator evidence, so the gate also binds its hostname and exact IDs.
 */
export function normalizeNativeTaskCanarySenderReceipt(
  value,
  { appId, taskGuid, commentId, currentHostname = os.hostname() } = {},
) {
  const receipt = requireRecord(value, 'native Task comment sender receipt');
  exactKeys(
    receipt,
    [
      'schema', 'hostname', 'appId', 'taskGuid', 'commentId',
      'requestStartedAt', 'requestFinishedAt', 'dryRun', 'response', 'responseBinding',
    ],
    'native Task comment sender receipt',
  );
  if (receipt.schema !== RECEIPT_SCHEMA) {
    throw new TypeError(`native Task comment sender receipt.schema must be ${RECEIPT_SCHEMA}`);
  }
  const hostname = requireText(receipt.hostname, 'native Task comment sender receipt.hostname', MAX_HOSTNAME_LENGTH);
  if (hostname !== currentHostname) {
    throw new TypeError('native Task comment sender receipt.hostname does not match the gate host');
  }
  const normalized = {
    schema: RECEIPT_SCHEMA,
    hostname,
    appId: requireText(receipt.appId, 'native Task comment sender receipt.appId'),
    taskGuid: requireText(receipt.taskGuid, 'native Task comment sender receipt.taskGuid'),
    commentId: requireText(receipt.commentId, 'native Task comment sender receipt.commentId'),
    requestStartedAt: canonicalInstant(
      receipt.requestStartedAt,
      'native Task comment sender receipt.requestStartedAt',
    ),
    requestFinishedAt: canonicalInstant(
      receipt.requestFinishedAt,
      'native Task comment sender receipt.requestFinishedAt',
    ),
    dryRun: normalizeDryRunEvidence(receipt.dryRun, {
      appId: receipt.appId,
      taskGuid: receipt.taskGuid,
    }),
    response: normalizeSenderResponse(receipt.response, {
      commentId: receipt.commentId,
    }),
    responseBinding: normalizeResponseBinding(receipt.responseBinding, {
      appId: receipt.appId,
      taskGuid: receipt.taskGuid,
      commentId: receipt.commentId,
    }),
  };
  if (normalized.appId !== appId) {
    throw new TypeError('native Task comment sender receipt appId does not match the gate App');
  }
  if (normalized.taskGuid !== taskGuid) {
    throw new TypeError('native Task comment sender receipt taskGuid does not match the gate Task');
  }
  if (normalized.commentId !== commentId) {
    throw new TypeError('native Task comment sender receipt commentId does not match the gate comment');
  }
  if (normalized.dryRun.context.appId !== normalized.appId) {
    throw new TypeError('native Task comment sender dry-run context appId does not match the receipt App');
  }
  if (normalized.dryRun.request.taskGuid !== normalized.taskGuid) {
    throw new TypeError('native Task comment sender dry-run request taskGuid does not match the receipt Task');
  }
  if (normalized.response.data.id !== normalized.commentId) {
    throw new TypeError('native Task comment sender response commentId does not match the receipt comment');
  }
  if (
    normalized.responseBinding.appId !== normalized.appId
    || normalized.responseBinding.taskGuid !== normalized.taskGuid
    || normalized.responseBinding.commentId !== normalized.commentId
  ) {
    throw new TypeError('native Task comment sender response binding does not match the receipt identity');
  }
  if (Date.parse(normalized.requestFinishedAt) < Date.parse(normalized.requestStartedAt)) {
    throw new TypeError('native Task comment sender receipt requestFinishedAt precedes requestStartedAt');
  }
  return Object.freeze({
    ...normalized,
    dryRun: Object.freeze(normalized.dryRun),
    response: Object.freeze(normalized.response),
    responseBinding: Object.freeze(normalized.responseBinding),
  });
}

/**
 * Wrap the supported canary comment sender. The local request timestamps are
 * captured inside this wrapper, immediately around the send operation. The
 * sender must return the successful CLI response envelope; the wrapper binds
 * its returned comment ID to the configured App and requested Task.
 */
export function createNativeTaskCanarySender({
  appId,
  sendComment,
  clock,
  hostname = os.hostname(),
  dryRun,
} = {}) {
  const normalizedAppId = requireText(appId, 'native Task comment sender appId');
  const send = requireFunction(sendComment, 'native Task comment sender sendComment');
  const now = clock === undefined ? () => new Date().toISOString() : requireFunction(clock, 'native Task comment sender clock');
  const normalizedHostname = requireText(hostname, 'native Task comment sender hostname', MAX_HOSTNAME_LENGTH);
  const normalizedDryRun = requireFunction(dryRun, 'native Task comment sender dryRun');
  return Object.freeze({
    async send({ taskGuid, content } = {}) {
      const normalizedTaskGuid = requireText(taskGuid, 'native Task comment sender taskGuid');
      const normalizedContent = requireText(content, 'native Task comment sender content', 20_000);
      const dryRunEvidence = normalizeDryRunEvidence(
        await normalizedDryRun({ taskGuid: normalizedTaskGuid, content: normalizedContent }),
        { appId: normalizedAppId, taskGuid: normalizedTaskGuid },
      );
      const requestStartedAt = canonicalInstant(now(), 'native Task comment sender request start');
      const response = await send({ taskGuid: normalizedTaskGuid, content: normalizedContent });
      const requestFinishedAt = canonicalInstant(now(), 'native Task comment sender request finish');
      const normalizedResponse = normalizeSenderResponse(response);
      const binding = {
        appId: normalizedAppId,
        taskGuid: normalizedTaskGuid,
        commentId: normalizedResponse.data.id,
      };
      return normalizeNativeTaskCanarySenderReceipt({
        schema: RECEIPT_SCHEMA,
        hostname: normalizedHostname,
        appId: normalizedAppId,
        taskGuid: normalizedTaskGuid,
        commentId: binding.commentId,
        requestStartedAt,
        requestFinishedAt,
        dryRun: dryRunEvidence,
        response: normalizedResponse,
        responseBinding: binding,
      }, {
        appId: normalizedAppId,
        taskGuid: normalizedTaskGuid,
        commentId: binding.commentId,
        currentHostname: normalizedHostname,
      });
    },
  });
}

export const NATIVE_TASK_CANARY_SENDER_SCHEMA = RECEIPT_SCHEMA;
