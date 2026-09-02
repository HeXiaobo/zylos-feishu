import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const REACTION_ID = /^[A-Za-z0-9_-]{1,512}$/;

function requireMessageId(value) {
  if (typeof value !== 'string' || !MESSAGE_ID.test(value)) {
    throw new TypeError('typing marker messageId is invalid');
  }
  return value;
}

function requireReactionId(value) {
  if (typeof value !== 'string' || !REACTION_ID.test(value)) {
    throw new TypeError('typing presence reactionId is invalid');
  }
  return value;
}

function identityConflict(message) {
  const error = new Error(message);
  error.code = 'IDEMPOTENCY_CONFLICT';
  return error;
}

export function messageIdFromEndpoint(endpointId) {
  if (typeof endpointId !== 'string' || endpointId.trim() === '') return null;
  const values = endpointId.split('|').slice(1)
    .filter(part => part.startsWith('msg:'))
    .map(part => part.slice(4));
  if (values.length !== 1) return null;
  return MESSAGE_ID.test(values[0]) ? values[0] : null;
}

export function settlementMessageIdFromEndpoint(endpointId) {
  if (typeof endpointId !== 'string' || endpointId.trim() === '') return null;
  const declaresMessage = endpointId.split('|').slice(1)
    .some(part => part.startsWith('msg:'));
  if (!declaresMessage) return null;
  const messageId = messageIdFromEndpoint(endpointId);
  if (messageId) return messageId;
  const error = new Error('terminal delivery route has an invalid source message identity');
  error.code = 'INVALID_SOURCE_MESSAGE_IDENTITY';
  throw error;
}

export async function persistTimeoutPresenceCompletions({
  requestIds,
  activeMessageIds,
  requestIdForMessage,
  mark,
  acknowledge,
  logger = console,
} = {}) {
  if (!Array.isArray(requestIds) || !Array.isArray(activeMessageIds)) {
    throw new TypeError('timeout presence completion identities must be arrays');
  }
  if (
    typeof requestIdForMessage !== 'function'
    || typeof mark !== 'function'
    || typeof acknowledge !== 'function'
  ) throw new TypeError('timeout presence completion adapter is invalid');
  let settled = 0;
  let unresolved = 0;
  for (const requestId of requestIds) {
    const matches = activeMessageIds.filter(messageId => requestIdForMessage(messageId) === requestId);
    if (matches.length !== 1) {
      unresolved += 1;
      logger.warn?.('Timeout presence completion has no exact active message mapping', { requestId });
      continue;
    }
    mark(matches[0]);
    await acknowledge(requestId);
    settled += 1;
  }
  return { settled, unresolved };
}

export function openTypingDoneMarkerStore({ directory, clock = Date.now } = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('typing marker directory is required');
  }
  const root = path.resolve(directory);
  if (typeof clock !== 'function') throw new TypeError('typing marker clock must be a function');
  fs.mkdirSync(root, { recursive: true });

  function markerPath(messageId) {
    return path.join(root, `${requireMessageId(messageId)}.done`);
  }

  function presencePath(messageId) {
    return path.join(root, `${requireMessageId(messageId)}.presence.json`);
  }

  function readActive(messageId) {
    const safeMessageId = requireMessageId(messageId);
    let value;
    try {
      value = JSON.parse(fs.readFileSync(presencePath(safeMessageId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const fields = Object.keys(value ?? {}).sort();
    if (
      fields.join(',') !== 'createdAt,messageId,reactionId,schemaVersion,status,type'
      || value.schemaVersion !== 1
      || value.type !== 'TypingPresence'
      || value.messageId !== safeMessageId
      || !['adding', 'active'].includes(value.status)
      || !Number.isSafeInteger(value.createdAt)
      || value.createdAt < 0
    ) throw new TypeError('typing presence state is invalid');
    if (value.status === 'adding' && value.reactionId !== null) {
      throw new TypeError('adding typing presence cannot have a reactionId');
    }
    if (value.status === 'active') requireReactionId(value.reactionId);
    return Object.freeze(value);
  }

  function writePresence(presence, { exclusive = false } = {}) {
    const temporary = path.join(root, `.${presence.messageId}.${randomUUID()}.presence.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(presence), { flag: 'wx', mode: 0o600 });
      if (exclusive) fs.linkSync(temporary, presencePath(presence.messageId));
      else fs.renameSync(temporary, presencePath(presence.messageId));
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  return Object.freeze({
    mark(messageId) {
      const target = markerPath(messageId);
      if (fs.existsSync(target)) return { created: false, messageId };
      const temporary = path.join(root, `.${messageId}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, String(clock()), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, target);
      } finally {
        try { fs.unlinkSync(temporary); } catch {}
      }
      return { created: true, messageId };
    },
    beginAdding(messageId) {
      const safeMessageId = requireMessageId(messageId);
      const existing = readActive(safeMessageId);
      if (existing) return { created: false, presence: existing };
      const presence = Object.freeze({
        schemaVersion: 1,
        type: 'TypingPresence',
        messageId: safeMessageId,
        status: 'adding',
        reactionId: null,
        createdAt: clock(),
      });
      if (!Number.isSafeInteger(presence.createdAt) || presence.createdAt < 0) {
        throw new TypeError('typing presence clock returned an invalid timestamp');
      }
      try {
        writePresence(presence, { exclusive: true });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        return { created: false, presence: readActive(safeMessageId) };
      }
      return { created: true, presence };
    },
    registerActive({ messageId, reactionId }) {
      const safeMessageId = requireMessageId(messageId);
      const safeReactionId = requireReactionId(reactionId);
      const existing = readActive(safeMessageId);
      if (!existing) throw identityConflict('typing presence must be adding before activation');
      if (existing.status === 'active') {
        if (existing.reactionId !== safeReactionId) {
          throw identityConflict('typing presence already has a different reaction identity');
        }
        return { created: false, presence: existing };
      }
      const presence = Object.freeze({ ...existing, status: 'active', reactionId: safeReactionId });
      writePresence(presence);
      return { created: true, presence };
    },
    getActive(messageId) {
      return readActive(messageId);
    },
    listActiveMessageIds() {
      return fs.readdirSync(root)
        .filter(name => name.endsWith('.presence.json'))
        .map(name => name.slice(0, -'.presence.json'.length))
        .filter(messageId => MESSAGE_ID.test(messageId))
        .filter(messageId => readActive(messageId) !== null)
        .sort();
    },
    finishActive({ messageId, reactionId }) {
      const current = readActive(messageId);
      if (!current) return false;
      if (current.status !== 'active' || current.reactionId !== requireReactionId(reactionId)) {
        throw identityConflict('typing presence finish changed reaction identity');
      }
      fs.unlinkSync(presencePath(messageId));
      return true;
    },
    finishAdding(messageId) {
      const current = readActive(messageId);
      if (!current) return false;
      if (current.status !== 'adding') {
        throw identityConflict('typing presence is active and cannot finish adding');
      }
      fs.unlinkSync(presencePath(messageId));
      return true;
    },
    claim() {
      return fs.readdirSync(root)
        .filter(name => name.endsWith('.done'))
        .map(name => name.slice(0, -5))
        .filter(messageId => MESSAGE_ID.test(messageId))
        .sort();
    },
    createdAt(messageId) {
      try {
        const value = Number.parseInt(fs.readFileSync(markerPath(messageId), 'utf8'), 10);
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    ack(messageId) {
      try {
        fs.unlinkSync(markerPath(messageId));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
  });
}

export function createTypingPresenceCoordinator({
  store,
  addReaction,
  removeReaction,
  reconcileReaction = null,
} = {}) {
  if (!store || ['beginAdding', 'registerActive', 'getActive', 'finishActive', 'finishAdding'].some(
    name => typeof store[name] !== 'function',
  )) throw new TypeError('typing presence store is invalid');
  if (typeof addReaction !== 'function' || typeof removeReaction !== 'function') {
    throw new TypeError('typing presence reaction adapter is invalid');
  }
  const reconcile = reconcileReaction ?? (async () => ({ outcome: 'unknown' }));
  if (typeof reconcile !== 'function') throw new TypeError('typing presence reconciler is invalid');
  const locks = new Map();

  function serialized(messageId, operation) {
    const safeMessageId = requireMessageId(messageId);
    const predecessor = locks.get(safeMessageId) ?? Promise.resolve();
    const current = predecessor.catch(() => {}).then(operation);
    locks.set(safeMessageId, current);
    return current.finally(() => {
      if (locks.get(safeMessageId) === current) locks.delete(safeMessageId);
    });
  }

  async function resolveAdding(messageId, presence) {
    if (presence.status !== 'adding') return presence;
    const observed = await reconcile(messageId, null);
    if (observed?.outcome === 'reconciled') {
      return store.registerActive({ messageId, reactionId: observed.reactionId }).presence;
    }
    if (observed?.outcome !== 'not_found') return null;
    return presence;
  }

  return Object.freeze({
    begin(messageId) {
      return serialized(messageId, async () => {
        let presence = store.getActive(messageId);
        if (presence?.status === 'active') return presence;
        if (presence) {
          const resolved = await resolveAdding(messageId, presence);
          if (resolved?.status === 'active') return resolved;
          if (!resolved) return null;
        } else {
          presence = store.beginAdding(messageId).presence;
        }
        const added = await addReaction(messageId);
        if (added?.success !== true) return null;
        const reactionId = requireReactionId(added.reactionId);
        try {
          return store.registerActive({ messageId, reactionId }).presence;
        } catch (error) {
          let cleanup;
          try { cleanup = await removeReaction(messageId, reactionId); } catch {}
          const absent = cleanup?.success === true
            || cleanup?.notFound === true
            || cleanup?.outcome === 'not_found';
          if (absent) store.finishAdding(messageId);
          throw error;
        }
      });
    },
    finish(messageId) {
      return serialized(messageId, async () => {
        let active = store.getActive(messageId);
        if (!active) {
          const observed = await reconcile(messageId, null);
          if (observed?.outcome === 'not_found') return true;
          if (observed?.outcome !== 'reconciled') return false;
          const adding = store.beginAdding(messageId).presence;
          active = adding.status === 'active'
            ? adding
            : store.registerActive({ messageId, reactionId: observed.reactionId }).presence;
        }
        if (active.status === 'adding') {
          const resolved = await resolveAdding(messageId, active);
          if (!resolved) return false;
          if (resolved.status === 'adding') {
            store.finishAdding(messageId);
            return true;
          }
          active = resolved;
        }
        let removed;
        try { removed = await removeReaction(messageId, active.reactionId); } catch {}
        const absenceProven = removed?.success === true
          || removed?.notFound === true
          || removed?.outcome === 'not_found';
        if (!absenceProven) {
          const observed = await reconcile(messageId, active.reactionId);
          if (observed?.outcome !== 'not_found') return false;
        }
        store.finishActive(active);
        return true;
      });
    },
  });
}

export function createTypingDoneMarkerConsumer({
  markers,
  remove,
} = {}) {
  if (!markers || ['claim', 'ack'].some(name => typeof markers[name] !== 'function')) {
    throw new TypeError('typing marker consumer store is invalid');
  }
  if (typeof remove !== 'function') {
    throw new TypeError('typing marker consumer callbacks are invalid');
  }
  let inFlight = null;

  return Object.freeze({
    drain() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let acknowledged = 0;
        for (const messageId of markers.claim()) {
          if (await remove(messageId)) {
            markers.ack(messageId);
            acknowledged += 1;
          }
        }
        return { acknowledged };
      })().finally(() => { inFlight = null; });
      return inFlight;
    },
  });
}
