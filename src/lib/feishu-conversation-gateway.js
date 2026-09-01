import { createConversationLaneCoordinator } from './conversation-lane-coordinator.js';
import {
  openInboundEventInbox,
  processInboundEventInboxOnce,
} from './inbound-event-inbox.js';
import { normalizeFeishuInboundMessage } from './feishu-inbound-normalizer.js';

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
  let closing = false;

  function identityFor(normalized) {
    return {
      adapterId: normalized.adapterId,
      accountRef: normalized.accountRef,
      eventType: normalized.eventType,
      messageId: normalized.messageId,
    };
  }

  async function processCycle(limit = concurrency) {
    cycle += 1;
    return processInboundEventInboxOnce({
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
  }

  async function settle(identity) {
    for (;;) {
      const current = inbox.query(identity);
      if (!current) throw new Error('durably received Feishu message disappeared');
      if (current.status === 'committed') return current.result;
      if (current.status === 'dead_letter') throw deadLetterError(current);
      const summary = await processCycle(concurrency);
      const after = inbox.query(identity);
      if (after.status === 'committed') return after.result;
      if (after.status === 'dead_letter') throw deadLetterError(after);
      if (summary.claimed === 0) await delay(pollIntervalMs);
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
    async accept(rawEvent, options = {}) {
      if (closing) throw new Error('Feishu Conversation Gateway is closing');
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
        conversationLaneKey: normalized.conversationLaneKey,
        sourceOrder: normalized.sourceOrder,
      });
      const receipt = await settleEntry(received.entry, identityFor(normalized));
      return Object.freeze({
        status: received.created ? 'accepted' : 'duplicate',
        receipt,
      });
    },
    async recover() {
      if (closing) throw new Error('Feishu Conversation Gateway is closing');
      const total = { claimed: 0, committed: 0, failed: 0, deadLettered: 0 };
      for (;;) {
        const summary = await processCycle(concurrency);
        for (const key of Object.keys(total)) total[key] += summary[key];
        if (summary.claimed === 0) return Object.freeze(total);
      }
    },
    async close() {
      closing = true;
      await Promise.allSettled([...inFlight.values()]);
      inbox.close();
    },
  });
}
