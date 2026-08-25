import fs from 'node:fs';
import path from 'node:path';

const EVENT_FIELDS = Object.freeze(['event_id', 'task_id', 'app_id']);
const MAX_EVENT_ID_LENGTH = 512;

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

function normalizeEvent(value) {
  const event = requireRecord(value, 'status event');
  const keys = Object.keys(event);
  if (keys.length !== EVENT_FIELDS.length || !EVENT_FIELDS.every(key => keys.includes(key))) {
    throw new TypeError('status event contains unsupported or missing fields');
  }
  return {
    event_id: requireText(event.event_id, 'status event.event_id'),
    task_id: requireText(event.task_id, 'status event.task_id'),
    app_id: requireText(event.app_id, 'status event.app_id'),
  };
}

function appendRecord(filePath, record) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  if (content === '') return [];
  return content
    .split('\n')
    .filter(line => line !== '')
    .map((line, index) => {
      try {
        return requireRecord(JSON.parse(line), `journal record ${index + 1}`);
      } catch (error) {
        throw new TypeError(`status inbox journal is corrupt at line ${index + 1}: ${error.message}`);
      }
    });
}

/** Append-only durable inbox for normalized App-owned Task v2 status events. */
export function createTaskV2StatusInbox({ directory, clock = Date.now } = {}) {
  const inboxDirectory = path.resolve(requireText(directory, 'directory', 4_096));
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  fs.mkdirSync(inboxDirectory, { recursive: true, mode: 0o700 });
  const eventJournal = path.join(inboxDirectory, 'events.ndjson');
  const settlementJournal = path.join(inboxDirectory, 'settlements.ndjson');

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('clock must return a non-negative Unix epoch millisecond');
    }
    return value;
  }

  function snapshot() {
    const events = new Map();
    for (const record of readRecords(eventJournal)) {
      const event = normalizeEvent(record.event);
      const existing = events.get(event.event_id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new TypeError(`status event identity conflict: ${event.event_id}`);
      }
      events.set(event.event_id, event);
    }
    const settlements = new Map();
    for (const record of readRecords(settlementJournal)) {
      const eventId = requireText(record.eventId, 'settlement.eventId');
      const history = settlements.get(eventId) ?? [];
      history.push(record);
      settlements.set(eventId, history);
    }
    return { events, settlements };
  }

  function view(eventId, state = snapshot()) {
    const event = state.events.get(eventId);
    if (!event) return null;
    const history = state.settlements.get(eventId) ?? [];
    const latest = history.at(-1);
    const attempts = history.filter(record => record.type === 'fail').length;
    let status = 'pending';
    if (latest?.type === 'ack') status = 'acknowledged';
    else if (latest?.type === 'fail' && latest.deadLettered) status = 'dead_letter';
    else if (latest?.type === 'fail' && latest.nextAttemptAt > now()) status = 'retry_wait';
    return {
      event,
      status,
      attempts,
      nextAttemptAt: latest?.type === 'fail' ? latest.nextAttemptAt : null,
      error: latest?.type === 'fail' ? latest.error : null,
      result: latest?.type === 'ack' ? latest.result : null,
    };
  }

  return Object.freeze({
    enqueue(eventInput) {
      const event = normalizeEvent(eventInput);
      const state = snapshot();
      const existing = state.events.get(event.event_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new TypeError(`status event identity conflict: ${event.event_id}`);
        }
        return { created: false, event };
      }
      appendRecord(eventJournal, { event, enqueuedAt: now() });
      return { created: true, event };
    },
    pending({ limit = 25 } = {}) {
      requirePositiveInteger(limit, 'limit');
      const state = snapshot();
      return [...state.events.values()]
        .filter(event => view(event.event_id, state).status === 'pending')
        .slice(0, limit);
    },
    ack({ eventId, result } = {}) {
      const normalizedEventId = requireText(eventId, 'eventId');
      const state = snapshot();
      const current = view(normalizedEventId, state);
      if (!current) throw new TypeError(`status event not found: ${normalizedEventId}`);
      if (current.status === 'acknowledged') return current;
      appendRecord(settlementJournal, {
        type: 'ack', eventId: normalizedEventId, result: result ?? null, settledAt: now(),
      });
      return view(normalizedEventId);
    },
    fail({ eventId, error, retryAfterMs, maxAttempts } = {}) {
      const normalizedEventId = requireText(eventId, 'eventId');
      requirePositiveInteger(retryAfterMs, 'retryAfterMs');
      requirePositiveInteger(maxAttempts, 'maxAttempts');
      const state = snapshot();
      const current = view(normalizedEventId, state);
      if (!current) throw new TypeError(`status event not found: ${normalizedEventId}`);
      if (current.status === 'acknowledged' || current.status === 'dead_letter') return current;
      const attempts = current.attempts + 1;
      const failedAt = now();
      appendRecord(settlementJournal, {
        type: 'fail',
        eventId: normalizedEventId,
        error: [...(error?.stack || error?.message || String(error))].slice(0, 4_096).join(''),
        attempts,
        failedAt,
        nextAttemptAt: failedAt + retryAfterMs,
        deadLettered: attempts >= maxAttempts || error?.retryable === false,
      });
      return view(normalizedEventId);
    },
    query({ eventId } = {}) {
      return view(requireText(eventId, 'eventId'));
    },
  });
}

export async function processTaskV2StatusInboxOnce({
  inbox,
  handler,
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
  for (const event of events) {
    try {
      const result = await handler.handle(event);
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
  return Object.freeze(summary);
}
