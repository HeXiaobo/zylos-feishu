function requirePort(port) {
  if (!port || typeof port !== 'object') throw new TypeError('reactionPort must be an object');
  for (const method of ['add', 'remove', 'reconcile']) {
    if (typeof port[method] !== 'function') {
      throw new TypeError(`reactionPort.${method} must be a function`);
    }
  }
  return port;
}

function settlementReason(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    throw new TypeError('presence settlement signal must be an object');
  }
  if (signal.type === 'reply_outcome' && signal.kind === 'silent' && signal.explicit === true) {
    return 'explicit_silent';
  }
  if (signal.type === 'run_cancelled' && signal.confirmed === true) {
    return 'cancelled_confirmed';
  }
  if (
    signal.type === 'delivery_settlement'
    && signal.state === 'accepted'
    && signal.presented === true
    && signal.basis === 'platform_accepted'
  ) {
    return 'delivery_platform_accepted';
  }
  if (
    signal.type === 'delivery_settlement'
    && signal.state === 'accepted'
    && signal.presented === true
    && signal.basis === 'reconciled'
  ) {
    return 'delivery_reconciled';
  }
  if (
    signal.type === 'delivery_settlement'
    && signal.state === 'unpresentable'
    && signal.presented === false
    && signal.basis === 'retry_exhausted'
  ) {
    return 'delivery_unpresentable';
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
  }

  return Object.freeze({
    run,
    async settle({ requestId, signal }) {
      assertSignalIdentity(requestId, signal);
      const reason = settlementReason(signal);
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
