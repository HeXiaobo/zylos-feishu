import { createConversationLaneCoordinator } from './conversation-lane-coordinator.js';
import {
  openInboundEventInbox,
  processInboundEventInboxOnce,
} from './inbound-event-inbox.js';
import { normalizeFeishuInboundMessage } from './feishu-inbound-normalizer.js';
import { normalizeInboundMessageEvent } from './inbound-message-event.js';

function requireText(value, field, maximum = 4_096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maximum) throw new TypeError(`${field} is too long`);
  return text;
}

function requirePositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deadLetterError(entry) {
  const error = new Error(entry.lastError || 'Feishu inbound message reached dead letter');
  error.code = 'INBOUND_DEAD_LETTER';
  error.inboxId = entry.id;
  return error;
}

function gatewayError(code, message, cause = undefined) {
  const error = new Error(message);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isLegacyUpgradeDataError(error) {
  return error instanceof TypeError || [
    'IDENTITY_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'INVALID_PAYLOAD_HASH',
  ].includes(error?.code);
}

/**
 * Deep Feishu inbound Module. It owns authentication, normalization, durable
 * Inbox replay, dual dedupe, lane ordering, and bounded Core durable accept.
 */
export function createFeishuConversationGateway({
  dbPath,
  accountRef,
  coreIntake,
  authorize,
  workerId,
  clock = Date.now,
  concurrency = 4,
  leaseMs = 30_000,
  maxAttempts = 5,
  pollIntervalMs = 10,
  baseRetryDelayMs = 1_000,
  maxRetryDelayMs = 60_000,
} = {}) {
  const normalizedAccountRef = requireText(accountRef, 'Feishu gateway accountRef');
  const normalizedWorkerId = requireText(workerId, 'Feishu gateway workerId', 256);
  if (!coreIntake || typeof coreIntake.accept !== 'function') {
    throw new TypeError('Feishu gateway coreIntake must provide accept');
  }
  if (typeof authorize !== 'function') {
    throw new TypeError('Feishu gateway authorize must be a function');
  }
  if (typeof clock !== 'function') throw new TypeError('Feishu gateway clock must be a function');
  requirePositiveInteger(concurrency, 'Feishu gateway concurrency', 100);
  requirePositiveInteger(leaseMs, 'Feishu gateway leaseMs', 24 * 60 * 60_000);
  requirePositiveInteger(maxAttempts, 'Feishu gateway maxAttempts', 100);
  requirePositiveInteger(pollIntervalMs, 'Feishu gateway pollIntervalMs', 60_000);

  const inbox = openInboundEventInbox({ dbPath, clock, maxAttempts });
  const coordinator = createConversationLaneCoordinator({ concurrency });
  const inFlight = new Map();
  let cycle = 0;
  let lifecycle = 'open';
  let activeOperations = 0;
  let resolveDrain = null;
  let closePromise = null;
  let drainFailure = null;
  const drainCycles = new Set();

  function recordDrainFailure(error) {
    if (lifecycle === 'draining' && drainFailure === null) drainFailure = error;
  }

  function finishOperation() {
    activeOperations -= 1;
    if (activeOperations === 0 && resolveDrain) {
      const resolve = resolveDrain;
      resolveDrain = null;
      resolve();
    }
  }

  function trackStartedOperation(kind, execute) {
    activeOperations += 1;
    return Promise.resolve()
      .then(execute)
      .then(
        (result) => {
          if (kind === 'recover' && (result.failed > 0 || result.deadLettered > 0)) {
            recordDrainFailure(new Error(
              'gateway recover left retryable or dead-lettered messages',
            ));
          }
          return result;
        },
        (error) => {
          recordDrainFailure(error);
          throw error;
        },
      )
      .finally(finishOperation);
  }

  function runOperation(kind, execute) {
    if (lifecycle !== 'open') {
      return Promise.reject(gatewayError(
        'GATEWAY_DRAINING',
        'Feishu Conversation Gateway is draining',
      ));
    }
    return trackStartedOperation(kind, execute);
  }

  function waitForActiveOperations() {
    if (activeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => { resolveDrain = resolve; });
  }

  function closeGateway() {
    if (closePromise) return closePromise;
    lifecycle = 'draining';
    const drained = waitForActiveOperations();
    closePromise = (async () => {
      await drained;
      let closeFailure = null;
      try {
        inbox.close();
      } catch (error) {
        closeFailure = error;
      }
      lifecycle = 'closed';
      if (drainFailure || closeFailure) {
        throw gatewayError(
          'GATEWAY_DRAIN_FAILED',
          'Feishu Conversation Gateway closed after an incomplete drain',
          drainFailure ?? closeFailure,
        );
      }
    })();
    return closePromise;
  }

  function identityFor(normalized) {
    return {
      adapterId: normalized.adapterId,
      accountRef: normalized.accountRef,
      eventType: normalized.eventType,
      messageId: normalized.messageId,
    };
  }

  function upgradeLegacyPending() {
    const pending = inbox.pendingLegacy();
    let { deadLettered } = pending;
    for (const entry of pending.entries) {
      try {
        const legacyPayload = entry.payload;
        const rawEvent = {
          event_id: entry.eventId ?? `legacy-inbox:${entry.id}`,
          create_time: legacyPayload._timestamp,
          message: legacyPayload.message,
          sender: legacyPayload.sender,
        };
        const normalized = normalizeFeishuInboundMessage(rawEvent, {
          accountRef: normalizedAccountRef,
          eventId: rawEvent.event_id,
          clock,
        });
        inbox.receive({
          adapterId: normalized.adapterId,
          accountRef: normalized.accountRef,
          eventType: normalized.eventType,
          eventId: normalized.eventId,
          messageId: normalized.messageId,
          payload: normalized.message,
          payloadHash: normalized.payloadHash,
          legacyPayload,
          conversationLaneKey: normalized.conversationLaneKey,
          sourceOrder: normalized.sourceOrder,
        });
      } catch (error) {
        if (!isLegacyUpgradeDataError(error)) throw error;
        inbox.quarantineLegacy({ id: entry.id, error });
        deadLettered += 1;
      }
    }
    return deadLettered;
  }

  async function processCycle(limit = concurrency) {
    cycle += 1;
    const summary = await processInboundEventInboxOnce({
      inbox,
      coordinator,
      concurrency,
      workerId: `${normalizedWorkerId}:${cycle}`,
      leaseMs,
      limit,
      baseRetryDelayMs,
      maxRetryDelayMs,
      handleMessage: (message, metadata) => coreIntake.accept(message, {
        conversationLaneKey: metadata.conversationLaneKey,
        laneSequence: metadata.laneSequence,
        sourceOrder: metadata.sourceOrder,
      }),
    });
    if (summary.failed > 0 || summary.deadLettered > 0) {
      recordDrainFailure(new Error(
        'gateway processing left retryable or dead-lettered messages',
      ));
    }
    return summary;
  }

  function startDrainCycle() {
    if (drainCycles.size >= concurrency) return null;
    const operation = trackStartedOperation('drain', () => processCycle(1));
    const shared = operation.finally(() => drainCycles.delete(shared));
    shared.catch(() => {});
    drainCycles.add(shared);
    return shared;
  }

  function fillDrainCapacity() {
    const started = [];
    while (drainCycles.size < concurrency) started.push(startDrainCycle());
    return started;
  }

  async function drainUntilIdle() {
    const total = { claimed: 0, committed: 0, failed: 0, deadLettered: 0 };
    let firstFailure = null;
    for (;;) {
      if (firstFailure === null) fillDrainCapacity();
      const snapshot = [...drainCycles];
      if (snapshot.length === 0) {
        if (firstFailure) throw firstFailure;
        return Object.freeze(total);
      }
      const settlements = await Promise.allSettled(snapshot);
      let claimed = 0;
      for (const settlement of settlements) {
        if (settlement.status === 'rejected') {
          if (firstFailure === null) firstFailure = settlement.reason;
          continue;
        }
        claimed += settlement.value.claimed;
        for (const key of Object.keys(total)) total[key] += settlement.value[key];
      }
      if (drainCycles.size > 0) continue;
      if (firstFailure) throw firstFailure;
      if (claimed === 0) return Object.freeze(total);
    }
  }

  async function settle(identity) {
    for (;;) {
      const current = inbox.query(identity);
      if (!current) throw new Error('durably received Feishu message disappeared');
      if (current.status === 'committed') return current.result;
      if (current.status === 'dead_letter') throw deadLetterError(current);
      fillDrainCapacity();
      const watchedCycles = [...drainCycles].map((cyclePromise) => cyclePromise.then(
        (summary) => ({ summary }),
        (error) => ({ error }),
      ));
      const outcome = await Promise.race([
        ...watchedCycles,
        delay(pollIntervalMs).then(() => ({ tick: true })),
      ]);
      const after = inbox.query(identity);
      if (after.status === 'committed') return after.result;
      if (after.status === 'dead_letter') throw deadLetterError(after);
      if (outcome.error) throw outcome.error;
      if (outcome.summary?.claimed === 0) await delay(pollIntervalMs);
    }
  }

  function settleEntry(entry, identity) {
    const existing = inFlight.get(entry.id);
    if (existing) return existing;
    const promise = settle(identity).finally(() => inFlight.delete(entry.id));
    inFlight.set(entry.id, promise);
    return promise;
  }

  return Object.freeze({
    accept(rawEvent, options = {}) {
      return runOperation('accept', async () => {
        if (await authorize(rawEvent, options) !== true) {
          return Object.freeze({ status: 'ignored', reason: 'unauthorized' });
        }
        const normalized = normalizeFeishuInboundMessage(rawEvent, {
          accountRef: normalizedAccountRef,
          eventId: options.eventId,
          eventType: options.eventType,
          sourceOrder: options.sourceOrder ?? null,
          clock,
          priority: options.priority ?? 2,
        });
        const received = inbox.receive({
          adapterId: normalized.adapterId,
          accountRef: normalized.accountRef,
          eventType: normalized.eventType,
          eventId: normalized.eventId,
          messageId: normalized.messageId,
          payload: normalized.message,
          payloadHash: normalized.payloadHash,
          legacyPayload: normalizeInboundMessageEvent(rawEvent, normalized.eventId).payload,
          conversationLaneKey: normalized.conversationLaneKey,
          sourceOrder: normalized.sourceOrder,
        });
        fillDrainCapacity();
        const receipt = await settleEntry(received.entry, identityFor(normalized));
        return Object.freeze({
          status: received.created ? 'accepted' : 'duplicate',
          receipt,
        });
      });
    },
    recover() {
      return runOperation('recover', async () => {
        const migratedDeadLetters = upgradeLegacyPending();
        const summary = await drainUntilIdle();
        return Object.freeze({
          ...summary,
          deadLettered: summary.deadLettered + migratedDeadLetters,
        });
      });
    },
    close: closeGateway,
  });
}
