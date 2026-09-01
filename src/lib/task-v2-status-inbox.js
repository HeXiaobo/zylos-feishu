import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const REQUIRED_EVENT_FIELDS = Object.freeze(['event_id', 'task_id', 'app_id']);
const OPTIONAL_EVENT_FIELDS = Object.freeze([
  'event_types',
  'logical_key',
  'payload_hash',
  'payload',
]);
const MAX_EVENT_ID_LENGTH = 512;
const MAX_JSON_BYTES = 1024 * 1024;
const LEGACY_MIGRATION_KEY = 'legacy-ndjson-v1';
const RECONCILIATION_BACKFILL_KEY = 'reconciliation-backfill-v1';
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_RETRY_INTERVAL_MS = 10;
const sqliteRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeReceipt(value, field) {
  const receipt = requireRecord(value, field);
  return {
    eventId: requireText(receipt.eventId, `${field}.eventId`),
    workerId: requireText(receipt.workerId, `${field}.workerId`),
    version: requirePositiveInteger(receipt.version, `${field}.version`),
  };
}

function retrySqliteBusy(operation) {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (
        error?.code !== 'SQLITE_BUSY'
        && error?.code !== 'SQLITE_LOCKED'
      ) throw error;
      if (Date.now() >= deadline) throw error;
      Atomics.wait(sqliteRetrySignal, 0, 0, SQLITE_RETRY_INTERVAL_MS);
    }
  }
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function canonicalPayloadHash(value) {
  return `sha256:${fingerprint(serializeJson(canonicalize(value), 'status event.payload'))}`;
}

function redactedError(error) {
  return JSON.stringify({
    code: typeof error?.code === 'string' && error.code.trim() !== ''
      ? error.code.slice(0, 128)
      : 'TASK_STATUS_FAILED',
    retryable: error?.retryable !== false,
  });
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
  const hasLogicalIdentity = event.logical_key !== undefined
    || event.payload_hash !== undefined
    || event.payload !== undefined;
  let logicalIdentity = {};
  if (hasLogicalIdentity) {
    if (event.logical_key === undefined
        || event.payload_hash === undefined
        || event.payload === undefined) {
      throw new TypeError('status event logical identity fields must be provided together');
    }
    const payloadHash = requireText(event.payload_hash, 'status event.payload_hash');
    if (!/^sha256:[a-f0-9]{64}$/.test(payloadHash)) {
      throw new TypeError('status event.payload_hash must be a sha256 digest');
    }
    const payload = structuredClone(requireRecord(event.payload, 'status event.payload'));
    if (payloadHash !== canonicalPayloadHash(payload)) {
      throw domainError(
        'IDEMPOTENCY_CONFLICT',
        'status event.payload_hash does not match canonical payload',
      );
    }
    logicalIdentity = {
      logical_key: requireText(event.logical_key, 'status event.logical_key'),
      payload_hash: payloadHash,
      payload,
    };
  }
  return {
    event_id: requireText(event.event_id, 'status event.event_id'),
    task_id: requireText(event.task_id, 'status event.task_id'),
    app_id: requireText(event.app_id, 'status event.app_id'),
    ...(eventTypes === undefined ? {} : { event_types: eventTypes }),
    ...logicalIdentity,
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
  const initialize = database.transaction(() => {
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
      event_json TEXT,
      logical_key TEXT,
      payload_hash TEXT,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'dead_letter')),
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      next_attempt_at INTEGER,
      last_error TEXT,
      result_json TEXT,
      enqueued_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      settled_at INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      worker_id TEXT,
      lease_until INTEGER
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
      version INTEGER NOT NULL DEFAULT 1,
      worker_id TEXT,
      lease_until INTEGER,
      FOREIGN KEY (event_id) REFERENCES task_v2_status_events(event_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_task_v2_reconciliation_pending
      ON task_v2_status_reconciliations(status, available_at, enqueued_at, event_id);
  `);

    const statusColumns = new Set(database.prepare(
      'PRAGMA table_info(task_v2_status_events)',
    ).all().map(column => column.name));
    if (!statusColumns.has('version')) {
      database.exec('ALTER TABLE task_v2_status_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    }
    if (!statusColumns.has('worker_id')) {
      database.exec('ALTER TABLE task_v2_status_events ADD COLUMN worker_id TEXT');
    }
    if (!statusColumns.has('lease_until')) {
      database.exec('ALTER TABLE task_v2_status_events ADD COLUMN lease_until INTEGER');
    }
    if (!statusColumns.has('event_json')) {
      database.exec('ALTER TABLE task_v2_status_events ADD COLUMN event_json TEXT');
    }
    if (!statusColumns.has('logical_key')) {
      database.exec('ALTER TABLE task_v2_status_events ADD COLUMN logical_key TEXT');
    }
    if (!statusColumns.has('payload_hash')) {
      database.exec('ALTER TABLE task_v2_status_events ADD COLUMN payload_hash TEXT');
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_v2_status_logical_identity
      ON task_v2_status_events(logical_key)
      WHERE logical_key IS NOT NULL
    `);
    const reconciliationColumns = new Set(database.prepare(
      'PRAGMA table_info(task_v2_status_reconciliations)',
    ).all().map(column => column.name));
    if (!reconciliationColumns.has('version')) {
      database.exec('ALTER TABLE task_v2_status_reconciliations ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    }
    if (!reconciliationColumns.has('worker_id')) {
      database.exec('ALTER TABLE task_v2_status_reconciliations ADD COLUMN worker_id TEXT');
    }
    if (!reconciliationColumns.has('lease_until')) {
      database.exec('ALTER TABLE task_v2_status_reconciliations ADD COLUMN lease_until INTEGER');
    }
  });
  initialize.immediate();
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
    const migrated = database.prepare(`
      SELECT value FROM task_v2_status_inbox_meta WHERE key = ?
    `).get(LEGACY_MIGRATION_KEY);
    if (migrated) {
      if (migrated.value !== evidence.signature) {
        throw new TypeError('legacy status inbox evidence changed after SQLite migration');
      }
      return;
    }
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
        latest?.type === 'fail'
          ? redactedError({ code: 'LEGACY_FAILURE', retryable: !latest.deadLettered })
          : null,
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
  if (row.event_json !== undefined && row.event_json !== null) {
    return JSON.parse(row.event_json);
  }
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
  const database = new Database(databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  let legacyEvidence;
  try {
    fs.chmodSync(databasePath, 0o600);
    database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    retrySqliteBusy(() => database.pragma('journal_mode = WAL'));
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
  const selectLogicalEvent = database.prepare(`
    SELECT * FROM task_v2_status_events WHERE logical_key = ?
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
      status: row.status === 'pending' && row.worker_id !== null && row.lease_until > now()
        ? 'leased'
        : row.status === 'pending'
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
      status: row.status === 'pending' && row.worker_id !== null && row.lease_until > now()
        ? 'leased'
        : row.status === 'pending'
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

  function toClaim(row) {
    return Object.freeze({
      event: Object.freeze(eventFromRow(row)),
      attempt: row.attempt,
      leaseUntil: row.lease_until,
      receipt: Object.freeze({
        eventId: row.event_id,
        workerId: row.worker_id,
        version: row.version,
      }),
    });
  }

  const enqueueTransaction = database.transaction((eventInput) => {
    const event = normalizeEvent(eventInput);
    const serialized = serializeJson(event, 'status event');
    const requestFingerprint = fingerprint(serialized);
    const existing = selectEvent.get(event.event_id);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `status event identity conflict: ${event.event_id}`,
        );
      }
      return { created: false, event };
    }
    if (event.logical_key !== undefined) {
      const logical = selectLogicalEvent.get(event.logical_key);
      if (logical) {
        if (logical.payload_hash !== event.payload_hash) {
          throw domainError(
            'IDEMPOTENCY_CONFLICT',
            `status event logical identity conflict: ${event.logical_key}`,
          );
        }
        return { created: false, event: eventFromRow(logical) };
      }
    }
    const timestamp = now();
    database.prepare(`
      INSERT INTO task_v2_status_events (
        event_id, task_id, app_id, event_types_json, event_json,
        logical_key, payload_hash, request_fingerprint,
        status, available_at, enqueued_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      event.event_id,
      event.task_id,
      event.app_id,
      event.event_types === undefined ? null : serializeJson(event.event_types, 'event types'),
      serializeJson(event, 'status event'),
      event.logical_key ?? null,
      event.payload_hash ?? null,
      requestFingerprint,
      timestamp,
      timestamp,
      timestamp,
    );
    return { created: true, event };
  });

  const claimTransaction = database.transaction(({ workerId, leaseMs, limit }) => {
    const normalizedWorkerId = requireText(workerId, 'status workerId');
    requirePositiveInteger(leaseMs, 'status leaseMs');
    requirePositiveInteger(limit, 'status claim limit');
    const timestamp = now();
    const leaseUntil = timestamp + leaseMs;
    const candidates = database.prepare(`
      SELECT event_id, version
      FROM task_v2_status_events
      WHERE status = 'pending' AND available_at <= ?
        AND (worker_id IS NULL OR lease_until <= ?)
      ORDER BY sequence
      LIMIT ?
    `).all(timestamp, timestamp, limit);
    const update = database.prepare(`
      UPDATE task_v2_status_events
      SET worker_id = ?, lease_until = ?, version = version + 1, updated_at = ?
      WHERE event_id = ? AND version = ? AND status = 'pending' AND available_at <= ?
        AND (worker_id IS NULL OR lease_until <= ?)
    `);
    const claimed = [];
    for (const candidate of candidates) {
      const changed = update.run(
        normalizedWorkerId,
        leaseUntil,
        timestamp,
        candidate.event_id,
        candidate.version,
        timestamp,
        timestamp,
      );
      if (changed.changes === 1) claimed.push(toClaim(selectEvent.get(candidate.event_id)));
    }
    return claimed;
  });

  const claimReconciliations = database.transaction(({ workerId, leaseMs, limit }) => {
    const normalizedWorkerId = requireText(workerId, 'reconciliation workerId');
    requirePositiveInteger(leaseMs, 'reconciliation leaseMs');
    requirePositiveInteger(limit, 'reconciliation claim limit');
    const timestamp = now();
    const leaseUntil = timestamp + leaseMs;
    const candidates = database.prepare(`
      SELECT event_id, version
      FROM task_v2_status_reconciliations
      WHERE status = 'pending' AND available_at <= ?
        AND (worker_id IS NULL OR lease_until <= ?)
      ORDER BY enqueued_at, event_id
      LIMIT ?
    `).all(timestamp, timestamp, limit);
    const update = database.prepare(`
      UPDATE task_v2_status_reconciliations
      SET worker_id = ?, lease_until = ?, version = version + 1, updated_at = ?
      WHERE event_id = ? AND version = ? AND status = 'pending' AND available_at <= ?
        AND (worker_id IS NULL OR lease_until <= ?)
    `);
    const claimed = [];
    for (const candidate of candidates) {
      const changed = update.run(
        normalizedWorkerId,
        leaseUntil,
        timestamp,
        candidate.event_id,
        candidate.version,
        timestamp,
        timestamp,
      );
      if (changed.changes === 1) {
        claimed.push(toClaim(selectReconciliation.get(candidate.event_id)));
      }
    }
    return claimed;
  });

  const acknowledgeTransaction = database.transaction(({ receipt, result }) => {
    const normalizedReceipt = normalizeReceipt(receipt, 'status receipt');
    const current = selectEvent.get(normalizedReceipt.eventId);
    if (!current) throw domainError('INBOX_NOT_FOUND', `status event not found: ${normalizedReceipt.eventId}`);
    const timestamp = now();
    if (
      current.status !== 'pending'
      || current.worker_id !== normalizedReceipt.workerId
      || current.version !== normalizedReceipt.version
      || current.lease_until <= timestamp
    ) {
      throw domainError('LEASE_LOST', 'status processing lease is no longer current');
    }
    enqueueReconciliation(database, current, result, timestamp);
    database.prepare(`
      UPDATE task_v2_status_events
      SET status = 'acknowledged', result_json = ?, available_at = ?,
          next_attempt_at = NULL, last_error = NULL, updated_at = ?, settled_at = ?,
          version = version + 1, worker_id = NULL, lease_until = NULL
      WHERE event_id = ? AND status = 'pending' AND worker_id = ? AND version = ?
    `).run(
      serializeJson(result ?? null, 'status result'),
      timestamp,
      timestamp,
      timestamp,
      normalizedReceipt.eventId,
      normalizedReceipt.workerId,
      normalizedReceipt.version,
    );
    return toView(selectEvent.get(normalizedReceipt.eventId));
  });

  const failTransaction = database.transaction(({ receipt, error, retryAfterMs, maxAttempts }) => {
    const normalizedReceipt = normalizeReceipt(receipt, 'status receipt');
    requirePositiveInteger(retryAfterMs, 'retryAfterMs');
    requirePositiveInteger(maxAttempts, 'maxAttempts');
    const current = selectEvent.get(normalizedReceipt.eventId);
    if (!current) throw domainError('INBOX_NOT_FOUND', `status event not found: ${normalizedReceipt.eventId}`);
    const timestamp = now();
    if (
      current.status !== 'pending'
      || current.worker_id !== normalizedReceipt.workerId
      || current.version !== normalizedReceipt.version
      || current.lease_until <= timestamp
    ) {
      throw domainError('LEASE_LOST', 'status processing lease is no longer current');
    }
    const attempts = current.attempt + 1;
    const deadLettered = attempts >= maxAttempts || error?.retryable === false;
    const nextAttemptAt = timestamp + retryAfterMs;
    const detail = redactedError(error);
    database.prepare(`
      UPDATE task_v2_status_events
      SET status = ?, attempt = ?, available_at = ?, next_attempt_at = ?,
          last_error = ?, updated_at = ?, settled_at = ?, version = version + 1,
          worker_id = NULL, lease_until = NULL
      WHERE event_id = ? AND status = 'pending' AND worker_id = ? AND version = ?
    `).run(
      deadLettered ? 'dead_letter' : 'pending',
      attempts,
      deadLettered ? timestamp : nextAttemptAt,
      nextAttemptAt,
      detail,
      timestamp,
      deadLettered ? timestamp : null,
      normalizedReceipt.eventId,
      normalizedReceipt.workerId,
      normalizedReceipt.version,
    );
    return toView(selectEvent.get(normalizedReceipt.eventId));
  });

  const acknowledgeReconciliation = database.transaction(({ receipt, result }) => {
    const normalizedReceipt = normalizeReceipt(receipt, 'reconciliation receipt');
    const current = selectReconciliation.get(normalizedReceipt.eventId);
    if (!current) {
      throw domainError(
        'INBOX_NOT_FOUND',
        `status reconciliation not found: ${normalizedReceipt.eventId}`,
      );
    }
    const timestamp = now();
    if (
      current.status !== 'pending'
      || current.worker_id !== normalizedReceipt.workerId
      || current.version !== normalizedReceipt.version
      || current.lease_until <= timestamp
    ) {
      throw domainError('LEASE_LOST', 'status reconciliation lease is no longer current');
    }
    database.prepare(`
      UPDATE task_v2_status_reconciliations
      SET status = 'acknowledged', result_json = ?, available_at = ?,
          next_attempt_at = NULL, last_error = NULL, updated_at = ?, settled_at = ?,
          version = version + 1, worker_id = NULL, lease_until = NULL
      WHERE event_id = ? AND status = 'pending' AND worker_id = ? AND version = ?
    `).run(
      serializeJson(result ?? null, 'status reconciliation result'),
      timestamp,
      timestamp,
      timestamp,
      normalizedReceipt.eventId,
      normalizedReceipt.workerId,
      normalizedReceipt.version,
    );
    return toReconciliationView(selectReconciliation.get(normalizedReceipt.eventId));
  });

  const failReconciliation = database.transaction(({
    receipt, error, retryAfterMs, maxAttempts,
  }) => {
    const normalizedReceipt = normalizeReceipt(receipt, 'reconciliation receipt');
    requirePositiveInteger(retryAfterMs, 'reconciliation retryAfterMs');
    requirePositiveInteger(maxAttempts, 'reconciliation maxAttempts');
    const current = selectReconciliation.get(normalizedReceipt.eventId);
    if (!current) {
      throw domainError(
        'INBOX_NOT_FOUND',
        `status reconciliation not found: ${normalizedReceipt.eventId}`,
      );
    }
    const timestamp = now();
    if (
      current.status !== 'pending'
      || current.worker_id !== normalizedReceipt.workerId
      || current.version !== normalizedReceipt.version
      || current.lease_until <= timestamp
    ) {
      throw domainError('LEASE_LOST', 'status reconciliation lease is no longer current');
    }
    const attempts = current.attempt + 1;
    const deadLettered = attempts >= maxAttempts || error?.retryable === false;
    const nextAttemptAt = timestamp + retryAfterMs;
    const detail = redactedError(error);
    database.prepare(`
      UPDATE task_v2_status_reconciliations
      SET status = ?, attempt = ?, available_at = ?, next_attempt_at = ?,
          last_error = ?, updated_at = ?, settled_at = ?, version = version + 1,
          worker_id = NULL, lease_until = NULL
      WHERE event_id = ? AND status = 'pending' AND worker_id = ? AND version = ?
    `).run(
      deadLettered ? 'dead_letter' : 'pending',
      attempts,
      deadLettered ? timestamp : nextAttemptAt,
      nextAttemptAt,
      detail,
      timestamp,
      deadLettered ? timestamp : null,
      normalizedReceipt.eventId,
      normalizedReceipt.workerId,
      normalizedReceipt.version,
    );
    return toReconciliationView(selectReconciliation.get(normalizedReceipt.eventId));
  });

  return Object.freeze({
    enqueue(eventInput) {
      return withLegacyGuard(() => enqueueTransaction.immediate(eventInput));
    },
    pending({ limit = 25 } = {}) {
      requirePositiveInteger(limit, 'limit');
      const timestamp = now();
      return withLegacyGuard(() => database.prepare(`
        SELECT * FROM task_v2_status_events
        WHERE status = 'pending' AND available_at <= ?
          AND (worker_id IS NULL OR lease_until <= ?)
        ORDER BY sequence
        LIMIT ?
      `).all(timestamp, timestamp, limit).map(eventFromRow));
    },
    claim({ workerId, leaseMs, limit = 25 } = {}) {
      return withLegacyGuard(() => claimTransaction.immediate({ workerId, leaseMs, limit }));
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
      const timestamp = now();
      return withLegacyGuard(() => database.prepare(`
        SELECT * FROM task_v2_status_reconciliations
        WHERE status = 'pending' AND available_at <= ?
          AND (worker_id IS NULL OR lease_until <= ?)
        ORDER BY enqueued_at, event_id
        LIMIT ?
      `).all(timestamp, timestamp, limit).map(eventFromRow));
    },
    claimReconciliations({ workerId, leaseMs, limit = 25 } = {}) {
      return withLegacyGuard(() => claimReconciliations.immediate({
        workerId,
        leaseMs,
        limit,
      }));
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
  workerId,
  leaseMs = 30_000,
  limit = 25,
  retryAfterMs = 5_000,
  maxAttempts = 5,
} = {}) {
  if (!inbox || typeof inbox.claim !== 'function'
      || typeof inbox.ack !== 'function' || typeof inbox.fail !== 'function') {
    throw new TypeError('inbox must provide claim, ack, and fail');
  }
  if (!handler || typeof handler.handle !== 'function') {
    throw new TypeError('handler.handle must be a function');
  }
  if (reconciler !== undefined && (!reconciler || typeof reconciler.handle !== 'function')) {
    throw new TypeError('reconciler.handle must be a function');
  }
  const normalizedWorkerId = requireText(workerId, 'status workerId');
  requirePositiveInteger(leaseMs, 'status leaseMs');
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(retryAfterMs, 'retryAfterMs');
  requirePositiveInteger(maxAttempts, 'maxAttempts');
  const events = inbox.claim({ workerId: normalizedWorkerId, leaseMs, limit });
  if (!Array.isArray(events)) throw new TypeError('inbox.claim must return an array');
  const summary = {
    claimed: events.length,
    acknowledged: 0,
    retryWaiting: 0,
    deadLettered: 0,
  };
  const hasReconciliationInbox = typeof inbox.claimReconciliations === 'function'
    && typeof inbox.ackReconciliation === 'function'
    && typeof inbox.failReconciliation === 'function';
  for (const work of events) {
    try {
      const result = await handler.handle(work.event);
      if (reconciler !== undefined && hasReconciliationSignal(result) && !hasReconciliationInbox) {
        throw new TypeError('status inbox cannot persist required reconciliation work');
      }
      inbox.ack({ receipt: work.receipt, result });
      summary.acknowledged += 1;
    } catch (error) {
      const failed = inbox.fail({
        receipt: work.receipt,
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
  const work = inbox.claimReconciliations({
    workerId: normalizedWorkerId,
    leaseMs,
    limit,
  });
  if (!Array.isArray(work)) {
    throw new TypeError('inbox.claimReconciliations must return an array');
  }
  const reconciliation = {
    claimed: work.length,
    acknowledged: 0,
    retryWaiting: 0,
    deadLettered: 0,
  };
  for (const item of work) {
    try {
      const result = await reconciler.handle(item.event);
      inbox.ackReconciliation({ receipt: item.receipt, result });
      reconciliation.acknowledged += 1;
    } catch (error) {
      const failed = inbox.failReconciliation({
        receipt: item.receipt,
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
