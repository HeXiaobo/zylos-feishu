import { createReplyPresenceCoordinator } from './reply-presence-coordinator.js';
import { createProgressCardProjection } from './progress-card-projection.js';
import { createReplyPresentationReconciler } from './reply-presentation-reconciler.js';
import { openReplyPresentationStore } from './reply-presentation-store.js';

function normalizeDeliveryReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('DeliveryReceipt must be an object');
  }
  if (receipt.schemaVersion !== 1 || receipt.type !== 'DeliveryReceipt') {
    throw new TypeError('DeliveryReceipt contract version is unsupported');
  }
  if (receipt.adapterId !== 'feishu') {
    throw new TypeError('DeliveryReceipt adapterId must be feishu');
  }
  for (const field of [
    'receiptId',
    'intentId',
    'deliveryId',
    'requestId',
    'attemptId',
    'traceId',
    'observedAt',
  ]) {
    if (typeof receipt[field] !== 'string' || receipt[field].trim() === '') {
      throw new TypeError(`DeliveryReceipt.${field} must be a non-empty string`);
    }
  }
  if (!['platform_accepted', 'unknown', 'reconciled', 'rejected'].includes(receipt.outcome)) {
    throw new TypeError('DeliveryReceipt.outcome is unsupported');
  }
  if (receipt.externalRef !== null && (
    typeof receipt.externalRef !== 'string' || receipt.externalRef.trim() === ''
  )) {
    throw new TypeError('DeliveryReceipt.externalRef must be null or a non-empty string');
  }
  return receipt;
}

export function openFeishuReplyPresentation({
  dbPath,
  reactionPort,
  cardPort,
  clock = Date.now,
  workerId,
  leaseMs = 30_000,
  retryDelayMs = 1_000,
  coalesceMs = 500,
} = {}) {
  if (!cardPort || typeof cardPort.apply !== 'function' || typeof cardPort.reconcile !== 'function') {
    throw new TypeError('cardPort must provide apply and reconcile functions');
  }
  const ledger = openReplyPresentationStore({ dbPath, clock, coalesceMs });
  const presence = createReplyPresenceCoordinator({
    store: ledger.presenceEffects,
    reactionPort,
    workerId,
    leaseMs,
    retryDelayMs,
  });
  const projection = createProgressCardProjection({
    store: ledger.progressProjections,
    cardPort,
    workerId,
    leaseMs,
    retryDelayMs,
  });
  const reconciler = createReplyPresentationReconciler({ presence, projection });

  return Object.freeze({
    async accept(input) {
      // Durable acceptance is intentionally independent from Feishu I/O. The
      // reconciler claims the pending add effect after this receipt returns.
      return ledger.replyHandles.bind(input);
    },
    observePresence(input) {
      return ledger.presenceEffects.observePresence(input);
    },
    settlePresence(input) {
      return presence.settle(input);
    },
    observeDeliveryReceipt(receipt) {
      // WT02-C owns the durable delivery ledger and settlement. This adapter
      // may observe receipts for UI diagnostics, but must not duplicate or
      // infer delivery state from an attempt-level acknowledgement.
      const normalized = normalizeDeliveryReceipt(receipt);
      const snapshot = ledger.inspect(normalized.requestId);
      if (!snapshot.handle || !snapshot.presence) {
        const error = new Error('reply presence does not exist');
        error.code = 'PRESENCE_NOT_FOUND';
        throw error;
      }
      if (snapshot.handle.route.adapterId !== normalized.adapterId) {
        const error = new Error('DeliveryReceipt belongs to a different adapter');
        error.code = 'IDENTITY_CONFLICT';
        throw error;
      }
      return {
        ...snapshot.presence,
        lastDeliveryOutcome: normalized.outcome,
        deliveryReconcileRequired: normalized.outcome === 'unknown',
      };
    },
    recordProgress(event) {
      return projection.record(event);
    },
    async flushDue({ limit = 100 } = {}) {
      return reconciler.flushProjection({ limit });
    },
    async reconcile({ limit = 100 } = {}) {
      return reconciler.run({ limit });
    },
    inspect(requestId) {
      return ledger.inspect(requestId);
    },
    close() {
      ledger.close();
    },
  });
}
