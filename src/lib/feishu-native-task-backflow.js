import { createHash } from 'node:crypto';

import { parseCanonicalSha256 } from './canonical-sha256.js';

const INPUT_FIELDS = new Set([
  'eventId',
  'appId',
  'tenantRef',
  'accountRef',
  'externalTaskId',
  'actorId',
  'action',
  'externalVersion',
  'effectId',
  'payloadHash',
  'reminderMinutesBeforeDue',
]);
const IDENTITY_FIELDS = new Set(['appId', 'tenantRef', 'accountRef']);
const ACTIONS = Object.freeze({
  start: Object.freeze({ command: 'StartTask', capability: 'task.start' }),
  completed: Object.freeze({
    command: 'SubmitForReview',
    capability: 'task.submit_for_review',
  }),
  submit_for_review: Object.freeze({
    command: 'SubmitForReview',
    capability: 'task.submit_for_review',
  }),
  reject: Object.freeze({ command: 'RequestChanges', capability: 'task.request_changes' }),
  accept: Object.freeze({ command: 'AcceptTask', capability: 'task.accept' }),
  update_reminder: Object.freeze({ command: 'UpdateTaskReminder', capability: 'task.update' }),
});

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new TypeError(`unsupported ${field} field: ${unknown}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function stableId(prefix, value) {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function normalizeIdentity(value) {
  const identity = requireRecord(value, 'native task identity');
  rejectUnknownFields(identity, IDENTITY_FIELDS, 'native task identity');
  return {
    appId: requireText(identity.appId, 'identity.appId'),
    tenantRef: requireText(identity.tenantRef, 'identity.tenantRef'),
    accountRef: requireText(identity.accountRef, 'identity.accountRef'),
  };
}

function normalizeInput(value) {
  const input = requireRecord(value, 'native task event');
  rejectUnknownFields(input, INPUT_FIELDS, 'native task event');
  const normalized = {
    eventId: requireText(input.eventId, 'native task event.eventId'),
    appId: requireText(input.appId, 'native task event.appId'),
    tenantRef: requireText(input.tenantRef, 'native task event.tenantRef'),
    accountRef: requireText(input.accountRef, 'native task event.accountRef'),
    externalTaskId: requireText(input.externalTaskId, 'native task event.externalTaskId'),
    actorId: requireText(input.actorId, 'native task event.actorId'),
    action: requireText(input.action, 'native task event.action'),
    externalVersion: requireVersion(input.externalVersion, 'native task event.externalVersion'),
    effectId: requireText(input.effectId, 'native task event.effectId'),
    payloadHash: parseCanonicalSha256(
      input.payloadHash,
      'native task event.payloadHash',
    ),
  };
  if (input.reminderMinutesBeforeDue !== undefined) {
    if (!Number.isSafeInteger(input.reminderMinutesBeforeDue)
        || input.reminderMinutesBeforeDue < 0) {
      throw new TypeError('native task event.reminderMinutesBeforeDue must be non-negative');
    }
    normalized.reminderMinutesBeforeDue = input.reminderMinutesBeforeDue;
  }
  return normalized;
}

function reject(code) {
  return Object.freeze({ status: 'rejected', code, repair: 'reproject' });
}

function exactProjectionMatches(projection, payload) {
  return projection?.tenantRef === payload.tenantRef
    && projection?.accountRef === payload.accountRef
    && projection?.externalTaskId === payload.externalTaskId
    && projection?.effectId === payload.effectId
    && projection?.payloadHash === payload.payloadHash;
}

/**
 * Writable Native Task adapter. Transport callbacks only enqueue normalized,
 * body-free facts. The durable inbox invokes handle later, where tenant,
 * account, actor, projection identity and Core version are checked before the
 * one TaskCommandPort is called.
 */
export function createFeishuNativeTaskBackflow({
  inbox,
  identity: rawIdentity,
  resolveProjection,
  verifyActor,
  taskCommandPort,
} = {}) {
  if (!inbox || typeof inbox.enqueue !== 'function') {
    throw new TypeError('inbox.enqueue must be a function');
  }
  if (typeof resolveProjection !== 'function') {
    throw new TypeError('resolveProjection must be a function');
  }
  if (typeof verifyActor !== 'function') throw new TypeError('verifyActor must be a function');
  if (!taskCommandPort || typeof taskCommandPort.submit !== 'function') {
    throw new TypeError('taskCommandPort.submit must be a function');
  }
  const identity = normalizeIdentity(rawIdentity);

  return Object.freeze({
    ingest(input) {
      const event = normalizeInput(input);
      const logicalKey = [
        event.accountRef,
        event.externalTaskId,
        event.action,
        `v${event.externalVersion}`,
      ].join(':');
      const payload = Object.freeze({
        appId: event.appId,
        tenantRef: event.tenantRef,
        accountRef: event.accountRef,
        externalTaskId: event.externalTaskId,
        actorId: event.actorId,
        action: event.action,
        externalVersion: event.externalVersion,
        effectId: event.effectId,
        payloadHash: event.payloadHash,
        ...(event.reminderMinutesBeforeDue === undefined
          ? {}
          : { reminderMinutesBeforeDue: event.reminderMinutesBeforeDue }),
      });
      const queued = inbox.enqueue({
        event_id: event.eventId,
        task_id: event.externalTaskId,
        app_id: event.appId,
        event_types: [event.action],
        logical_key: logicalKey,
        payload_hash: fingerprint(payload),
        payload,
      });
      return Object.freeze({
        status: 'queued',
        created: queued.created,
        eventId: queued.event.event_id,
        externalTaskId: queued.event.task_id,
      });
    },

    async handle(eventInput) {
      const event = requireRecord(eventInput, 'durable native task event');
      const payload = requireRecord(event.payload, 'durable native task payload');
      if (event.app_id !== identity.appId
          || payload.appId !== identity.appId
          || payload.tenantRef !== identity.tenantRef
          || payload.accountRef !== identity.accountRef) {
        return reject('IDENTITY_MISMATCH');
      }
      const mapping = ACTIONS[payload.action];
      if (!mapping) return reject('UNSUPPORTED_CHANGE');
      const projection = await resolveProjection(payload.externalTaskId);
      if (!exactProjectionMatches(projection, payload)) {
        return reject('PROJECTION_IDENTITY_DRIFT');
      }
      if (projection.coreVersion !== payload.externalVersion) {
        return reject('VERSION_DRIFT');
      }
      const verified = await verifyActor({
        appId: payload.appId,
        tenantRef: payload.tenantRef,
        accountRef: payload.accountRef,
        actorId: payload.actorId,
      });
      const actor = verified?.actor;
      const actorAssertion = verified?.assertion;
      if (!actor
          || actor.provider !== 'feishu'
          || actor.tenantRef !== identity.tenantRef
          || actor.externalId !== payload.actorId
          || actor.provenance !== 'verified_channel_actor'
          || !actorAssertion
          || (typeof actorAssertion !== 'object' && typeof actorAssertion !== 'function')) {
        return reject('UNAUTHORIZED_ACTOR');
      }
      const logicalKey = requireText(event.logical_key, 'durable native task logical_key');
      const requestId = stableId('req:native-task', logicalKey);
      const intent = {
        taskId: requireText(projection.taskId, 'projection.taskId'),
        command: mapping.command,
        expectedVersion: projection.coreVersion,
        ...(mapping.command === 'UpdateTaskReminder'
          ? { reminderMinutesBeforeDue: payload.reminderMinutesBeforeDue }
          : {}),
      };
      const result = await taskCommandPort.submit({
        requestId,
        turnId: `turn:${requestId}:1`,
        sourceKey: `feishu:${identity.accountRef}:native-task:${logicalKey}`,
        source: {
          adapterId: 'feishu',
          accountRef: identity.accountRef,
          eventType: 'task.user_change_v1',
          eventId: event.event_id,
          messageId: logicalKey,
        },
        actor,
        actorAssertion,
        origin: 'native_task_projection',
        originEffectId: projection.effectId,
        capability: mapping.capability,
        intent,
      });
      if (result?.accepted !== true) return reject(result?.code || 'CORE_REJECTED');
      if (result.suppressed === true) {
        return Object.freeze({
          status: 'suppressed',
          effectId: projection.effectId,
          taskId: projection.taskId,
          coreVersion: projection.coreVersion,
        });
      }
      return Object.freeze({
        status: 'applied',
        taskId: projection.taskId,
        coreVersion: result.task?.version ?? projection.coreVersion,
      });
    },
  });
}
