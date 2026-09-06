import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,256}$/;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;

function requireRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new TypeError('smart silent marker requestId is invalid');
  }
  return value;
}

/**
 * Durable registry of assistant requests whose Smart-group traffic was
 * accepted without an explicit mention. The Feishu service writes an entry
 * before forwarding the message to Core, and the C4 response-stream hook reads
 * it so a passive request never opens a visible card: a terminal `[SKIP]`
 * resolves to zero outbound and a failure stays invisible, while a substantive
 * answer releases the request into the normal reply projection.
 *
 * The service process and the CLI hook share the directory, so entries use the
 * same file-per-request pattern as the typing done markers.
 */
export function openSmartSilentMarkerStore({
  directory,
  clock = Date.now,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('smart silent marker directory is required');
  }
  if (typeof clock !== 'function') throw new TypeError('smart silent marker clock must be a function');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('smart silent marker ttlMs must be a positive safe integer');
  }
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });

  function entryPath(requestId) {
    return path.join(root, `${requireRequestId(requestId)}.silent.json`);
  }

  function read(requestId) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(entryPath(requestId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const fields = Object.keys(value ?? {}).sort();
    if (
      fields.join(',') !== 'chatId,createdAt,messageId,requestId,schemaVersion,type'
      || value.schemaVersion !== 1
      || value.type !== 'SmartSilentRequest'
      || value.requestId !== requestId
      || typeof value.messageId !== 'string'
      || value.messageId === ''
      || typeof value.chatId !== 'string'
      || value.chatId === ''
      || !Number.isSafeInteger(value.createdAt)
      || value.createdAt < 0
    ) throw new TypeError('smart silent marker state is invalid');
    return Object.freeze(value);
  }

  function prune() {
    const cutoff = clock() - ttlMs;
    let removed = 0;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.silent.json')) continue;
      const target = path.join(root, name);
      try {
        const value = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (Number.isSafeInteger(value?.createdAt) && value.createdAt >= cutoff) continue;
      } catch {
        // A truncated or corrupt entry can never resolve again; drop it.
      }
      fs.unlinkSync(target);
      removed += 1;
    }
    return { removed };
  }

  return Object.freeze({
    mark(requestId, { messageId, chatId } = {}) {
      const safeRequestId = requireRequestId(requestId);
      if (typeof messageId !== 'string' || messageId === '') {
        throw new TypeError('smart silent marker messageId is required');
      }
      if (typeof chatId !== 'string' || chatId === '') {
        throw new TypeError('smart silent marker chatId is required');
      }
      const existing = read(safeRequestId);
      if (existing) return { created: false, entry: existing };
      const entry = Object.freeze({
        schemaVersion: 1,
        type: 'SmartSilentRequest',
        requestId: safeRequestId,
        messageId,
        chatId,
        createdAt: clock(),
      });
      const temporary = path.join(root, `.${safeRequestId}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
        try {
          fs.linkSync(temporary, entryPath(safeRequestId));
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          return { created: false, entry: read(safeRequestId) };
        }
      } finally {
        try { fs.unlinkSync(temporary); } catch {}
      }
      return { created: true, entry: read(safeRequestId) };
    },
    get(requestId) {
      return read(requireRequestId(requestId));
    },
    release(requestId) {
      try {
        fs.unlinkSync(entryPath(requestId));
        return true;
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    },
    prune,
  });
}
