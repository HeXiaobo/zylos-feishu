import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createConversationLaneCoordinator } from './conversation-lane-coordinator.js';

const MAX_ID_LENGTH = 512;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ERROR_LENGTH = 4_096;

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

function requireText(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) throw new TypeError(`${field} is too long`);
  return text;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

function requirePositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function requireNow(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('clock must return a non-negative Unix epoch millisecond');
  }
  return value;
}

function serializeJson(value, field, maxBytes = MAX_PAYLOAD_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${field} must be JSON serializable: ${error.message}`);
  }
  if (serialized === undefined) throw new TypeError(`${field} must be JSON serializable`);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new TypeError(`${field} exceeds ${maxBytes} bytes`);
  }
  return serialized;
}

function normalizeFailure(error) {
  const retryable = error?.retryable !== false;
  const rawMessage = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const message = rawMessage.trim() || 'unknown error';
  return {
    retryable,
    message: Array.from(message).slice(0, MAX_ERROR_LENGTH).join(''),
  };
}

function fingerprint(serialized) {
  return createHash('sha256').update(serialized).digest('hex');
}

function normalizeInbound(input) {
  const request = requireRecord(input, 'inbound event');
  const keys = Object.keys(request);
  const legacy = keys.length === 3
    && ['eventId', 'messageId', 'payload'].every((key) => keys.includes(key));
  const allowed = new Set([
    'adapterId',
    'accountRef',
    'eventType',
    'eventId',
    'messageId',
    'payload',
    'payloadHash',
    'conversationLaneKey',
    'sourceOrder',
  ]);
  const required = ['adapterId', 'accountRef', 'eventType', 'eventId', 'messageId', 'payload', 'conversationLaneKey'];
  if (!legacy && (keys.some((key) => !allowed.has(key))
    || required.some((key) => !keys.includes(key)))) {
    throw new TypeError('inbound event contains unsupported or missing fields');
  }
  const eventId = optionalText(request.eventId, 'inbound event.eventId');
  const messageId = optionalText(request.messageId, 'inbound event.messageId');
  if (!eventId && !messageId) throw new TypeError('inbound event requires eventId or messageId');
  const payloadJson = serializeJson(requireRecord(request.payload, 'inbound event.payload'), 'inbound event.payload');
  const computedFingerprint = fingerprint(payloadJson);
  const payloadHash = request.payloadHash === undefined
    ? `sha256:${computedFingerprint}`
    : requireText(request.payloadHash, 'inbound event.payloadHash');
  if (!/^sha256:[a-f0-9]{64}$/.test(payloadHash)) {
    throw new TypeError('inbound event.payloadHash must be a sha256 digest');
  }
  return {
    legacy,
    adapterId: legacy ? null : requireText(request.adapterId, 'inbound event.adapterId'),
    accountRef: legacy ? null : requireText(request.accountRef, 'inbound event.accountRef'),
    eventType: legacy ? null : requireText(request.eventType, 'inbound event.eventType'),
    eventId,
    messageId,
    payloadJson,
    payloadHash,
    requestFingerprint: computedFingerprint,
    conversationLaneKey: legacy
      ? null
      : requireText(request.conversationLaneKey, 'inbound event.conversationLaneKey', 2_048),
    sourceOrderJson: serializeJson(request.sourceOrder ?? null, 'inbound event.sourceOrder', 16_384),
  };
}

function identityPairs({ eventId, messageId }) {
  return [
    eventId ? { kind: 'event', value: eventId } : null,
    messageId ? { kind: 'message', value: messageId } : null,
  ].filter(Boolean);
}

function normalizeReceipt(value) {
  const receipt = requireRecord(value, 'inbound lease receipt');
  const keys = Object.keys(receipt);
  if (keys.length !== 3 || !['id', 'workerId', 'version'].every((key) => keys.includes(key))) {
    throw new TypeError('inbound lease receipt contains unsupported or missing fields');
  }
  return {
    id: requirePositiveInteger(receipt.id, 'inbound lease receipt.id'),
    workerId: requireText(receipt.workerId, 'inbound lease receipt.workerId', 256),
    version: requirePositiveInteger(receipt.version, 'inbound lease receipt.version'),
  };
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS feishu_inbound_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT,
      message_id TEXT,
      request_fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('received', 'processing', 'committed', 'failed', 'dead_letter')
      ),
      attempt INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_until INTEGER,
      last_error TEXT,
      result_json TEXT,
      received_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      committed_at INTEGER,
      dead_lettered_at INTEGER,
      adapter_id TEXT,
      account_ref TEXT,
      event_type TEXT,
      payload_hash TEXT,
      conversation_lane_key TEXT,
      lane_sequence INTEGER,
      source_order_json TEXT,
      CHECK (event_id IS NOT NULL OR message_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS feishu_inbound_identities (
      kind TEXT NOT NULL CHECK (kind IN ('event', 'message')),
      value TEXT NOT NULL,
      inbox_id INTEGER NOT NULL,
      PRIMARY KEY (kind, value),
      FOREIGN KEY (inbox_id) REFERENCES feishu_inbound_inbox(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_inbound_claim
      ON feishu_inbound_inbox(status, available_at, lease_until, id);
  `);

  const columns = new Set(database.prepare(
    'PRAGMA table_info(feishu_inbound_inbox)',
  ).all().map((column) => column.name));
  const additiveColumns = [
    ['adapter_id', 'TEXT'],
    ['account_ref', 'TEXT'],
    ['event_type', 'TEXT'],
    ['payload_hash', 'TEXT'],
    ['conversation_lane_key', 'TEXT'],
    ['lane_sequence', 'INTEGER'],
    ['source_order_json', 'TEXT'],
  ];
  for (const [name, type] of additiveColumns) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE feishu_inbound_inbox ADD COLUMN ${name} ${type}`);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS feishu_inbound_source_identities (
      adapter_id TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      event_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('event', 'message')),
      value TEXT NOT NULL,
      inbox_id INTEGER NOT NULL,
      PRIMARY KEY (adapter_id, account_ref, event_type, kind, value),
      FOREIGN KEY (inbox_id) REFERENCES feishu_inbound_inbox(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feishu_conversation_lanes (
      conversation_lane_key TEXT PRIMARY KEY,
      last_sequence INTEGER NOT NULL CHECK (last_sequence > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_inbound_lane_claim
      ON feishu_inbound_inbox(conversation_lane_key, lane_sequence, status);
  `);
}

function toView(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    messageId: row.message_id,
    adapterId: row.adapter_id,
    accountRef: row.account_ref,
    eventType: row.event_type,
    payloadHash: row.payload_hash ?? `sha256:${row.request_fingerprint}`,
    conversationLaneKey: row.conversation_lane_key,
    laneSequence: row.lane_sequence,
    sourceOrder: row.source_order_json === null ? null : JSON.parse(row.source_order_json),
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attempt: row.attempt,
    version: row.version,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    committedAt: row.committed_at,
    deadLetteredAt: row.dead_lettered_at,
  };
}

function toClaim(row) {
  const entry = toView(row);
  return Object.freeze({
    ...entry,
    receipt: Object.freeze({
      id: entry.id,
      workerId: entry.leaseOwner,
      version: entry.version,
    }),
  });
}

/**
 * Durable inbox Module for authenticated Feishu message events. Call receive()
 * synchronously before acknowledging either transport; workers use leased rows
 * through the remaining interface without knowing the SQLite implementation.
 */
export function openInboundEventInbox({ dbPath, clock = Date.now, maxAttempts = 5 } = {}) {
  const databasePath = requireText(dbPath, 'inbound inbox dbPath', 4_096);
  if (!path.isAbsolute(databasePath)) throw new TypeError('inbound inbox dbPath must be absolute');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  requirePositiveInteger(maxAttempts, 'maxAttempts', 100);
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.transaction(() => initializeSchema(database)).immediate();

  const selectById = database.prepare('SELECT * FROM feishu_inbound_inbox WHERE id = ?');
  const selectIdentity = database.prepare(`
    SELECT i.*
    FROM feishu_inbound_identities x
    JOIN feishu_inbound_inbox i ON i.id = x.inbox_id
    WHERE x.kind = ? AND x.value = ?
  `);
  const insertIdentity = database.prepare(`
    INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, ?)
  `);
  const selectSourceIdentity = database.prepare(`
    SELECT i.*
    FROM feishu_inbound_source_identities x
    JOIN feishu_inbound_inbox i ON i.id = x.inbox_id
    WHERE x.adapter_id = ? AND x.account_ref = ? AND x.event_type = ?
      AND x.kind = ? AND x.value = ?
  `);
  const insertSourceIdentity = database.prepare(`
    INSERT INTO feishu_inbound_source_identities (
      adapter_id, account_ref, event_type, kind, value, inbox_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  function rowsForIdentities(pairs, namespace = null) {
    const rows = pairs.map(({ kind, value }) => (
      namespace
        ? selectSourceIdentity.get(
          namespace.adapterId,
          namespace.accountRef,
          namespace.eventType,
          kind,
          value,
        )
        : selectIdentity.get(kind, value)
    )).filter(Boolean);
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }

  function allocateLaneSequence(conversationLaneKey) {
    const current = database.prepare(`
      SELECT last_sequence FROM feishu_conversation_lanes WHERE conversation_lane_key = ?
    `).get(conversationLaneKey);
    if (!current) {
      database.prepare(`
        INSERT INTO feishu_conversation_lanes (conversation_lane_key, last_sequence)
        VALUES (?, 1)
      `).run(conversationLaneKey);
      return 1;
    }
    const next = current.last_sequence + 1;
    database.prepare(`
      UPDATE feishu_conversation_lanes SET last_sequence = ? WHERE conversation_lane_key = ?
    `).run(next, conversationLaneKey);
    return next;
  }

  const receiveTransaction = database.transaction((input) => {
    const normalized = normalizeInbound(input);
    const pairs = identityPairs(normalized);
    const namespace = normalized.legacy ? null : normalized;
    const existingRows = rowsForIdentities(pairs, namespace);
    if (existingRows.length > 1) {
      throw domainError('IDENTITY_CONFLICT', 'eventId and messageId belong to different inbox entries');
    }
    if (existingRows.length === 1) {
      const existing = existingRows[0];
      const existingPayloadHash = existing.payload_hash ?? `sha256:${existing.request_fingerprint}`;
      const eventBinding = normalized.legacy || !normalized.eventId ? null : selectSourceIdentity.get(
        normalized.adapterId,
        normalized.accountRef,
        normalized.eventType,
        'event',
        normalized.eventId,
      );
      const messageBinding = normalized.legacy || !normalized.messageId ? null : selectSourceIdentity.get(
        normalized.adapterId,
        normalized.accountRef,
        normalized.eventType,
        'message',
        normalized.messageId,
      );
      if (existingPayloadHash !== normalized.payloadHash
        || (normalized.conversationLaneKey !== null
          && existing.conversation_lane_key !== normalized.conversationLaneKey)
        || (eventBinding && !messageBinding)) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'inbound identity belongs to different payload');
      }
      for (const pair of pairs) {
        if (normalized.legacy) {
          if (!selectIdentity.get(pair.kind, pair.value)) {
            insertIdentity.run(pair.kind, pair.value, existing.id);
          }
        } else if (!selectSourceIdentity.get(
          normalized.adapterId,
          normalized.accountRef,
          normalized.eventType,
          pair.kind,
          pair.value,
        )) {
          insertSourceIdentity.run(
            normalized.adapterId,
            normalized.accountRef,
            normalized.eventType,
            pair.kind,
            pair.value,
            existing.id,
          );
        }
      }
      return { created: false, entry: toView(existing) };
    }

    const now = requireNow(clock);
    const laneSequence = normalized.conversationLaneKey === null
      ? null
      : allocateLaneSequence(normalized.conversationLaneKey);
    const inserted = database.prepare(`
      INSERT INTO feishu_inbound_inbox (
        event_id, message_id, request_fingerprint, payload_json, status,
        available_at, received_at, updated_at,
        adapter_id, account_ref, event_type, payload_hash,
        conversation_lane_key, lane_sequence, source_order_json
      ) VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.eventId,
      normalized.messageId,
      normalized.requestFingerprint,
      normalized.payloadJson,
      now,
      now,
      now,
      normalized.adapterId,
      normalized.accountRef,
      normalized.eventType,
      normalized.payloadHash,
      normalized.conversationLaneKey,
      laneSequence,
      normalized.sourceOrderJson,
    );
    const id = Number(inserted.lastInsertRowid);
    for (const pair of pairs) {
      if (normalized.legacy) insertIdentity.run(pair.kind, pair.value, id);
      else {
        insertSourceIdentity.run(
          normalized.adapterId,
          normalized.accountRef,
          normalized.eventType,
          pair.kind,
          pair.value,
          id,
        );
      }
    }
    return { created: true, entry: toView(selectById.get(id)) };
  });

  const claimTransaction = database.transaction(({ workerId, leaseMs, limit }) => {
    const normalizedWorkerId = requireText(workerId, 'inbound workerId', 256);
    requirePositiveInteger(leaseMs, 'inbound leaseMs', 24 * 60 * 60_000);
    requirePositiveInteger(limit, 'inbound claim limit', 100);
    const now = requireNow(clock);
    const leaseUntil = now + leaseMs;
    database.prepare(`
      UPDATE feishu_inbound_inbox
      SET status = 'dead_letter', version = version + 1,
          lease_owner = NULL, lease_until = NULL,
          last_error = COALESCE(last_error, 'processing lease expired at maximum attempt limit'),
          dead_lettered_at = ?, updated_at = ?
      WHERE status = 'processing' AND lease_until <= ? AND attempt >= ?
    `).run(now, now, now, maxAttempts);
    const candidates = database.prepare(`
      SELECT candidate.id, candidate.version
      FROM feishu_inbound_inbox candidate
      WHERE candidate.attempt < ? AND (
        (candidate.status IN ('received', 'failed') AND candidate.available_at <= ?)
        OR (candidate.status = 'processing' AND candidate.lease_until <= ?)
      ) AND (
        candidate.conversation_lane_key IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM feishu_inbound_inbox predecessor
          WHERE predecessor.conversation_lane_key = candidate.conversation_lane_key
            AND predecessor.lane_sequence < candidate.lane_sequence
            AND predecessor.status <> 'committed'
        )
      )
      ORDER BY candidate.available_at, candidate.id
      LIMIT ?
    `).all(maxAttempts, now, now, limit);
    const update = database.prepare(`
      UPDATE feishu_inbound_inbox
      SET status = 'processing', attempt = attempt + 1, version = version + 1,
          lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND version = ? AND attempt < ? AND (
        (status IN ('received', 'failed') AND available_at <= ?)
        OR (status = 'processing' AND lease_until <= ?)
      )
    `);
    const claimed = [];
    for (const candidate of candidates) {
      const changed = update.run(
        normalizedWorkerId,
        leaseUntil,
        now,
        candidate.id,
        candidate.version,
        maxAttempts,
        now,
        now,
      );
      if (changed.changes === 1) claimed.push(toClaim(selectById.get(candidate.id)));
    }
    return claimed;
  });

  const commitTransaction = database.transaction(({ receipt, result }) => {
    const normalizedReceipt = normalizeReceipt(receipt);
    const resultJson = serializeJson(result ?? null, 'inbound result');
    const now = requireNow(clock);
    const current = selectById.get(normalizedReceipt.id);
    if (!current) throw domainError('INBOX_NOT_FOUND', 'inbound inbox entry does not exist');
    if (current.status !== 'processing'
      || current.lease_owner !== normalizedReceipt.workerId
      || current.version !== normalizedReceipt.version
      || current.lease_until <= now) {
      throw domainError('LEASE_LOST', 'inbound processing lease is no longer current');
    }
    database.prepare(`
      UPDATE feishu_inbound_inbox
      SET status = 'committed', version = version + 1, result_json = ?,
          lease_owner = NULL, lease_until = NULL, committed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ? AND version = ?
    `).run(
      resultJson,
      now,
      now,
      normalizedReceipt.id,
      normalizedReceipt.workerId,
      normalizedReceipt.version,
    );
    return toView(selectById.get(normalizedReceipt.id));
  });

  const failTransaction = database.transaction(({ receipt, error, retryAfterMs }) => {
    const normalizedReceipt = normalizeReceipt(receipt);
    requirePositiveInteger(retryAfterMs, 'inbound retryAfterMs', 24 * 60 * 60_000);
    const failure = normalizeFailure(error);
    const now = requireNow(clock);
    const current = selectById.get(normalizedReceipt.id);
    if (!current) throw domainError('INBOX_NOT_FOUND', 'inbound inbox entry does not exist');
    if (current.status !== 'processing'
      || current.lease_owner !== normalizedReceipt.workerId
      || current.version !== normalizedReceipt.version
      || current.lease_until <= now) {
      throw domainError('LEASE_LOST', 'inbound processing lease is no longer current');
    }
    const deadLetter = !failure.retryable || current.attempt >= maxAttempts;
    database.prepare(`
      UPDATE feishu_inbound_inbox
      SET status = ?, version = version + 1, available_at = ?, last_error = ?,
          lease_owner = NULL, lease_until = NULL, dead_lettered_at = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ? AND version = ?
    `).run(
      deadLetter ? 'dead_letter' : 'failed',
      deadLetter ? now : now + retryAfterMs,
      failure.message,
      deadLetter ? now : null,
      now,
      normalizedReceipt.id,
      normalizedReceipt.workerId,
      normalizedReceipt.version,
    );
    return toView(selectById.get(normalizedReceipt.id));
  });

  return Object.freeze({
    receive(input) {
      return receiveTransaction.immediate(input);
    },
    query(identity) {
      const request = requireRecord(identity, 'inbound identity');
      const eventId = optionalText(request.eventId, 'inbound identity.eventId');
      const messageId = optionalText(request.messageId, 'inbound identity.messageId');
      const namespaceFields = ['adapterId', 'accountRef', 'eventType'];
      const hasNamespace = namespaceFields.some((field) => request[field] !== undefined);
      if (hasNamespace && namespaceFields.some((field) => request[field] === undefined)) {
        throw new TypeError('inbound identity namespace must include adapterId, accountRef, and eventType');
      }
      const namespace = hasNamespace ? {
        adapterId: requireText(request.adapterId, 'inbound identity.adapterId'),
        accountRef: requireText(request.accountRef, 'inbound identity.accountRef'),
        eventType: requireText(request.eventType, 'inbound identity.eventType'),
      } : null;
      const rows = rowsForIdentities(identityPairs({ eventId, messageId }), namespace);
      if (rows.length > 1) throw domainError('IDENTITY_CONFLICT', 'identities belong to different inbox entries');
      return toView(rows[0]);
    },
    claim({ workerId, leaseMs, limit = 25 } = {}) {
      return claimTransaction.immediate({ workerId, leaseMs, limit });
    },
    commit(input) {
      return commitTransaction.immediate(requireRecord(input, 'inbound commit'));
    },
    fail(input) {
      return failTransaction.immediate(requireRecord(input, 'inbound failure'));
    },
    close() {
      database.close();
    },
  });
}

/**
 * Claim and settle one bounded batch. A supervisor may call this immediately at
 * startup and on a timer; claim() also recovers expired leases from prior runs.
 */
export async function processInboundEventInboxOnce({
  inbox,
  handleMessage,
  workerId,
  coordinator = null,
  concurrency = 1,
  leaseMs = 30_000,
  limit = 25,
  baseRetryDelayMs = 1_000,
  maxRetryDelayMs = 60_000,
} = {}) {
  const worker = requireText(workerId, 'inbound workerId', 256);
  if (!inbox || typeof inbox.claim !== 'function'
    || typeof inbox.commit !== 'function' || typeof inbox.fail !== 'function') {
    throw new TypeError('inbox must provide claim, commit, and fail functions');
  }
  if (typeof handleMessage !== 'function') throw new TypeError('handleMessage must be a function');
  requirePositiveInteger(leaseMs, 'inbound leaseMs', 24 * 60 * 60_000);
  requirePositiveInteger(limit, 'inbound claim limit', 100);
  requirePositiveInteger(concurrency, 'inbound concurrency', 100);
  requirePositiveInteger(baseRetryDelayMs, 'baseRetryDelayMs', 24 * 60 * 60_000);
  requirePositiveInteger(maxRetryDelayMs, 'maxRetryDelayMs', 24 * 60 * 60_000);
  if (maxRetryDelayMs < baseRetryDelayMs) {
    throw new TypeError('maxRetryDelayMs must be greater than or equal to baseRetryDelayMs');
  }

  const claimed = inbox.claim({ workerId: worker, leaseMs, limit });
  const summary = { claimed: claimed.length, committed: 0, failed: 0, deadLettered: 0 };
  const laneCoordinator = coordinator ?? createConversationLaneCoordinator({ concurrency });
  if (!laneCoordinator || typeof laneCoordinator.submit !== 'function') {
    throw new TypeError('coordinator must provide a submit function');
  }
  await Promise.all(claimed.map((entry) => laneCoordinator.submit({
    conversationLaneKey: entry.conversationLaneKey ?? `legacy-inbox:${entry.id}`,
    laneSequence: entry.laneSequence ?? 1,
  }, async () => {
    let result;
    try {
      const metadata = {
        inboxId: entry.id,
        eventId: entry.eventId,
        messageId: entry.messageId,
        attempt: entry.attempt,
      };
      if (entry.conversationLaneKey !== null) {
        Object.assign(metadata, {
          adapterId: entry.adapterId,
          accountRef: entry.accountRef,
          eventType: entry.eventType,
          payloadHash: entry.payloadHash,
          conversationLaneKey: entry.conversationLaneKey,
          laneSequence: entry.laneSequence,
          sourceOrder: entry.sourceOrder,
        });
      }
      result = await handleMessage(entry.payload, Object.freeze(metadata));
    } catch (error) {
      const retryAfterMs = Math.min(
        maxRetryDelayMs,
        baseRetryDelayMs * (2 ** Math.min(entry.attempt - 1, 30)),
      );
      const settled = inbox.fail({ receipt: entry.receipt, error, retryAfterMs });
      if (settled.status === 'dead_letter') summary.deadLettered += 1;
      else summary.failed += 1;
      return;
    }
    inbox.commit({ receipt: entry.receipt, result });
    summary.committed += 1;
  })));
  return Object.freeze(summary);
}
