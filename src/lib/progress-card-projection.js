function requirePort(port) {
  if (!port || typeof port !== 'object') throw new TypeError('cardPort must be an object');
  for (const method of ['apply', 'reconcile']) {
    if (typeof port[method] !== 'function') throw new TypeError(`cardPort.${method} must be a function`);
  }
  return port;
}

export function createProgressCardProjection({
  store,
  cardPort,
  workerId,
  leaseMs = 30_000,
  retryDelayMs = 1_000,
} = {}) {
  if (!store || typeof store.recordProjectionEvent !== 'function') {
    throw new TypeError('projection store is invalid');
  }
  const transport = requirePort(cardPort);
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    throw new TypeError('projection workerId must be a non-empty string');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError('projection retryDelayMs must be a non-negative integer');
  }

  async function applyClaim(claim) {
    let result;
    try {
      result = claim.needsReconcile
        ? await transport.reconcile(claim.operation)
        : await transport.apply(claim.operation);
    } catch (error) {
      const explicitlyRejected = error?.outcome === 'rejected'
        || error?.deliveryOutcome === 'rejected';
      return store.deferProjection({
        receipt: claim.receipt,
        outcome: explicitlyRejected ? 'rejected' : 'unknown',
        error: error instanceof Error ? error.message : String(error),
        retryAfterMs: error?.retryAfterMs ?? retryDelayMs,
      });
    }
    if (result?.outcome === 'platform_accepted' || result?.outcome === 'reconciled') {
      const returnedCardId = result.cardId ?? result.externalRef ?? null;
      const cardId = typeof returnedCardId === 'string' && returnedCardId.trim() !== ''
        ? returnedCardId.trim()
        : null;
      if (
        (returnedCardId !== null && cardId === null)
        || (claim.operation.cardId === null && cardId === null)
      ) {
        return store.deferProjection({
          receipt: claim.receipt,
          outcome: 'unknown',
          error: 'accepted CardKit operation did not return a card identity',
          retryAfterMs: retryDelayMs,
        });
      }
      return store.completeProjection({
        receipt: claim.receipt,
        cardId,
      });
    }
    const knownAbsent = claim.needsReconcile && result?.outcome === 'not_found';
    const explicitlyRejected = result?.outcome === 'rejected'
      || result?.deliveryOutcome === 'rejected';
    return store.deferProjection({
      receipt: claim.receipt,
      outcome: knownAbsent || explicitlyRejected ? 'rejected' : 'unknown',
      error: result?.errorCode ?? result?.message ?? result?.outcome ?? 'unknown card outcome',
      retryAfterMs: result?.retryAfterMs ?? retryDelayMs,
  });
}
  return Object.freeze({
    record(event) {
      return store.recordProjectionEvent(event);
    },
    async drain({ limit = 100 } = {}) {
      const claims = store.claimProjections({ workerId, leaseMs, limit });
      let applied = 0;
      let pending = 0;
      for (const claim of claims) {
        try {
          const projection = await applyClaim(claim);
          if (projection.operationStatus === null) applied += 1;
          else pending += 1;
        } catch (error) {
          if (error?.code !== 'LEASE_LOST') throw error;
          pending += 1;
        }
      }
      return { attempted: claims.length, applied, pending };
    },
  });
}
