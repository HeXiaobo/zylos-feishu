function requirePort(port) {
  if (!port || typeof port !== 'object') throw new TypeError('reactionPort must be an object');
  for (const method of ['add', 'remove', 'reconcile']) {
    if (typeof port[method] !== 'function') {
      throw new TypeError(`reactionPort.${method} must be a function`);
    }
  }
  return port;
}

function requireEnvelope(signal, type) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    throw new TypeError(`${type} must be an object`);
  }
  if (signal.schemaVersion !== 1 || signal.type !== type) {
    throw new TypeError(`${type} contract version is unsupported`);
  }
  return signal;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeDeliverySettlement(signal) {
  const value = requireEnvelope(signal, 'DeliverySettlement');
  for (const field of [
    'settlementId',
    'intentId',
    'deliveryId',
    'requestId',
    'traceId',
    'adapterId',
  ]) {
    requireText(value[field], `DeliverySettlement.${field}`);
  }
  if (!['accepted', 'unpresentable'].includes(value.state)) {
    throw new TypeError('DeliverySettlement.state is unsupported');
  }
  if (!['platform_accepted', 'reconciled', 'retry_exhausted'].includes(value.basis)) {
    throw new TypeError('DeliverySettlement.basis is unsupported');
  }
  if (typeof value.presented !== 'boolean') {
    throw new TypeError('DeliverySettlement.presented must be a boolean');
  }
  return value;
}

function normalizeReplyOutcome(signal) {
  const value = requireEnvelope(signal, 'ReplyOutcome');
  for (const field of ['outcomeId', 'requestId', 'turnId', 'traceId']) {
    requireText(value[field], `ReplyOutcome.${field}`);
  }
  if (!['answer', 'silent', 'failure'].includes(value.kind)) {
    throw new TypeError('ReplyOutcome.kind is unsupported');
  }
  if (value.kind === 'answer') {
    if (
      !value.content
      || typeof value.content !== 'object'
      || Array.isArray(value.content)
      || value.content.format !== 'text'
      || typeof value.content.text !== 'string'
    ) {
      throw new TypeError('ReplyOutcome answer content must be text');
    }
  } else if (value.kind === 'silent') {
    if (value.explicit !== true) {
      throw new TypeError('ReplyOutcome silent result must be explicit');
    }
    requireText(value.reason, 'ReplyOutcome.reason');
  } else {
    requireText(value.code, 'ReplyOutcome.code');
    if (typeof value.retryable !== 'boolean') {
      throw new TypeError('ReplyOutcome.retryable must be a boolean');
    }
  }
  return value;
}

function normalizeRunCancelled(signal) {
  const value = requireEnvelope(signal, 'RunCancelled');
  for (const field of [
    'eventId',
    'idempotencyKey',
    'requestId',
    'turnId',
    'traceId',
    'causationId',
    'producer',
  ]) {
    requireText(value[field], `RunCancelled.${field}`);
  }
  for (const field of ['generation', 'sequence']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 1) {
      throw new TypeError(`RunCancelled.${field} must be a positive integer`);
    }
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    throw new TypeError('RunCancelled.payload must be an object');
  }
  requireText(value.payload.mode, 'RunCancelled.payload.mode');
  return value;
}

function settlementReason(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    throw new TypeError('presence settlement signal must be an object');
  }
  if (signal.type === 'ReplyOutcome') {
    const outcome = normalizeReplyOutcome(signal);
    if (outcome.kind === 'silent' && outcome.explicit === true) {
      return 'explicit_silent';
    }
  } else if (signal.type === 'RunCancelled') {
    normalizeRunCancelled(signal);
    return 'cancelled_confirmed';
  } else if (signal.type !== 'DeliverySettlement') {
    throw new TypeError('presence settlement signal must be a frozen v1 envelope');
  } else {
    const settlement = normalizeDeliverySettlement(signal);
    if (
      settlement.state === 'accepted'
      && settlement.presented === true
      && settlement.basis === 'platform_accepted'
    ) {
      return 'delivery_platform_accepted';
    }
    if (
      settlement.state === 'accepted'
      && settlement.presented === true
      && settlement.basis === 'reconciled'
    ) {
      return 'delivery_reconciled';
    }
    if (
      settlement.state === 'unpresentable'
      && settlement.presented === false
      && settlement.basis === 'retry_exhausted'
    ) {
      return 'delivery_unpresentable';
    }
  }
  const error = new Error('signal cannot finish Reply Presence');
  error.code = 'UNAUTHORIZED_PRESENCE_SETTLEMENT';
  throw error;
}

function assertSignalIdentity(requestId, signal) {
  if (typeof requestId !== 'string' || requestId.trim() === '') {
    throw new TypeError('presence settlement requestId must be a non-empty string');
  }
  if (signal?.requestId !== undefined && signal.requestId !== requestId) {
    const error = new Error('presence settlement belongs to a different request');
    error.code = 'IDENTITY_CONFLICT';
    throw error;
  }
  if (signal?.adapterId !== undefined && signal.adapterId !== 'feishu') {
    const error = new Error('presence settlement belongs to a different adapter');
    error.code = 'IDENTITY_CONFLICT';
    throw error;
  }
}

export function createReplyPresenceCoordinator({
  store,
  reactionPort,
  workerId,
  leaseMs = 30_000,
  retryDelayMs = 1_000,
} = {}) {
  if (!store || typeof store.claimPresence !== 'function') {
    throw new TypeError('presence store is invalid');
  }
  const effects = requirePort(reactionPort);
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new TypeError('presence workerId must be a non-empty string');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError('presence retryDelayMs must be a non-negative integer');
  }

  async function run(requestId) {
    const claim = store.claimPresence({ requestId, workerId, leaseMs });
    if (!claim) return store.inspectPresence(requestId);
    try {
      const operation = claim.presence.operation;
      const effect = {
        effectKey: claim.effectKey,
        requestId: claim.presence.requestId,
        presenceId: claim.presence.presenceId,
        sourceMessageId: claim.sourceMessageId,
        reactionId: claim.presence.reactionId,
      };
      let result;
      try {
        result = claim.needsReconcile
          ? await effects.reconcile({ ...effect, operation })
          : await effects[operation](effect);
      } catch (error) {
        const explicitlyRejected = error?.outcome === 'rejected'
          || error?.deliveryOutcome === 'rejected';
        return store.deferPresence({
          receipt: claim.receipt,
          outcome: explicitlyRejected ? 'rejected' : 'unknown',
          error: error instanceof Error ? error.message : String(error),
          retryAfterMs: error?.retryAfterMs ?? retryDelayMs,
        });
      }
      if (result?.outcome === 'platform_accepted' || result?.outcome === 'reconciled') {
        if (
          operation === 'add'
          && (typeof result.reactionId !== 'string' || result.reactionId.trim() === '')
        ) {
          return store.deferPresence({
            receipt: claim.receipt,
            outcome: 'unknown',
            error: 'accepted reaction add did not return a reaction identity',
            retryAfterMs: retryDelayMs,
          });
        }
        return store.completePresence({
          receipt: claim.receipt,
          reactionId: operation === 'add' ? result.reactionId : null,
        });
      }
      if (claim.needsReconcile && result?.outcome === 'not_found' && operation === 'remove') {
        return store.completePresence({ receipt: claim.receipt });
      }
      if (
        claim.needsReconcile
        && result?.outcome === 'not_found'
        && operation === 'add'
        && claim.presence.finishRequested
      ) {
        return store.completeAbsentPresence({ receipt: claim.receipt });
      }
      const knownAbsent = claim.needsReconcile && result?.outcome === 'not_found';
      const explicitlyRejected = result?.outcome === 'rejected'
        || result?.deliveryOutcome === 'rejected';
      return store.deferPresence({
        receipt: claim.receipt,
        outcome: knownAbsent || explicitlyRejected ? 'rejected' : 'unknown',
        error: result?.errorCode ?? result?.message ?? result?.outcome ?? 'unknown reaction outcome',
        retryAfterMs: result?.retryAfterMs ?? retryDelayMs,
      });
    } catch (error) {
      if (error?.code === 'LEASE_LOST') return store.inspectPresence(requestId);
      throw error;
    }
  }

  return Object.freeze({
    run,
    async settle({ requestId, signal }) {
      const reason = settlementReason(signal);
      assertSignalIdentity(requestId, signal);
      const requested = store.requestPresenceFinish({ requestId, reason });
      if (requested.status === 'finished') return requested;
      return run(requestId);
    },
    async recover({ limit = 100 } = {}) {
      const requestIds = store.listPresenceDue({ limit });
      let finished = 0;
      let pending = 0;
      for (const requestId of requestIds) {
        const result = await run(requestId);
        if (result.status === 'finished') finished += 1;
        else pending += 1;
      }
      return { attempted: requestIds.length, finished, pending };
    },
  });
}
