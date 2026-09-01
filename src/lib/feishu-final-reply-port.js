import { createHash } from 'node:crypto';

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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
  return value;
}

function hasVisibleText(value) {
  return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '') !== '';
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeIntent(rawIntent) {
  const intent = requireRecord(rawIntent, 'ReplyIntent');
  requireExactFields(intent, [
    'schemaVersion',
    'type',
    'intentId',
    'requestId',
    'traceId',
    'cause',
    'route',
    'disposition',
    'payload',
    'contentHash',
    'idempotencyKey',
  ], 'ReplyIntent');
  if (intent.schemaVersion !== 1 || intent.type !== 'ReplyIntent') {
    throw new TypeError('ReplyIntent contract version is unsupported');
  }
  for (const field of ['intentId', 'requestId', 'traceId', 'contentHash', 'idempotencyKey']) {
    requireText(intent[field], `ReplyIntent.${field}`);
  }
  if (intent.idempotencyKey !== intent.intentId) {
    throw domainError('IDENTITY_CONFLICT', 'ReplyIntent idempotencyKey must equal intentId');
  }
  const route = requireRecord(intent.route, 'ReplyIntent.route');
  requireExactFields(route, ['adapterId', 'targetRef'], 'ReplyIntent.route');
  if (route.adapterId !== 'feishu') {
    throw domainError('IDENTITY_CONFLICT', 'ReplyIntent belongs to a different adapter');
  }
  requireText(route.targetRef, 'ReplyIntent.route.targetRef');
  const cause = requireRecord(intent.cause, 'ReplyIntent.cause');
  requireExactFields(cause, ['kind', 'eventId'], 'ReplyIntent.cause');
  if (!['run_terminal', 'task_effect'].includes(cause.kind)) {
    throw new TypeError('ReplyIntent.cause.kind is unsupported');
  }
  requireText(cause.eventId, 'ReplyIntent.cause.eventId');
  if (!['send', 'failure_notice', 'task_receipt'].includes(intent.disposition)) {
    throw new TypeError('ReplyIntent.disposition is unsupported');
  }
  if (intent.disposition === 'task_receipt' && cause.kind !== 'task_effect') {
    throw domainError('IDENTITY_CONFLICT', 'task_receipt requires a task_effect cause');
  }
  if (intent.disposition !== 'task_receipt' && cause.kind !== 'run_terminal') {
    throw domainError('IDENTITY_CONFLICT', 'run reply requires a run_terminal cause');
  }
  const payload = requireRecord(intent.payload, 'ReplyIntent.payload');
  requireExactFields(payload, ['format', 'text'], 'ReplyIntent.payload');
  if (payload.format !== 'text' || typeof payload.text !== 'string') {
    throw new TypeError('ReplyIntent.payload must contain text');
  }
  if (!hasVisibleText(payload.text)) {
    throw domainError('MISSING_OUTPUT', 'visible ReplyIntent output is blank');
  }
  if (intent.contentHash !== sha256(canonicalJson(payload))) {
    throw domainError('IDENTITY_CONFLICT', 'ReplyIntent contentHash does not match payload');
  }
  return intent;
}

function normalizeClaim(rawClaim) {
  const claim = requireRecord(rawClaim, 'delivery claim');
  requireExactFields(claim, [
    'replayed',
    'action',
    'intent',
    'deliveryId',
    'attemptId',
    'claimEpoch',
    'leaseOwner',
    'leaseToken',
    'leaseExpiresAt',
  ], 'delivery claim');
  if (!['send', 'reconcile'].includes(claim.action)) {
    throw new TypeError('delivery claim action is unsupported');
  }
  const intent = normalizeIntent(claim.intent);
  requireText(claim.deliveryId, 'delivery claim deliveryId');
  requireText(claim.attemptId, 'delivery claim attemptId');
  requireText(claim.leaseOwner, 'delivery claim leaseOwner');
  requireText(claim.leaseToken, 'delivery claim leaseToken');
  if (typeof claim.replayed !== 'boolean') {
    throw new TypeError('delivery claim replayed must be a boolean');
  }
  for (const field of ['claimEpoch', 'leaseExpiresAt']) {
    if (!Number.isSafeInteger(claim[field]) || claim[field] < 1) {
      throw new TypeError(`delivery claim ${field} must be a positive safe integer`);
    }
  }
  if (claim.deliveryId !== `delivery:${intent.intentId}`) {
    throw domainError('IDENTITY_CONFLICT', 'deliveryId does not match ReplyIntent');
  }
  return { ...claim, intent };
}

function normalizeSilentOutcome(rawOutcome) {
  const outcome = requireRecord(rawOutcome, 'ReplyOutcome');
  requireExactFields(outcome, [
    'schemaVersion',
    'type',
    'outcomeId',
    'requestId',
    'turnId',
    'traceId',
    'kind',
    'explicit',
    'reason',
  ], 'ReplyOutcome');
  if (
    outcome.schemaVersion !== 1
    || outcome.type !== 'ReplyOutcome'
    || outcome.kind !== 'silent'
    || outcome.explicit !== true
  ) {
    throw new TypeError('only an explicit silent ReplyOutcome can suppress delivery');
  }
  for (const field of ['outcomeId', 'requestId', 'turnId', 'traceId', 'reason']) {
    requireText(outcome[field], `ReplyOutcome.${field}`);
  }
  return outcome;
}

function normalizeSettlement(rawSettlement) {
  const settlement = requireRecord(rawSettlement, 'DeliverySettlement');
  requireExactFields(settlement, [
    'schemaVersion',
    'type',
    'settlementId',
    'intentId',
    'deliveryId',
    'requestId',
    'traceId',
    'adapterId',
    'state',
    'basis',
    'presented',
  ], 'DeliverySettlement');
  if (settlement.schemaVersion !== 1 || settlement.type !== 'DeliverySettlement') {
    throw new TypeError('DeliverySettlement contract version is unsupported');
  }
  for (const field of [
    'settlementId',
    'intentId',
    'deliveryId',
    'requestId',
    'traceId',
    'adapterId',
  ]) {
    requireText(settlement[field], `DeliverySettlement.${field}`);
  }
  if (settlement.adapterId !== 'feishu') {
    throw domainError('IDENTITY_CONFLICT', 'DeliverySettlement belongs to a different adapter');
  }
  if (settlement.deliveryId !== `delivery:${settlement.intentId}`) {
    throw domainError('IDENTITY_CONFLICT', 'DeliverySettlement deliveryId does not match intentId');
  }
  const accepted = settlement.state === 'accepted'
    && settlement.presented === true
    && ['platform_accepted', 'reconciled'].includes(settlement.basis);
  const unpresentable = settlement.state === 'unpresentable'
    && settlement.presented === false
    && settlement.basis === 'retry_exhausted';
  if (!accepted && !unpresentable) {
    throw domainError(
      'UNAUTHORIZED_PRESENCE_SETTLEMENT',
      'DeliverySettlement cannot finish Reply Presence',
    );
  }
  return settlement;
}

function requirePort(port, methods, field) {
  const value = requireRecord(port, field);
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`${field}.${method} must be a function`);
    }
  }
  return value;
}

function normalizeDeliveryResult(rawResult, action) {
  const result = requireRecord(rawResult, 'Feishu delivery result');
  if (!['platform_accepted', 'unknown', 'reconciled', 'rejected'].includes(result.outcome)) {
    throw new TypeError('Feishu delivery result outcome is unsupported');
  }
  if (action === 'send' && result.outcome === 'reconciled') {
    throw domainError('INVALID_DELIVERY_TRANSITION', 'send cannot report reconciled');
  }
  if (action === 'reconcile' && ['platform_accepted', 'unknown'].includes(result.outcome)) {
    throw domainError(
      'INVALID_DELIVERY_TRANSITION',
      'reconcile must report reconciled or rejected',
    );
  }
  if (['platform_accepted', 'reconciled'].includes(result.outcome)) {
    requireText(result.externalRef, 'Feishu delivery result externalRef');
  } else if (result.externalRef !== null) {
    throw new TypeError('unknown or rejected delivery result externalRef must be null');
  }
  if (result.outcome === 'rejected') {
    requireText(result.errorCode, 'Feishu delivery result errorCode');
    if (typeof result.retryable !== 'boolean') {
      throw new TypeError('Feishu delivery result retryable must be a boolean');
    }
  }
  return result;
}

function createReceipt(claim, result, observedAt) {
  const receipt = {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: `receipt:${claim.attemptId}:${result.outcome}`,
    intentId: claim.intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: claim.intent.requestId,
    attemptId: claim.attemptId,
    traceId: claim.intent.traceId,
    adapterId: 'feishu',
    outcome: result.outcome,
    externalRef: result.externalRef,
    observedAt,
  };
  if (result.outcome === 'unknown') receipt.nextAction = 'reconcile_before_retry';
  if (result.outcome === 'rejected') {
    receipt.errorCode = result.errorCode;
    receipt.retryable = result.retryable;
  }
  return receipt;
}

export function createFeishuFinalReplyPort({
  delivery,
  presentation,
  clock = Date.now,
} = {}) {
  const deliveryPort = requirePort(delivery, ['send', 'reconcile'], 'delivery');
  const presentationPort = requirePort(presentation, ['settlePresence'], 'presentation');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const receiptCache = new Map();

  return Object.freeze({
    async deliver(rawClaim) {
      const claim = normalizeClaim(rawClaim);
      const claimKey = canonicalJson([
        claim.action,
        claim.intent.intentId,
        claim.deliveryId,
        claim.attemptId,
        claim.claimEpoch,
        claim.leaseToken,
      ]);
      const claimFingerprint = sha256(canonicalJson({
        action: claim.action,
        intent: claim.intent,
        deliveryId: claim.deliveryId,
        attemptId: claim.attemptId,
        claimEpoch: claim.claimEpoch,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: claim.leaseExpiresAt,
      }));
      const cached = receiptCache.get(claimKey);
      if (cached) {
        if (cached.claimFingerprint !== claimFingerprint) {
          throw domainError('IDENTITY_CONFLICT', 'delivery claim replay changed its identity');
        }
        return cached.deliveryTask;
      }
      const deliveryTask = (async () => {
        const result = normalizeDeliveryResult(
          await deliveryPort[claim.action](claim),
          claim.action,
        );
        return Object.freeze(
          createReceipt(claim, result, new Date(clock()).toISOString()),
        );
      })();
      receiptCache.set(claimKey, { claimFingerprint, deliveryTask });
      try {
        return await deliveryTask;
      } catch (error) {
        if (receiptCache.get(claimKey)?.deliveryTask === deliveryTask) {
          receiptCache.delete(claimKey);
        }
        throw error;
      }
    },
    settle(settlement) {
      const signal = normalizeSettlement(settlement);
      return presentationPort.settlePresence({ requestId: signal.requestId, signal });
    },
    suppress(rawOutcome) {
      const outcome = normalizeSilentOutcome(rawOutcome);
      return presentationPort.settlePresence({ requestId: outcome.requestId, signal: outcome });
    },
  });
}
