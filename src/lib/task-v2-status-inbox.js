import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const REQUIRED_EVENT_FIELDS = Object.freeze(['event_id', 'task_id', 'app_id']);
const OPTIONAL_EVENT_FIELDS = Object.freeze(['event_types']);
const MAX_EVENT_ID_LENGTH = 512;
const MAX_JSON_BYTES = 1024 * 1024;
const LEGACY_MIGRATION_KEY = 'legacy-ndjson-v1';
const RECONCILIATION_BACKFILL_KEY = 'reconciliation-backfill-v1';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = MAX_EVENT_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) throw new TypeError(`${field} is too long`);
  return text;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function requireEpoch(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative Unix epoch millisecond`);
  }
  return value;
}

function serializeJson(value, field) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${field} must be JSON serializable: ${error.message}`);
  }
  if (serialized === undefined) throw new TypeError(`${field} must be JSON serializable`);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_BYTES) {
    throw new TypeError(`${field} exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return serialized;
}

function fingerprint(serialized) {
  return createHash('sha256').update(serialized).digest('hex');
}

function legacyFileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, bytes: stat.size, modifiedAt: stat.mtimeMs, inode: stat.ino };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, bytes: 0, modifiedAt: null, inode: null };
    }
    throw error;
  }
}

function normalizeEvent(value) {
  const event = requireRecord(value, 'status event');
  const keys = Object.keys(event);
  if (
    !REQUIRED_EVENT_FIELDS.every(key => keys.includes(key))
    || keys.some(key => !REQUIRED_EVENT_FIELDS.includes(key) && !OPTIONAL_EVENT_FIELDS.includes(key))
  ) {
    throw new TypeError('status event contains unsupported or missing fields');
  }
  let eventTypes;
  if (event.event_types !== undefined) {
    if (!Array.isArray(event.event_types) || event.event_types.length === 0) {
      throw new TypeError('status event.event_types must be a non-empty array');
    }
    eventTypes = event.event_types.map((eventType, index) => (
      requireText(eventType, `status event.event_types[${index}]`)
    ));
    if (new Set(eventTypes).size !== eventTypes.length) {
      throw new TypeError('status event.event_types must not contain duplicates');
    }
  }
  return {
    event_id: requireText(event.event_id, 'status event.event_id'),
    task_id: requireText(event.task_id, 'status event.task_id'),
    app_id: requireText(event.app_id, 'status event.app_id'),
    ...(eventTypes === undefined ? {} : { event_types: eventTypes }),
  };
}

function readLegacyFile(filePath, field) {
  const before = legacyFileStamp(filePath);
  const content = before.exists ? fs.readFileSync(filePath, 'utf8') : '';
  const stamp = legacyFileStamp(filePath);
  if (serializeJson(before, 'legacy status evidence stamp')
      !== serializeJson(stamp, 'legacy status evidence stamp')) {
    throw new TypeError(`${field} changed while it was being read`);
  }
  const records = content === '' ? [] : content
    .split('\n')
    .filter(line => line !== '')
    .map((line, index) => {
      try {
        return requireRecord(JSON.parse(line), `${field} record ${index + 1}`);
      } catch (error) {
        throw new TypeError(`${field} is corrupt at line ${index + 1}: ${error.message}`);
      }
    });
  return { exists: stamp.exists, content, records, fingerprint: fingerprint(content), stamp };
}

function readLegacyEvidence(directory) {
  const events = readLegacyFile(path.join(directory, 'events.ndjson'), 'status event journal');
  const settlements = readLegacyFile(
    path.join(directory, 'settlements.ndjson'),
    'status settlement journal',
  );
  const signature = serializeJson({
    events: { exists: events.exists, bytes: Buffer.byteLength(events.content), hash: events.fingerprint },
    settlements: {
      exists: settlements.exists,
      bytes: Buffer.byteLength(settlements.content),
      hash: settlements.fingerprint,
    },
  }, 'legacy status evidence signature');
  return { events, settlements, signature };
}

function assertLegacyEvidenceUnchanged(directory, expected) {
  const current = {
    events: legacyFileStamp(path.join(directory, 'events.ndjson')),
    settlements: legacyFileStamp(path.join(directory, 'settlements.ndjson')),
  };
  const original = { events: expected.events.stamp, settlements: expected.settlements.stamp };
  if (serializeJson(current, 'legacy status evidence stamp')
      !== serializeJson(original, 'legacy status evidence stamp')) {
    throw new TypeError('legacy status inbox evidence changed after SQLite migration');
  }
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_v2_status_inbox_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_v2_status_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      event_types_json TEXT,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'dead_letter')),
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      next_attempt_at INTEGER,
      last_error TEXT,
      result_json TEXT,
      enqueued_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_task_v2_status_pending
      ON task_v2_status_events(status, available_at, sequence);

    CREATE TABLE IF NOT EXISTS task_v2_status_reconciliations (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      event_types_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'dead_letter')),
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      next_attempt_at INTEGER,
      last_error TEXT,
      result_json TEXT,
      enqueued_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER,
      FOREIGN KEY (event_id) REFERENCES task_v2_status_events(event_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_task_v2_reconciliation_pending
      ON task_v2_status_reconciliations(status, available_at, enqueued_at, event_id);
  `);
}

function reconciliationTypes(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result.status === 'reconciliation_required'
    ? result.eventTypes
    : result.reconciliationEventTypes;
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('reconciliation event types must be a non-empty array');
  }
  const normalized = value.map((eventType, index) => (
    requireText(eventType, `reconciliation event types[${index}]`)
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError('reconciliation event types must not contain duplicates');
  }
  return normalized;
}

function hasReconciliationSignal(result) {
  return result?.status === 'reconciliation_required'
    || result?.reconciliationEventTypes !== undefined;
}

function enqueueReconciliation(database, row, result, timestamp) {
  const eventTypes = reconciliationTypes(result);
  if (eventTypes === null) return;
  const serialized = serializeJson(eventTypes, 'reconciliation event types');
  const existing = database.prepare(`
    SELECT event_types_json FROM task_v2_status_reconciliations WHERE event_id = ?
  `).get(row.event_id);
  if (existing) {
    if (existing.event_types_json !== serialized) {
      throw new TypeError(`status reconciliation identity conflict: ${row.event_id}`);
    }
    return;
  }
  database.prepare(`
    INSERT INTO task_v2_status_reconciliations (
      event_id, task_id, app_id, event_types_json, status,
      available_at, enqueued_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(row.event_id, row.task_id, row.app_id, serialized, timestamp, timestamp, timestamp);
}

function backfillReconciliations(database) {
  const backfill = database.transaction(() => {
    const completed = database.prepare(`
      SELECT 1 FROM task_v2_status_inbox_meta WHERE key = ?
    `).get(RECONCILIATION_BACKFILL_KEY);
    if (completed) return;
    const rows = database.prepare(`
      SELECT * FROM task_v2_status_events
      WHERE status = 'acknowledged' AND result_json IS NOT NULL
      ORDER BY sequence
    `).all();
    for (const row of rows) {
      enqueueReconciliation(
        database,
        row,
        JSON.parse(row.result_json),
        row.settled_at ?? row.updated_at,
      );
    }
    database.prepare(`
      INSERT INTO task_v2_status_inbox_meta (key, value) VALUES (?, 'complete')
    `).run(RECONCILIATION_BACKFILL_KEY);
  });
  backfill.immediate();
}

function migrateLegacyEvidence(database, directory) {
  const evidence = readLegacyEvidence(directory);
  const migrated = database.prepare(`
    SELECT value FROM task_v2_status_inbox_meta WHERE key = ?
  `).get(LEGACY_MIGRATION_KEY);
  if (migrated) {
    if (migrated.value !== evidence.signature) {
      throw new TypeError('legacy status inbox evidence changed after SQLite migration');
    }
    return evidence;
  }

  const events = new Map();
  for (const [index, rawRecord] of evidence.events.records.entries()) {
    const record = requireRecord(rawRecord, `legacy status event record ${index + 1}`);
    const event = normalizeEvent(record.event);
    const enqueuedAt = requireEpoch(
      record.enqueuedAt,
      `legacy status event record ${index + 1}.enqueuedAt`,
    );
    const serialized = serializeJson(event, 'legacy status event');
    const existing = events.get(event.event_id);
    if (existing && existing.serialized !== serialized) {
      throw new TypeError(`status event identity conflict: ${event.event_id}`);
    }
    if (!existing) events.set(event.event_id, { event, enqueuedAt, serialized, settlements: [] });
  }
  for (const [index, rawRecord] of evidence.settlements.records.entries()) {
    const record = requireRecord(rawRecord, `legacy status settlement record ${index + 1}`);
    const eventId = requireText(
      record.eventId,
      `legacy status settlement record ${index + 1}.eventId`,
    );
    const migratedEvent = events.get(eventId);
    if (!migratedEvent) {
      throw new TypeError(`legacy status settlement references unknown event: ${eventId}`);
    }
    if (record.type !== 'ack' && record.type !== 'fail') {
      throw new TypeError(`legacy status settlement record ${index + 1}.type is unsupported`);
    }
    if (migratedEvent.settlements.at(-1)?.type === 'ack') {
      throw new TypeError(`legacy status settlement appears after acknowledgement: ${eventId}`);
    }
    if (record.type === 'ack') {
      requireEpoch(record.settledAt, `legacy status settlement record ${index + 1}.settledAt`);
      serializeJson(record.result ?? null, 'legacy status acknowledgement result');
    } else {
      const failedAt = requireEpoch(
        record.failedAt,
        `legacy status settlement record ${index + 1}.failedAt`,
      );
      const nextAttemptAt = requireEpoch(
        record.nextAttemptAt,
        `legacy status settlement record ${index + 1}.nextAttemptAt`,
      );
      const attempts = requirePositiveInteger(
        record.attempts,
        `legacy status settlement record ${index + 1}.attempts`,
      );
      const expectedAttempts = migratedEvent.settlements.filter(
        settlement => settlement.type === 'fail',
      ).length + 1;
      if (attempts !== expectedAttempts) {
        throw new TypeError('legacy status settlement attempts do not match history');
      }
      if (nextAttemptAt < failedAt) {
        throw new TypeError('legacy status settlement retry precedes its failure');
      }
      if (typeof record.deadLettered !== 'boolean') {
        throw new TypeError(
          `legacy status settlement record ${index + 1}.deadLettered must be a boolean`,
        );
      }
    }
    migratedEvent.settlements.push(record);
  }

  const insertEvent = database.prepare(`
    INSERT INTO task_v2_status_events (
      event_id, task_id, app_id, event_types_json, request_fingerprint,
      status, attempt, available_at, next_attempt_at, last_error,
      result_json, enqueued_at, updated_at, settled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const migrate = database.transaction(() => {
    for (const { event, enqueuedAt, serialized, settlements } of events.values()) {
      const failures = settlements.filter(record => record.type === 'fail');
      const latest = settlements.at(-1);
      const acknowledged = latest?.type === 'ack';
      const deadLettered = latest?.type === 'fail' && latest.deadLettered;
      const updatedAt = latest?.type === 'ack'
        ? latest.settledAt
        : latest?.failedAt ?? enqueuedAt;
      insertEvent.run(
        event.event_id,
        event.task_id,
        event.app_id,
        event.event_types === undefined ? null : serializeJson(event.event_types, 'event types'),
        fingerprint(serialized),
        acknowledged ? 'acknowledged' : deadLettered ? 'dead_letter' : 'pending',
        failures.length,
        latest?.type === 'fail' && !deadLettered ? latest.nextAttemptAt : updatedAt,
        latest?.type === 'fail' ? latest.nextAttemptAt : null,
        latest?.type === 'fail' ? String(latest.error ?? 'unknown error').slice(0, 4_096) : null,
        acknowledged ? serializeJson(latest.result ?? null, 'legacy status result') : null,
        enqueuedAt,
        updatedAt,
        acknowledged || deadLettered ? updatedAt : null,
      );
    }
    database.prepare(`
      INSERT INTO task_v2_status_inbox_meta (key, value) VALUES (?, ?)
    `).run(LEGACY_MIGRATION_KEY, evidence.signature);
  });
  migrate.immediate();
  const migratedEvidence = readLegacyEvidence(directory);
  if (migratedEvidence.signature !== evidence.signature) {
    throw new TypeError('legacy status inbox evidence changed during SQLite migration');
  }
  return migratedEvidence;
}

function eventFromRow(row) {
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    app_id: row.app_id,
    ...(row.event_types_json === null ? {} : { event_types: JSON.parse(row.event_types_json) }),
  };
}

/**
 * Durable Task v2 status inbox backed by one indexed SQLite row per event.
 * Legacy append-only journals are validated and migrated once; they remain
 * untouched as audit evidence and any later legacy write fails closed.
 */
export function createTaskV2StatusInbox({ directory, clock = Date.now } = {}) {
  const inboxDirectory = path.resolve(requireText(directory, 'directory', 4_096));
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  fs.mkdirSync(inboxDirectory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(inboxDirectory, 'status-inbox.db');
  const database = new Database(databasePath);
  let legacyEvidence;
  try {
    fs.chmodSync(databasePath, 0o600);
    database.pragma('busy_timeout = 5000');
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.pragma('foreign_keys = ON');
    initializeSchema(database);
    legacyEvidence = migrateLegacyEvidence(database, inboxDirectory);
    backfillReconciliations(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const selectEvent = database.prepare(`
    SELECT * FROM task_v2_status_events WHERE event_id = ?
  `);
  const selectReconciliation = database.prepare(`
    SELECT * FROM task_v2_status_reconciliations WHERE event_id = ?
  `);

  function now() {
    return requireEpoch(clock(), 'clock result');
  }

  function withLegacyGuard(operation) {
    assertLegacyEvidenceUnchanged(inboxDirectory, legacyEvidence);
    const result = operation();
    assertLegacyEvidenceUnchanged(inboxDirectory, legacyEvidence);
    return result;
  }

  function toView(row) {
    if (!row) return null;
    return {
      event: eventFromRow(row),
      status: row.status === 'pending'
        && row.next_attempt_at !== null
        && row.next_attempt_at > now()
        ? 'retry_wait'
        : row.status,
      attempts: row.attempt,
      nextAttemptAt: row.next_attempt_at,
      error: row.last_error,
      result: row.result_json === null ? null : JSON.parse(row.result_json),
    };
  }

  function toReconciliationView(row) {
    if (!row) return null;
    return {
      event: eventFromRow(row),
      status: row.status === 'pending'
        && row.next_attempt_at !== null
        && row.next_attempt_at > now()
        ? 'retry_wait'
        : row.status,
      attempts: row.attempt,
      nextAttemptAt: row.next_attempt_at,
      error: row.last_error,
      result: row.result_json === null ? null : JSON.parse(row.result_json),
    };
  }

  const enqueueTransaction = database.transaction((eventInput) => {
    const event = normalizeEvent(eventInput);
    const serialized = serializeJson(event, 'status event');
    const requestFingerprint = fingerprint(serialized);
    const existing = selectEvent.get(event.event_id);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new TypeError(`status event identity conflict: ${event.event_id}`);
      }
      return { created: false, event };
    }
    const timestamp = now();
    database.prepare(`
      INSERT INTO task_v2_status_events (
        event_id, task_id, app_id, event_types_json, request_fingerprint,
        status, available_at, enqueued_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      event.event_id,
      event.task_id,
      event.app_id,
      event.event_types === undefined ? null : serializeJson(event.event_types, 'event types'),
      requestFingerprint,
      timestamp,
      timestamp,
      timestamp,
    );
    return { created: true, event };
  });

  const acknowledgeTransaction = database.transaction(({ eventId, result }) => {
    const normalizedEventId = requireText(eventId, 'eventId');
    const current = selectEvent.get(normalizedEventId);
    if (!current) throw new TypeError(`status event not found: ${normalizedEventId}`);
    if (current.status === 'acknowledged') {
      enqueueReconciliation(database, current, JSON.parse(current.result_json), current.settled_at);
      return toView(current);
    }
    const timestamp = now();
    enqueueReconciliation(database, current, result, timestamp);
    database.prepare(`
      UPDATE task_v2_status_events
      SET status = 'acknowledged', result_json = ?, available_at = ?,
          next_attempt_at = NULL, last_error = NULL, updated_at = ?, settled_at = ?
      WHERE event_id = ?
    `).run(serializeJson(result ?? null, 'status result'), timestamp, timestamp, timestamp, normalizedEventId);
    return toView(selectEvent.get(normalizedEventId));
  });

  const failTransaction = database.transaction(({ eventId, error, retryAfterMs, maxAttempts }) => {
    const normalizedEventId = requireText(eventId, 'eventId');
    requirePositiveInteger(retryAfterMs, 'retryAfterMs');
    requirePositiveInteger(maxAttempts, 'maxAttempts');
    const current = selectEvent.get(normalizedEventId);
    if (!current) throw new TypeError(`status event not found: ${normalizedEventId}`);
    if (current.status === 'acknowledged' || current.status === 'dead_letter') {
      return toView(current);
    }
    const timestamp = now();
    const attempts = current.attempt + 1;
    const deadLettered = attempts >= maxAttempts || error?.retryable === false;
    const nextAttemptAt = timestamp + retryAfterMs;
    const detail = [...(error?.stack || error?.message || String(error))].slice(0, 4_096).join('');
    database.prepare(`
      UPDATE task_v2_status_events
      SET status = ?, attempt = ?, available_at = ?, next_attempt_at = ?,
          last_error = ?, updated_at = ?, settled_at = ?
      WHERE event_id = ?
    `).run(
      deadLettered ? 'dead_letter' : 'pending',
      attempts,
      deadLettered ? timestamp : nextAttemptAt,
      nextAttemptAt,
      detail,
      timestamp,
      deadLettered ? timestamp : null,
      normalizedEventId,
    );
    return toView(selectEvent.get(normalizedEventId));
  });

  const acknowledgeReconciliation = database.transaction(({ eventId, result }) => {
    const normalizedEventId = requireText(eventId, 'reconciliation eventId');
    const current = selectReconciliation.get(normalizedEventId);
    if (!current) throw new TypeError(`status reconciliation not found: ${normalizedEventId}`);
    if (current.status === 'acknowledged') return toReconciliationView(current);
    const timestamp = now();
    database.prepare(`
      UPDATE task_v2_status_reconciliations
      SET status = 'acknowledged', result_json = ?, available_at = ?,
          next_attempt_at = NULL, last_error = NULL, updated_at = ?, settled_at = ?
      WHERE event_id = ?
    `).run(
      serializeJson(result ?? null, 'status reconciliation result'),
      timestamp,
      timestamp,
      timestamp,
      normalizedEventId,
    );
    return toReconciliationView(selectReconciliation.get(normalizedEventId));
  });

  const failReconciliation = database.transaction(({
    eventId, error, retryAfterMs, maxAttempts,
  }) => {
    const normalizedEventId = requireText(eventId, 'reconciliation eventId');
    requirePositiveInteger(retryAfterMs, 'reconciliation retryAfterMs');
    requirePositiveInteger(maxAttempts, 'reconciliation maxAttempts');
    const current = selectReconciliation.get(normalizedEventId);
    if (!current) throw new TypeError(`status reconciliation not found: ${normalizedEventId}`);
    if (current.status === 'acknowledged' || current.status === 'dead_letter') {
      return toReconciliationView(current);
    }
    const timestamp = now();
    const attempts = current.attempt + 1;
    const deadLettered = attempts >= maxAttempts || error?.retryable === false;
    const nextAttemptAt = timestamp + retryAfterMs;
    const detail = [...(error?.stack || error?.message || String(error))].slice(0, 4_096).join('');
    database.prepare(`
      UPDATE task_v2_status_reconciliations
      SET status = ?, attempt = ?, available_at = ?, next_attempt_at = ?,
          last_error = ?, updated_at = ?, settled_at = ?
      WHERE event_id = ?
    `).run(
      deadLettered ? 'dead_letter' : 'pending',
      attempts,
      deadLettered ? timestamp : nextAttemptAt,
      nextAttemptAt,
      detail,
      timestamp,
      deadLettered ? timestamp : null,
      normalizedEventId,
    );
    return toReconciliationView(selectReconciliation.get(normalizedEventId));
  });

  return Object.freeze({
    enqueue(eventInput) {
      return withLegacyGuard(() => enqueueTransaction.immediate(eventInput));
    },
    pending({ limit = 25 } = {}) {
      requirePositiveInteger(limit, 'limit');
      return withLegacyGuard(() => database.prepare(`
        SELECT * FROM task_v2_status_events
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY sequence
        LIMIT ?
      `).all(now(), limit).map(eventFromRow));
    },
    ack(input = {}) {
      return withLegacyGuard(() => acknowledgeTransaction.immediate(input));
    },
    fail(input = {}) {
      return withLegacyGuard(() => failTransaction.immediate(input));
    },
    query({ eventId } = {}) {
      return withLegacyGuard(() => toView(selectEvent.get(requireText(eventId, 'eventId'))));
    },
    pendingReconciliations({ limit = 25 } = {}) {
      requirePositiveInteger(limit, 'limit');
      return withLegacyGuard(() => database.prepare(`
        SELECT * FROM task_v2_status_reconciliations
        WHERE status = 'pending' AND available_at <= ?
        ORDER BY enqueued_at, event_id
        LIMIT ?
      `).all(now(), limit).map(eventFromRow));
    },
    ackReconciliation(input = {}) {
      return withLegacyGuard(() => acknowledgeReconciliation.immediate(input));
    },
    failReconciliation(input = {}) {
      return withLegacyGuard(() => failReconciliation.immediate(input));
    },
    queryReconciliation({ eventId } = {}) {
      return withLegacyGuard(() => toReconciliationView(selectReconciliation.get(
        requireText(eventId, 'reconciliation eventId'),
      )));
    },
    close() {
      database.close();
    },
  });
}

export async function processTaskV2StatusInboxOnce({
  inbox,
  handler,
  reconciler,
  limit = 25,
  retryAfterMs = 5_000,
  maxAttempts = 5,
} = {}) {
  if (!inbox || typeof inbox.pending !== 'function'
      || typeof inbox.ack !== 'function' || typeof inbox.fail !== 'function') {
    throw new TypeError('inbox must provide pending, ack, and fail');
  }
  if (!handler || typeof handler.handle !== 'function') {
    throw new TypeError('handler.handle must be a function');
  }
  if (reconciler !== undefined && (!reconciler || typeof reconciler.handle !== 'function')) {
    throw new TypeError('reconciler.handle must be a function');
  }
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(retryAfterMs, 'retryAfterMs');
  requirePositiveInteger(maxAttempts, 'maxAttempts');
  const events = inbox.pending({ limit });
  if (!Array.isArray(events)) throw new TypeError('inbox.pending must return an array');
  const summary = {
    claimed: events.length,
    acknowledged: 0,
    retryWaiting: 0,
    deadLettered: 0,
  };
  const hasReconciliationInbox = typeof inbox.pendingReconciliations === 'function'
    && typeof inbox.ackReconciliation === 'function'
    && typeof inbox.failReconciliation === 'function';
  for (const event of events) {
    try {
      const result = await handler.handle(event);
      if (reconciler !== undefined && hasReconciliationSignal(result) && !hasReconciliationInbox) {
        throw new TypeError('status inbox cannot persist required reconciliation work');
      }
      inbox.ack({ eventId: event.event_id, result });
      summary.acknowledged += 1;
    } catch (error) {
      const failed = inbox.fail({
        eventId: event.event_id,
        error,
        retryAfterMs,
        maxAttempts,
      });
      if (failed.status === 'dead_letter') summary.deadLettered += 1;
      else summary.retryWaiting += 1;
    }
  }
  if (reconciler === undefined) return Object.freeze(summary);
  if (!hasReconciliationInbox) return Object.freeze(summary);
  const work = inbox.pendingReconciliations({ limit });
  if (!Array.isArray(work)) {
    throw new TypeError('inbox.pendingReconciliations must return an array');
  }
  const reconciliation = {
    claimed: work.length,
    acknowledged: 0,
    retryWaiting: 0,
    deadLettered: 0,
  };
  for (const event of work) {
    try {
      const result = await reconciler.handle(event);
      inbox.ackReconciliation({ eventId: event.event_id, result });
      reconciliation.acknowledged += 1;
    } catch (error) {
      const failed = inbox.failReconciliation({
        eventId: event.event_id,
        error,
        retryAfterMs,
        maxAttempts,
      });
      if (failed.status === 'dead_letter') reconciliation.deadLettered += 1;
      else reconciliation.retryWaiting += 1;
    }
  }
  return Object.freeze({ ...summary, reconciliation: Object.freeze(reconciliation) });
}
