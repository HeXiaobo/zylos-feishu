import { createHash } from 'node:crypto';

import { createWorkIntakeConfirmationDelivery } from './work-intake-confirmation-delivery.js';
import { verifyTaskEffectSettlement } from './task-effect-settlement.js';

const ROUTE_FIELDS = new Set(['adapterId', 'targetRef']);

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function stableUuid(deliveryKey) {
  return `zwi_${createHash('sha256').update(deliveryKey).digest('hex').slice(0, 40)}`;
}

function normalizeRoute(value) {
  const route = requireRecord(value, 'task receipt route');
  const unknown = Object.keys(route).find(key => !ROUTE_FIELDS.has(key));
  if (unknown || Object.keys(route).length !== ROUTE_FIELDS.size) {
    throw new TypeError('task receipt route contains unsupported or missing fields');
  }
  if (route.adapterId !== 'feishu') {
    const error = new Error('task receipt route does not support this adapter');
    error.code = 'UNSUPPORTED_CAPABILITY';
    throw error;
  }
  return {
    adapterId: 'feishu',
    targetRef: requireText(route.targetRef, 'task receipt route.targetRef'),
  };
}

function normalizeEffect(value) {
  const effect = requireRecord(value, 'task receipt TaskEffect');
  if (effect.schemaVersion !== 1 || effect.type !== 'TaskEffect') {
    throw new TypeError('task receipt TaskEffect schema/type is unsupported');
  }
  const task = requireRecord(effect.task, 'task receipt TaskEffect.task');
  const normalized = {
    ...structuredClone(effect),
    effectId: requireText(effect.effectId, 'TaskEffect.effectId'),
    eventId: requireText(effect.eventId, 'TaskEffect.eventId'),
    requestId: requireText(effect.requestId, 'TaskEffect.requestId'),
    traceId: requireText(effect.traceId, 'TaskEffect.traceId'),
    taskId: requireText(effect.taskId, 'TaskEffect.taskId'),
  };
  if (!Number.isSafeInteger(effect.coreVersion) || effect.coreVersion < 1
      || task.id !== normalized.taskId || task.version !== effect.coreVersion) {
    throw new TypeError('task receipt TaskEffect task identity/version mismatch');
  }
  return normalized;
}

function normalizeSettlement(value, effect) {
  try {
    return verifyTaskEffectSettlement({ effect, settlement: value });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new TypeError(`verified TaskEffect settlement required: ${error.message}`);
    }
    throw error;
  }
}

function buildIntent(effect, route) {
  const routeHash = hash(route).slice(0, 32);
  const intentId = `reply:${effect.effectId}:${routeHash}`;
  const payload = {
    format: 'text',
    text: `任务「${requireText(effect.task.title, 'TaskEffect.task.title')}」已同步到飞书任务。`,
  };
  return Object.freeze({
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId,
    requestId: effect.requestId,
    traceId: effect.traceId,
    cause: Object.freeze({
      kind: 'task_effect',
      eventId: effect.eventId,
      effectId: effect.effectId,
    }),
    route: Object.freeze(route),
    disposition: 'task_receipt',
    payload: Object.freeze(payload),
    contentHash: `sha256:${hash(payload)}`,
    idempotencyKey: intentId,
  });
}

/**
 * Durable task-receipt delivery built on the existing WorkIntake file outbox.
 * It reuses stable delivery keys/UUIDs and restart retry while keeping the
 * receipt a ReplyIntent caused by TaskEffect settlement, never a Run terminal.
 */
export function createTaskReceiptDelivery({
  outboxPath,
  deliver,
  reconcile,
  resolveTarget,
  clock,
} = {}) {
  if (typeof deliver !== 'function') throw new TypeError('deliver must be a function');
  if (typeof reconcile !== 'function') throw new TypeError('reconcile must be a function');
  if (typeof resolveTarget !== 'function') throw new TypeError('resolveTarget must be a function');

  const durable = createWorkIntakeConfirmationDelivery({
    outboxPath,
    clock,
    async deliver(request) {
      const envelope = requireRecord(request.confirmation, 'persisted task receipt');
      const result = await deliver({
        deliveryKey: request.deliveryKey,
        deliveryUuid: request.deliveryUuid,
        target: request.target,
        intent: envelope.intent,
        settlement: envelope.settlement,
      });
      if (result?.success || result?.outcome === 'platform_accepted'
          || result?.outcome === 'reconciled') {
        return { success: true, messageId: result.messageId ?? result.externalId ?? null };
      }
      if (result?.outcome === 'unknown') {
        const observed = await reconcile(envelope.intent);
        if (observed?.outcome === 'platform_accepted' || observed?.outcome === 'reconciled') {
          return { success: true, messageId: observed.messageId ?? observed.externalId ?? null };
        }
        const error = new Error('task receipt delivery remains unconfirmed');
        error.code = 'DELIVERY_UNKNOWN';
        error.retryable = true;
        throw error;
      }
      const error = new Error('task receipt delivery rejected');
      error.code = typeof result?.code === 'string' ? result.code : 'DELIVERY_REJECTED';
      error.retryable = result?.retryable !== false;
      throw error;
    },
  });

  function prepare(input) {
    const request = requireRecord(input, 'task receipt request');
    const effect = normalizeEffect(request.effect);
    const settlement = normalizeSettlement(request.settlement, effect);
    const route = normalizeRoute(request.route);
    const intent = buildIntent(effect, route);
    const target = resolveTarget(route.targetRef);
    return Object.freeze({
      deliveryKey: intent.idempotencyKey,
      deliveryUuid: stableUuid(intent.idempotencyKey),
      target,
      confirmation: Object.freeze({ intent, settlement }),
    });
  }

  return Object.freeze({
    prepare,
    send(input) {
      return durable.send(prepare(input));
    },
    pending() {
      return durable.pending().map(request => Object.freeze({
        deliveryKey: request.deliveryKey,
        deliveryUuid: request.deliveryUuid,
        intent: request.confirmation.intent,
        settlement: request.confirmation.settlement,
      }));
    },
    retryPending() {
      return durable.retryPending();
    },
  });
}
