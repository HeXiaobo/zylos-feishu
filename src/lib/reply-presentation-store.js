import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { createProgressCoalescer } from './progress-coalescer.js';

const MAX_ID_LENGTH = 512;
const MAX_JSON_BYTES = 1024 * 1024;
const PRESENCE_OBSERVATIONS = new Set([
  'queued',
  'run_started',
  'card_opened',
  'progress',
  'output_delta',
  'fallback',
  'elapsed_over_120_seconds',
]);

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) throw new TypeError(`${field} is too long`);
  return text;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('clock must return a non-negative Unix epoch millisecond');
  }
  return now;
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite numbers are unsupported');
    return value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${typeof value} values are unsupported`);
  }
  if (seen.has(value)) throw new TypeError('cyclic values are unsupported');
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('symbol keys are unsupported');
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      const ownNames = Object.getOwnPropertyNames(value);
      const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
      const expectedKeySet = new Set(expectedKeys);
      if (
        keys.length !== value.length
        || keys.some((key, index) => key !== String(index))
        || ownNames.length !== expectedKeys.length + 1
        || ownNames.some((key) => key !== 'length' && !expectedKeySet.has(key))
      ) {
        throw new TypeError('sparse arrays and array properties are unsupported');
      }
      return expectedKeys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('array accessors are unsupported');
        }
        return canonicalize(descriptor.value, seen);
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('only plain objects are supported');
    }
    const ownNames = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (ownNames.length !== keys.length) {
      throw new TypeError('non-enumerable object properties are unsupported');
    }
    const entries = keys.sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('object accessors are unsupported');
      }
      return [key, canonicalize(descriptor.value, seen)];
    });
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

function serialize(value, field) {
  let json;
  try {
    json = JSON.stringify(canonicalize(value));
  } catch (error) {
    throw new TypeError(`${field} must be JSON serializable: ${error.message}`);
  }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) {
    throw new TypeError(`${field} is not a bounded JSON value`);
  }
  return json;
}

function fingerprint(json) {
  return createHash('sha256').update(json).digest('hex');
}

function normalizeHandle(input) {
  const value = requireRecord(input, 'reply handle');
  // ingressId is the stable, durable logical-ingress handoff owned by WT03-F;
  // requestId is the accepted Core identity. sourceMessageId is only the
  // opaque Feishu resource targeted by Reply Presence and is deliberately not
  // a presentation dedupe key by itself.
  const expected = [
    'ingressId',
    'requestId',
    'sourceMessageId',
    'route',
    'presentationId',
    'presenceId',
  ];
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError('reply handle contains unsupported or missing fields');
  }
  const route = requireRecord(value.route, 'reply handle.route');
  const normalizedRoute = canonicalize(route);
  if (normalizedRoute.adapterId !== 'feishu') {
    throw new TypeError('reply handle.route.adapterId must be feishu');
  }
  requireText(normalizedRoute.targetRef, 'reply handle.route.targetRef');
  const normalized = {
    ingressId: requireText(value.ingressId, 'reply handle.ingressId'),
    requestId: requireText(value.requestId, 'reply handle.requestId'),
    sourceMessageId: requireText(value.sourceMessageId, 'reply handle.sourceMessageId'),
    route: normalizedRoute,
    presentationId: requireText(value.presentationId, 'reply handle.presentationId'),
    presenceId: requireText(value.presenceId, 'reply handle.presenceId'),
  };
  const payloadJson = serialize(normalized, 'reply handle');
  return { ...normalized, payloadJson, payloadHash: fingerprint(payloadJson) };
}

function normalizeProgressEvent(input) {
  const value = requireRecord(input, 'progress projection event');
  const expected = ['requestId', 'presentationId', 'sequence', 'type', 'payload', 'terminal'];
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new TypeError('progress projection event contains unsupported or missing fields');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new TypeError('progress projection event.sequence must be a positive integer');
  }
  if (typeof value.terminal !== 'boolean') {
    throw new TypeError('progress projection event.terminal must be a boolean');
  }
  const normalized = {
    requestId: requireText(value.requestId, 'progress projection event.requestId'),
    presentationId: requireText(value.presentationId, 'progress projection event.presentationId'),
    sequence: value.sequence,
    type: requireText(value.type, 'progress projection event.type', 128),
    payload: canonicalize(requireRecord(value.payload, 'progress projection event.payload')),
    terminal: value.terminal,
  };
  const eventJson = serialize(normalized, 'progress projection event');
  return { ...normalized, eventJson, eventHash: fingerprint(eventJson) };
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS feishu_reply_handles (
      request_id TEXT PRIMARY KEY,
      ingress_id TEXT NOT NULL UNIQUE,
      source_message_id TEXT NOT NULL,
      route_json TEXT NOT NULL,
      presentation_id TEXT NOT NULL,
      presence_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_presence_effects (
      request_id TEXT PRIMARY KEY,
      presence_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('adding', 'active', 'finishing', 'finished', 'orphaned')
      ),
      reaction_id TEXT,
      add_effect_key TEXT NOT NULL UNIQUE,
      remove_effect_key TEXT NOT NULL UNIQUE,
      finish_reason TEXT,
      finish_requested INTEGER NOT NULL DEFAULT 0 CHECK (finish_requested IN (0, 1)),
      operation TEXT CHECK (operation IN ('add', 'remove')),
      operation_status TEXT CHECK (operation_status IN ('pending', 'inflight', 'unknown')),
      attempt INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      lease_version INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_until INTEGER,
      last_error TEXT,
      stale_observed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      FOREIGN KEY (request_id) REFERENCES feishu_reply_handles(request_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_presence_due
      ON feishu_presence_effects(operation_status, available_at, lease_until, request_id);

    CREATE TABLE IF NOT EXISTS feishu_progress_projections (
      request_id TEXT NOT NULL,
      presentation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'terminal', 'degraded')),
      high_watermark INTEGER NOT NULL DEFAULT 0,
      last_applied_sequence INTEGER NOT NULL DEFAULT 0,
      cardkit_sequence INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER,
      terminal_sequence INTEGER,
      card_id TEXT,
      operation_id TEXT,
      operation_kind TEXT CHECK (operation_kind IN ('open', 'update', 'finalize', 'fallback')),
      operation_status TEXT CHECK (operation_status IN ('pending', 'inflight', 'unknown')),
      operation_source_watermark INTEGER,
      operation_events_json TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      lease_version INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_until INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, presentation_id),
      FOREIGN KEY (request_id) REFERENCES feishu_reply_handles(request_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS feishu_projection_events (
      request_id TEXT NOT NULL,
      presentation_id TEXT NOT NULL,
      source_sequence INTEGER NOT NULL,
      event_hash TEXT NOT NULL,
      event_json TEXT NOT NULL,
      projectable INTEGER NOT NULL DEFAULT 1 CHECK (projectable IN (0, 1)),
      received_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, presentation_id, source_sequence),
      FOREIGN KEY (request_id, presentation_id)
        REFERENCES feishu_progress_projections(request_id, presentation_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_projection_due
      ON feishu_progress_projections(
        operation_status, available_at, lease_until, due_at, request_id, presentation_id
      );
  `);

  const projectionEventColumns = database
    .pragma('table_info(feishu_projection_events)')
    .map((column) => column.name);
  if (!projectionEventColumns.includes('projectable')) {
    database.exec(`
      ALTER TABLE feishu_projection_events
      ADD COLUMN projectable INTEGER NOT NULL DEFAULT 1 CHECK (projectable IN (0, 1));
    `);
  }
}

function handleView(row) {
  if (!row) return null;
  return {
    ingressId: row.ingress_id,
    requestId: row.request_id,
    sourceMessageId: row.source_message_id,
    route: JSON.parse(row.route_json),
    presentationId: row.presentation_id,
    presenceId: row.presence_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presenceView(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    presenceId: row.presence_id,
    status: row.status,
    reactionId: row.reaction_id,
    addEffectKey: row.add_effect_key,
    removeEffectKey: row.remove_effect_key,
    finishReason: row.finish_reason,
    finishRequested: row.finish_requested === 1,
    operation: row.operation,
    operationStatus: row.operation_status,
    attempt: row.attempt,
    version: row.version,
    leaseVersion: row.lease_version,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    staleObservedAt: row.stale_observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function projectionView(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    presentationId: row.presentation_id,
    status: row.status,
    highWatermark: row.high_watermark,
    lastAppliedSequence: row.last_applied_sequence,
    cardKitSequence: row.cardkit_sequence,
    dueAt: row.due_at,
    terminalSequence: row.terminal_sequence,
    cardId: row.card_id,
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    operationStatus: row.operation_status,
    operationSourceWatermark: row.operation_source_watermark,
    attempt: row.attempt,
    version: row.version,
    leaseVersion: row.lease_version,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openReplyPresentationStore({ dbPath, clock = Date.now, coalesceMs = 500 } = {}) {
  const databasePath = requireText(dbPath, 'reply presentation dbPath', 4_096);
  if (!path.isAbsolute(databasePath)) {
    throw new TypeError('reply presentation dbPath must be absolute');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (!Number.isSafeInteger(coalesceMs) || coalesceMs < 250 || coalesceMs > 1_000) {
    throw new TypeError('progress coalesceMs must be between 250 and 1000');
  }
  const coalescer = createProgressCoalescer({ windowMs: coalesceMs });
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new Database(databasePath);
  chmodSync(databasePath, 0o600);
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  initializeSchema(database);

  const selectHandle = database.prepare('SELECT * FROM feishu_reply_handles WHERE request_id = ?');
  const selectHandleByIngress = database.prepare('SELECT * FROM feishu_reply_handles WHERE ingress_id = ?');
  const selectPresence = database.prepare('SELECT * FROM feishu_presence_effects WHERE request_id = ?');
  const selectProjection = database.prepare(`
    SELECT * FROM feishu_progress_projections WHERE request_id = ? AND presentation_id = ?
  `);
  const selectProjectionEvent = database.prepare(`
    SELECT * FROM feishu_projection_events
    WHERE request_id = ? AND presentation_id = ? AND source_sequence = ?
  `);
  const selectHigherProjectionEvent = database.prepare(`
    SELECT source_sequence
    FROM feishu_projection_events
    WHERE request_id = ? AND presentation_id = ? AND source_sequence > ?
    ORDER BY source_sequence
    LIMIT 1
  `);

  const bind = database.transaction((input) => {
    const normalized = normalizeHandle(input);
    const byRequest = selectHandle.get(normalized.requestId);
    const byIngress = selectHandleByIngress.get(normalized.ingressId);
    if (byRequest && byIngress && byRequest.request_id !== byIngress.request_id) {
      throw domainError('IDENTITY_CONFLICT', 'reply handle identities belong to different requests');
    }
    const existing = byRequest ?? byIngress;
    if (existing) {
      if (existing.payload_hash !== normalized.payloadHash) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'reply handle identity belongs to different content');
      }
      return {
        created: false,
        handle: handleView(existing),
        presence: presenceView(selectPresence.get(existing.request_id)),
      };
    }

    const now = requireNow(clock);
    database.prepare(`
      INSERT INTO feishu_reply_handles (
        request_id, ingress_id, source_message_id, route_json,
        presentation_id, presence_id, payload_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.requestId,
      normalized.ingressId,
      normalized.sourceMessageId,
      serialize(normalized.route, 'reply handle.route'),
      normalized.presentationId,
      normalized.presenceId,
      normalized.payloadHash,
      now,
      now,
    );
    database.prepare(`
      INSERT INTO feishu_presence_effects (
        request_id, presence_id, status, add_effect_key, remove_effect_key,
        operation, operation_status, available_at, created_at, updated_at
      ) VALUES (?, ?, 'adding', ?, ?, 'add', 'pending', ?, ?, ?)
    `).run(
      normalized.requestId,
      normalized.presenceId,
      `presence:add:${normalized.requestId}`,
      `presence:remove:${normalized.requestId}`,
      now,
      now,
      now,
    );
    return {
      created: true,
      handle: handleView(selectHandle.get(normalized.requestId)),
      presence: presenceView(selectPresence.get(normalized.requestId)),
    };
  });

  const claimPresence = database.transaction(({ requestId, workerId, leaseMs }) => {
    const id = requireText(requestId, 'presence requestId');
    const owner = requireText(workerId, 'presence workerId', 256);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError('presence leaseMs must be a positive integer');
    }
    const now = requireNow(clock);
    const row = selectPresence.get(id);
    if (!row || !row.operation || !row.operation_status || row.available_at > now) return null;
    if (row.lease_until !== null && row.lease_until > now) return null;
    const needsReconcile = row.operation_status === 'inflight' || row.operation_status === 'unknown';
    const nextLeaseVersion = row.lease_version + 1;
    const claimedResult = database.prepare(`
      UPDATE feishu_presence_effects
      SET operation_status = 'inflight', attempt = attempt + 1,
          version = version + 1, lease_version = ?,
          lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE request_id = ? AND version = ?
    `).run(nextLeaseVersion, owner, now + leaseMs, now, id, row.version);
    if (claimedResult.changes !== 1) return null;
    const claimed = selectPresence.get(id);
    return {
      presence: presenceView(claimed),
      sourceMessageId: selectHandle.get(id).source_message_id,
      effectKey: claimed.operation === 'add' ? claimed.add_effect_key : claimed.remove_effect_key,
      needsReconcile,
      receipt: {
        requestId: id,
        workerId: owner,
        version: nextLeaseVersion,
      },
    };
  });

  function requirePresenceReceipt(receipt) {
    const value = requireRecord(receipt, 'presence receipt');
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
      throw new TypeError('presence receipt.version must be a positive integer');
    }
    return {
      requestId: requireText(value.requestId, 'presence receipt.requestId'),
      workerId: requireText(value.workerId, 'presence receipt.workerId', 256),
      version: value.version,
    };
  }

  const completePresence = database.transaction(({ receipt, reactionId = null }) => {
    const normalized = requirePresenceReceipt(receipt);
    const now = requireNow(clock);
    const row = selectPresence.get(normalized.requestId);
    if (
      !row
      || row.lease_version !== normalized.version
      || row.lease_owner !== normalized.workerId
      || row.operation_status !== 'inflight'
      || row.lease_until === null
      || row.lease_until <= now
    ) {
      throw domainError('LEASE_LOST', 'presence effect lease is no longer owned by this worker');
    }
    if (row.operation === 'add') {
      const id = requireText(reactionId, 'presence reactionId');
      if (row.finish_requested === 1) {
        database.prepare(`
          UPDATE feishu_presence_effects
          SET status = 'finishing', reaction_id = ?, operation = 'remove',
              operation_status = 'pending', attempt = 0, available_at = ?,
              lease_owner = NULL, lease_until = NULL, last_error = NULL,
              updated_at = ?, version = version + 1
          WHERE request_id = ?
        `).run(id, now, now, row.request_id);
      } else {
        database.prepare(`
          UPDATE feishu_presence_effects
          SET status = 'active', reaction_id = ?, operation = NULL,
              operation_status = NULL, lease_owner = NULL, lease_until = NULL,
              last_error = NULL, updated_at = ?, version = version + 1
          WHERE request_id = ?
        `).run(id, now, row.request_id);
      }
    } else {
      database.prepare(`
        UPDATE feishu_presence_effects
        SET status = 'finished', operation = NULL, operation_status = NULL,
            lease_owner = NULL, lease_until = NULL, last_error = NULL,
            updated_at = ?, finished_at = ?, version = version + 1
        WHERE request_id = ?
      `).run(now, now, row.request_id);
    }
    return presenceView(selectPresence.get(row.request_id));
  });

  const completeAbsentPresence = database.transaction(({ receipt }) => {
    const normalized = requirePresenceReceipt(receipt);
    const now = requireNow(clock);
    const row = selectPresence.get(normalized.requestId);
    if (
      !row
      || row.lease_version !== normalized.version
      || row.lease_owner !== normalized.workerId
      || row.operation_status !== 'inflight'
      || row.lease_until === null
      || row.lease_until <= now
      || row.operation !== 'add'
      || row.finish_requested !== 1
    ) {
      throw domainError('LEASE_LOST', 'absent presence effect is no longer owned by this worker');
    }
    database.prepare(`
      UPDATE feishu_presence_effects
      SET status = 'finished', operation = NULL, operation_status = NULL,
          lease_owner = NULL, lease_until = NULL, last_error = NULL,
          updated_at = ?, finished_at = ?, version = version + 1
      WHERE request_id = ?
    `).run(now, now, row.request_id);
    return presenceView(selectPresence.get(row.request_id));
  });

  const requestPresenceFinish = database.transaction(({ requestId, reason }) => {
    const id = requireText(requestId, 'presence finish.requestId');
    const finishReason = requireText(reason, 'presence finish.reason');
    const row = selectPresence.get(id);
    if (!row) throw domainError('PRESENCE_NOT_FOUND', 'reply presence does not exist');
    if (row.status === 'finished' || row.finish_requested === 1) {
      return presenceView(row);
    }
    const now = requireNow(clock);
    if (row.status === 'active') {
      database.prepare(`
        UPDATE feishu_presence_effects
        SET status = 'finishing', finish_requested = 1, finish_reason = ?,
            operation = 'remove', operation_status = 'pending', attempt = 0,
            available_at = ?, lease_owner = NULL, lease_until = NULL,
            updated_at = ?, version = version + 1
        WHERE request_id = ?
      `).run(finishReason, now, now, id);
    } else if (row.operation === 'add' && row.operation_status === 'pending') {
      database.prepare(`
        UPDATE feishu_presence_effects
        SET status = 'finished', finish_requested = 1, finish_reason = ?,
            operation = NULL, operation_status = NULL, updated_at = ?,
            finished_at = ?, version = version + 1
        WHERE request_id = ?
      `).run(finishReason, now, now, id);
    } else {
      database.prepare(`
        UPDATE feishu_presence_effects
        SET status = 'finishing', finish_requested = 1, finish_reason = ?,
            updated_at = ?, version = version + 1
        WHERE request_id = ?
      `).run(finishReason, now, id);
    }
    return presenceView(selectPresence.get(id));
  });

  const deferPresence = database.transaction(({
    receipt,
    outcome,
    error,
    retryAfterMs,
  }) => {
    const normalized = requirePresenceReceipt(receipt);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
      throw new TypeError('presence retryAfterMs must be a non-negative integer');
    }
    const now = requireNow(clock);
    const row = selectPresence.get(normalized.requestId);
    if (
      !row
      || row.lease_version !== normalized.version
      || row.lease_owner !== normalized.workerId
      || row.operation_status !== 'inflight'
      || row.lease_until === null
      || row.lease_until <= now
    ) {
      throw domainError('LEASE_LOST', 'presence effect lease is no longer owned by this worker');
    }
    if (outcome !== 'unknown' && outcome !== 'rejected') {
      throw new TypeError('presence deferred outcome is unsupported');
    }
    const message = String(error ?? outcome).slice(0, 4_096);
    const status = row.operation === 'remove' && outcome !== 'unknown'
      ? 'orphaned'
      : row.status;
    database.prepare(`
      UPDATE feishu_presence_effects
      SET status = ?, operation_status = ?, available_at = ?,
          lease_owner = NULL, lease_until = NULL, last_error = ?,
          updated_at = ?, version = version + 1
      WHERE request_id = ?
    `).run(
      status,
      outcome === 'unknown' ? 'unknown' : 'pending',
      now + retryAfterMs,
      message,
      now,
      row.request_id,
    );
    return presenceView(selectPresence.get(row.request_id));
  });

  const recordProjectionEvent = database.transaction((input) => {
    const event = normalizeProgressEvent(input);
    const handle = selectHandle.get(event.requestId);
    if (!handle) throw domainError('REPLY_HANDLE_NOT_FOUND', 'reply handle does not exist');
    if (handle.presentation_id !== event.presentationId) {
      throw domainError('PRESENTATION_ID_CONFLICT', 'request is bound to a different presentation');
    }
    const now = requireNow(clock);
    let projection = selectProjection.get(event.requestId, event.presentationId);
    if (!projection) {
      database.prepare(`
        INSERT INTO feishu_progress_projections (
          request_id, presentation_id, status, available_at, created_at, updated_at
        ) VALUES (?, ?, 'pending', ?, ?, ?)
      `).run(event.requestId, event.presentationId, now, now, now);
      projection = selectProjection.get(event.requestId, event.presentationId);
    }

    const existing = selectProjectionEvent.get(
      event.requestId,
      event.presentationId,
      event.sequence,
    );
    if (existing) {
      if (existing.event_hash !== event.eventHash) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          'projection sequence belongs to different event content',
        );
      }
      return {
        accepted: false,
        replayed: true,
        dropped: existing.projectable === 0,
        flushDue: projection.due_at !== null && projection.due_at <= now,
        projection: projectionView(projection),
      };
    }
    if (projection.terminal_sequence !== null && event.sequence > projection.terminal_sequence) {
      throw domainError('PROJECTION_AFTER_TERMINAL', 'projection event follows its terminal barrier');
    }
    if (
      event.terminal
      && projection.terminal_sequence !== null
      && projection.terminal_sequence !== event.sequence
    ) {
      throw domainError('TERMINAL_CONFLICT', 'projection already has a different terminal barrier');
    }
    if (
      event.terminal
      && selectHigherProjectionEvent.get(
        event.requestId,
        event.presentationId,
        event.sequence,
      )
    ) {
      throw domainError(
        'TERMINAL_CONFLICT',
        'projection observed a higher sequence before this terminal barrier',
      );
    }

    const projectable = event.sequence > projection.high_watermark ? 1 : 0;
    database.prepare(`
      INSERT INTO feishu_projection_events (
        request_id, presentation_id, source_sequence, event_hash, event_json,
        projectable, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.requestId,
      event.presentationId,
      event.sequence,
      event.eventHash,
      event.eventJson,
      projectable,
      now,
    );

    // Core's sequence spans the complete Run stream. Feishu subscribes only
    // to projection events, so its durable consumer checkpoint is the greatest
    // Core sequence observed, not a synthetic contiguous sequence beginning at
    // one. Missing RunAccepted/RunQueued/RunStarted events are not projection
    // gaps and must never block visible progress or a final barrier.
    const highWatermark = Math.max(projection.high_watermark, event.sequence);
    const terminalSequence = event.terminal ? event.sequence : projection.terminal_sequence;
    const dueAt = projectable === 1
      ? coalescer.dueAt({
        now,
        currentDueAt: projection.due_at,
        highWatermark,
        lastAppliedSequence: projection.last_applied_sequence,
        terminalSequence,
      })
      : projection.due_at;
    database.prepare(`
      UPDATE feishu_progress_projections
      SET high_watermark = ?, terminal_sequence = ?, due_at = ?,
          updated_at = ?, version = version + 1
      WHERE request_id = ? AND presentation_id = ?
    `).run(
      highWatermark,
      terminalSequence,
      dueAt,
      now,
      event.requestId,
      event.presentationId,
    );
    projection = selectProjection.get(event.requestId, event.presentationId);
    return {
      accepted: projectable === 1,
      replayed: false,
      dropped: projectable === 0,
      flushDue: projection.due_at !== null && projection.due_at <= now,
      projection: projectionView(projection),
    };
  });

  const claimProjections = database.transaction(({ workerId, leaseMs, limit }) => {
    const owner = requireText(workerId, 'projection workerId', 256);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError('projection leaseMs must be a positive integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('projection claim limit must be between 1 and 1000');
    }
    const now = requireNow(clock);
    const candidates = database.prepare(`
      SELECT request_id, presentation_id
      FROM feishu_progress_projections
      WHERE status != 'terminal'
        AND (
          (
            operation_status IS NOT NULL
            AND available_at <= ?
            AND (lease_until IS NULL OR lease_until <= ?)
          )
          OR (
            operation_status IS NULL
            AND due_at IS NOT NULL
            AND due_at <= ?
            AND high_watermark > last_applied_sequence
          )
        )
      ORDER BY
        CASE WHEN terminal_sequence IS NOT NULL THEN 0 ELSE 1 END,
        COALESCE(due_at, available_at),
        request_id,
        presentation_id
      LIMIT ?
    `).all(now, now, now, limit);
    const claims = [];

    for (const candidate of candidates) {
      let row = selectProjection.get(candidate.request_id, candidate.presentation_id);
      if (row.operation_status === null) {
        const events = database.prepare(`
          SELECT event_json
          FROM feishu_projection_events
          WHERE request_id = ? AND presentation_id = ?
            AND projectable = 1
            AND source_sequence > ? AND source_sequence <= ?
          ORDER BY source_sequence
        `).all(
          row.request_id,
          row.presentation_id,
          row.last_applied_sequence,
          row.high_watermark,
        ).map((eventRow) => JSON.parse(eventRow.event_json));
        if (events.length === 0) continue;
        const nextCardKitSequence = row.cardkit_sequence + 1;
        if (nextCardKitSequence > 2_147_483_647) {
          throw domainError('CARDKIT_SEQUENCE_EXHAUSTED', 'CardKit sequence exceeded 32-bit range');
        }
        let kind;
        if (!row.card_id) {
          kind = 'open';
        } else if (row.terminal_sequence !== null && row.terminal_sequence <= row.high_watermark) {
          kind = 'finalize';
        } else if (events.some((event) => event.type === 'FallbackRequested')) {
          kind = 'fallback';
        } else {
          kind = 'update';
        }
        const operationTuple = serialize([
          'feishu-projection-operation/v1',
          row.request_id,
          row.presentation_id,
          nextCardKitSequence,
        ], 'projection operation identity');
        const operationId = `projection:sha256:${fingerprint(operationTuple)}`;
        const reserved = database.prepare(`
          UPDATE feishu_progress_projections
          SET operation_id = ?, operation_kind = ?, operation_status = 'pending',
              operation_source_watermark = ?, operation_events_json = ?,
              cardkit_sequence = ?, attempt = 0, available_at = ?, due_at = NULL,
              updated_at = ?, version = version + 1
          WHERE request_id = ? AND presentation_id = ?
            AND version = ? AND operation_status IS NULL
        `).run(
          operationId,
          kind,
          row.high_watermark,
          serialize(events, 'projection operation events'),
          nextCardKitSequence,
          now,
          now,
          row.request_id,
          row.presentation_id,
          row.version,
        );
        if (reserved.changes !== 1) continue;
        row = selectProjection.get(row.request_id, row.presentation_id);
      }

      const needsReconcile = row.operation_status === 'inflight' || row.operation_status === 'unknown';
      const nextLeaseVersion = row.lease_version + 1;
      const claimedResult = database.prepare(`
        UPDATE feishu_progress_projections
        SET operation_status = 'inflight', attempt = attempt + 1,
            lease_owner = ?, lease_until = ?, updated_at = ?,
            version = version + 1, lease_version = ?
        WHERE request_id = ? AND presentation_id = ? AND version = ?
      `).run(
        owner,
        now + leaseMs,
        now,
        nextLeaseVersion,
        row.request_id,
        row.presentation_id,
        row.version,
      );
      if (claimedResult.changes !== 1) continue;
      const claimed = selectProjection.get(row.request_id, row.presentation_id);
      claims.push({
        projection: projectionView(claimed),
        needsReconcile,
        operation: {
          operationId: claimed.operation_id,
          requestId: claimed.request_id,
          presentationId: claimed.presentation_id,
          kind: claimed.operation_kind,
          sourceWatermark: claimed.operation_source_watermark,
          cardKitSequence: claimed.cardkit_sequence,
          cardId: claimed.card_id,
          events: JSON.parse(claimed.operation_events_json),
        },
        receipt: {
          requestId: claimed.request_id,
          presentationId: claimed.presentation_id,
          workerId: owner,
          version: nextLeaseVersion,
        },
      });
    }
    return claims;
  });

  function requireProjectionReceipt(receipt) {
    const value = requireRecord(receipt, 'projection receipt');
    if (!Number.isSafeInteger(value.version) || value.version < 1) {
      throw new TypeError('projection receipt.version must be a positive integer');
    }
    return {
      requestId: requireText(value.requestId, 'projection receipt.requestId'),
      presentationId: requireText(value.presentationId, 'projection receipt.presentationId'),
      workerId: requireText(value.workerId, 'projection receipt.workerId', 256),
      version: value.version,
    };
  }

  function leasedProjection(receipt) {
    const normalized = requireProjectionReceipt(receipt);
    const now = requireNow(clock);
    const row = selectProjection.get(normalized.requestId, normalized.presentationId);
    if (
      !row
      || row.lease_version !== normalized.version
      || row.lease_owner !== normalized.workerId
      || row.operation_status !== 'inflight'
      || row.lease_until === null
      || row.lease_until <= now
    ) {
      throw domainError('LEASE_LOST', 'projection lease is no longer owned by this worker');
    }
    return { row, now };
  }

  const completeProjection = database.transaction(({ receipt, cardId = null }) => {
    const { row, now } = leasedProjection(receipt);
    const opensBeforeTerminal = row.operation_kind === 'open'
      && row.terminal_sequence !== null
      && row.terminal_sequence <= row.operation_source_watermark;
    // CardKit has no create-and-finalize operation in the Phase A port. When
    // terminal is the first visible event, the open ACK binds the external
    // card identity but deliberately leaves the terminal consumer checkpoint
    // pending so the next, higher CardKit sequence can finalize that card.
    const appliedSequence = opensBeforeTerminal
      ? row.last_applied_sequence
      : row.operation_source_watermark;
    const terminal = row.terminal_sequence !== null && row.terminal_sequence <= appliedSequence;
    const dueAt = coalescer.dueAt({
      now,
      highWatermark: row.high_watermark,
      lastAppliedSequence: appliedSequence,
      terminalSequence: row.terminal_sequence,
    });
    database.prepare(`
      UPDATE feishu_progress_projections
      SET status = ?, last_applied_sequence = ?, card_id = COALESCE(?, card_id),
          due_at = ?, operation_id = NULL, operation_kind = NULL,
          operation_status = NULL, operation_source_watermark = NULL,
          operation_events_json = NULL, lease_owner = NULL, lease_until = NULL,
          last_error = NULL, updated_at = ?, version = version + 1
      WHERE request_id = ? AND presentation_id = ?
    `).run(
      terminal ? 'terminal' : 'active',
      appliedSequence,
      cardId,
      dueAt,
      now,
      row.request_id,
      row.presentation_id,
    );
    return projectionView(selectProjection.get(row.request_id, row.presentation_id));
  });

  const deferProjection = database.transaction(({
    receipt,
    outcome,
    error,
    retryAfterMs,
  }) => {
    const { row, now } = leasedProjection(receipt);
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
      throw new TypeError('projection retryAfterMs must be a non-negative integer');
    }
    if (outcome !== 'unknown' && outcome !== 'rejected') {
      throw new TypeError('projection deferred outcome is unsupported');
    }
    database.prepare(`
      UPDATE feishu_progress_projections
      SET status = 'degraded', operation_status = ?, available_at = ?,
          lease_owner = NULL, lease_until = NULL, last_error = ?,
          updated_at = ?, version = version + 1
      WHERE request_id = ? AND presentation_id = ?
    `).run(
      outcome === 'unknown' ? 'unknown' : 'pending',
      now + retryAfterMs,
      String(error ?? outcome).slice(0, 4_096),
      now,
      row.request_id,
      row.presentation_id,
    );
    return projectionView(selectProjection.get(row.request_id, row.presentation_id));
  });

  function listPresenceDue({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError('presence due limit must be between 1 and 1000');
      }
      const now = requireNow(clock);
      return database.prepare(`
        SELECT request_id
        FROM feishu_presence_effects
        WHERE operation IS NOT NULL
          AND operation_status IS NOT NULL
          AND available_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY available_at, request_id
        LIMIT ?
      `).all(now, now, limit).map((row) => row.request_id);
  }

  function observePresence({ requestId, kind }) {
    const id = requireText(requestId, 'presence observation.requestId');
    const observation = requireText(kind, 'presence observation.kind');
    if (!PRESENCE_OBSERVATIONS.has(observation)) {
      throw domainError('UNSUPPORTED_PRESENCE_OBSERVATION', 'presence observation is unsupported');
    }
    const row = selectPresence.get(id);
    if (!row) throw domainError('PRESENCE_NOT_FOUND', 'reply presence does not exist');
    if (observation === 'elapsed_over_120_seconds') {
      const now = requireNow(clock);
      database.prepare(`
        UPDATE feishu_presence_effects
        SET stale_observed_at = ?, updated_at = ?, version = version + 1
        WHERE request_id = ?
      `).run(now, now, id);
    }
    return presenceView(selectPresence.get(id));
  }

  function inspect(requestId) {
    const id = requireText(requestId, 'requestId');
    const handle = selectHandle.get(id);
    return {
      handle: handleView(handle),
      presence: presenceView(selectPresence.get(id)),
      projection: handle
        ? projectionView(selectProjection.get(id, handle.presentation_id))
        : null,
    };
  }

  // One physical SQLite ledger keeps the cross-store transaction boundary,
  // while coordinators receive only the capability they mutate.
  const replyHandles = Object.freeze({ bind });
  const presenceEffects = Object.freeze({
    claimPresence,
    completePresence,
    completeAbsentPresence,
    deferPresence,
    requestPresenceFinish,
    listPresenceDue,
    observePresence,
    inspectPresence(requestId) {
      return presenceView(selectPresence.get(requireText(requestId, 'requestId')));
    },
  });
  const progressProjections = Object.freeze({
    recordProjectionEvent,
    claimProjections,
    completeProjection,
    deferProjection,
  });

  return Object.freeze({
    replyHandles,
    presenceEffects,
    progressProjections,
    inspect,
    close() {
      database.close();
    },
  });
}
