import fs from 'node:fs';
import path from 'node:path';

const REQUEST_FIELDS = new Set(['deliveryKey', 'deliveryUuid', 'target', 'confirmation']);
const TARGET_FIELDS = new Set(['kind', 'id']);
const UUID = /^zwi_[a-f0-9]{40}$/;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function normalizeRequest(input) {
  const request = requireRecord(input, 'WorkIntake confirmation delivery request');
  requireExactFields(request, REQUEST_FIELDS, 'WorkIntake confirmation delivery request');
  const target = requireRecord(request.target, 'WorkIntake confirmation delivery target');
  requireExactFields(target, TARGET_FIELDS, 'WorkIntake confirmation delivery target');
  if (target.kind !== 'chat' && target.kind !== 'reply') {
    throw new TypeError('WorkIntake confirmation delivery target.kind is unsupported');
  }
  const deliveryUuid = requireText(request.deliveryUuid, 'WorkIntake confirmation deliveryUuid', 64);
  if (!UUID.test(deliveryUuid)) throw new TypeError('WorkIntake confirmation deliveryUuid is invalid');
  return {
    deliveryKey: requireText(request.deliveryKey, 'WorkIntake confirmation deliveryKey'),
    deliveryUuid,
    target: {
      kind: target.kind,
      id: requireText(target.id, 'WorkIntake confirmation delivery target.id', 256),
    },
    // Persist the stable Core decision and channel-neutral envelope, not a card
    // containing a short-lived callback token. The delivery adapter renders and
    // signs immediately before each attempt, including after a restart.
    confirmation: structuredClone(requireRecord(
      request.confirmation,
      'WorkIntake confirmation delivery data',
    )),
  };
}

function loadState(outboxPath) {
  if (!fs.existsSync(outboxPath)) return { version: 1, records: {} };
  const state = JSON.parse(fs.readFileSync(outboxPath, 'utf8'));
  if (state?.version !== 1 || !state.records || typeof state.records !== 'object') {
    throw new TypeError('WorkIntake confirmation outbox is invalid');
  }
  return state;
}

function requireNow(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('clock must return epoch milliseconds');
  return value;
}

/**
 * Durable Feishu delivery Adapter for confirmation cards. It persists the full
 * send request before I/O and retains a delivered receipt. Stable platform UUID
 * closes the crash window between the remote send and the local receipt write.
 */
export function createWorkIntakeConfirmationDelivery({ outboxPath, deliver, clock }) {
  if (typeof outboxPath !== 'string' || !path.isAbsolute(outboxPath)) {
    throw new TypeError('outboxPath must be an absolute path');
  }
  if (typeof deliver !== 'function') throw new TypeError('deliver must be a function');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const state = loadState(outboxPath);

  function persist() {
    fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
    const temporaryPath = `${outboxPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, outboxPath);
  }

  async function attempt(record) {
    record.attemptCount += 1;
    record.updatedAt = requireNow(clock);
    record.lastError = null;
    persist();
    try {
      const result = await deliver(record.request);
      if (!result?.success) throw new Error(result?.message || 'Feishu confirmation delivery failed');
      record.status = 'delivered';
      record.externalId = result.messageId ?? null;
      record.deliveredAt = requireNow(clock);
      record.updatedAt = record.deliveredAt;
      persist();
      return result;
    } catch (error) {
      // Persist only bounded operational classification. Error messages from
      // platform SDKs may contain tokens, request context, or message bodies.
      record.lastError = JSON.stringify({
        code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'DELIVERY_FAILED',
        retryable: error?.retryable !== false,
      });
      record.updatedAt = requireNow(clock);
      persist();
      throw error;
    }
  }

  return Object.freeze({
    async send(input) {
      const request = normalizeRequest(input);
      let record = state.records[request.deliveryKey];
      if (record) {
        if (JSON.stringify(record.request) !== JSON.stringify(request)) {
          const error = new Error('WorkIntake confirmation delivery key belongs to different content');
          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        if (record.status === 'delivered') {
          return { success: true, messageId: record.externalId, replayed: true };
        }
      } else {
        const now = requireNow(clock);
        record = {
          status: 'pending',
          request,
          attemptCount: 0,
          lastError: null,
          externalId: null,
          createdAt: now,
          updatedAt: now,
          deliveredAt: null,
        };
        state.records[request.deliveryKey] = record;
        persist();
      }
      return attempt(record);
    },

    pending() {
      return Object.values(state.records)
        .filter((record) => record.status === 'pending')
        .map((record) => structuredClone(record.request));
    },

    async retryPending() {
      const records = Object.values(state.records).filter((record) => record.status === 'pending');
      let deliveredCount = 0;
      let failedCount = 0;
      for (const record of records) {
        try {
          await attempt(record);
          deliveredCount += 1;
        } catch {
          failedCount += 1;
        }
      }
      return { attempted: records.length, delivered: deliveredCount, failed: failedCount };
    },
  });
}
