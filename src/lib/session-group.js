/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules:
 *   private chat (type:p2p)               -> dm-<chat_id>                       (threads not split)
 *   group chat (type:group), no thread    -> group-<chat_id>                    (incl. quote/reply chains)
 *   group chat (type:group) with thread   -> group-<chat_id>:topic-<thread_id>
 *
 * These names are Core's memory keys. The rules are FIXED once live: changing
 * them needs a migration planned together with Core, otherwise existing
 * groups lose their memory.
 *
 * Per-message parts of the endpoint (msg, root, parent) never take part.
 * Nothing is guessed, rewritten, truncated or hashed: an endpoint without a
 * known type, an id with unexpected characters, or a name Core would reject
 * throws. The component never adds the `feishu:` namespace; Core does.
 *
 * A bare chat id (no `|`, as used for proactive sends) is resolved by
 * resolveSessionGroup: the chat type comes from a local cache (written by
 * index.js for every inbound message and after each successful lookup) or,
 * on a miss, from Feishu's im.chat.get `chat_mode`. A bare id always maps to
 * the DM or the group itself, never to a topic. If the lookup fails, nothing
 * is guessed: it throws.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { buildEndpoint, parseEndpoint } from './endpoint.js';

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Feishu ids (oc_..., omt_...) used verbatim inside group names. */
const FEISHU_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

const quote = (value, max = 64) => JSON.stringify(String(value ?? '').slice(0, max));

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "oc_abc|type:group|msg:om_1|thread:omt_2"
 * @returns {string} group name without namespace (never '')
 * @throws {Error} when the endpoint cannot be mapped
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parsed = parseEndpoint(endpoint);
  const chatId = parsed.chatId;
  if (!FEISHU_ID.test(chatId)) {
    throw new Error(`invalid Feishu chat id in endpoint: ${quote(endpoint)}`);
  }

  let name;
  if (parsed.type === 'p2p') {
    name = `dm-${chatId}`;
  } else if (parsed.type === 'group') {
    const thread = parsed.thread;
    if (thread === undefined) {
      name = `group-${chatId}`;
    } else if (!FEISHU_ID.test(thread)) {
      throw new Error(`invalid thread id in endpoint: ${quote(thread, 32)}`);
    } else {
      name = `group-${chatId}:topic-${thread}`;
    }
  } else if (parsed.type === undefined) {
    throw new Error(`endpoint has no type, cannot tell DM from group: ${quote(endpoint)}`);
  } else {
    throw new Error(`unknown chat type in endpoint: ${quote(parsed.type, 32)}`);
  }

  if (!isValidSessionGroup(name)) {
    throw new Error(`session group would be invalid for Core (length ${name.length}, max ${SESSION_GROUP_MAX_LENGTH})`);
  }
  return name;
}

// ============================================================
// Bare chat id: chat type cache + Feishu lookup
// ============================================================

/** chat_id -> 'p2p' | 'group' */
export const CHAT_TYPE_CACHE_PATH = path.join(DATA_DIR, 'chat-type-cache.json');
// Core kills the session-group query after 6.5s; stay well under it so a slow
// Feishu API fails cleanly here instead of being cut off.
export const CHAT_LOOKUP_TIMEOUT_MS = 4000;

const CHAT_TYPES = new Set(['p2p', 'group']);

/**
 * Chat type for a Feishu im.chat.get `chat_mode`.
 * @param {string} chatMode - 'p2p' | 'group' | 'topic'
 * @returns {'p2p'|'group'|null} null for anything else
 */
export function chatTypeFromChatMode(chatMode) {
  if (chatMode === 'p2p') return 'p2p';
  if (chatMode === 'group' || chatMode === 'topic') return 'group';
  return null;
}

/**
 * Read the chat type cache. A missing, unreadable or malformed file is an
 * empty cache.
 * @param {string} [cachePath]
 * @returns {Record<string, string>}
 */
export function readChatTypeCache(cachePath = CHAT_TYPE_CACHE_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return {};
}

/**
 * Record a chat's type (tmp + rename). Writes only when the entry changes.
 * Caching is an optimization: invalid input or a failed write is ignored.
 * @param {string} chatId
 * @param {string} chatType - 'p2p' | 'group'
 * @param {string} [cachePath]
 * @returns {boolean} true when the file was written
 */
export function recordChatType(chatId, chatType, cachePath = CHAT_TYPE_CACHE_PATH) {
  if (!FEISHU_ID.test(String(chatId ?? '')) || !CHAT_TYPES.has(chatType)) return false;
  const cache = readChatTypeCache(cachePath);
  if (cache[chatId] === chatType) return false;
  cache[chatId] = chatType;
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2));
    fs.renameSync(tmpPath, cachePath);
    return true;
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

async function defaultFetchChatMode(chatId) {
  // Dynamic import keeps the Feishu SDK (chat.js -> client.js) out of the module
  // load path, so the inbound mapping stays testable without credentials.
  const { getChatInfo } = await import('./chat.js');
  const result = await getChatInfo(chatId);
  if (!result.success) throw new Error(result.message || 'im.chat.get failed');
  return result.chat.chatMode;
}

/**
 * Look up a chat's type via Feishu im.chat.get, raced against a timeout.
 * @returns {Promise<'p2p'|'group'>}
 * @throws {Error} on API failure, timeout or an unknown chat_mode
 */
async function lookupChatType(chatId, fetchChatMode, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`im.chat.get timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const chatMode = await Promise.race([fetchChatMode(chatId), timeout]);
    const chatType = chatTypeFromChatMode(chatMode);
    if (!chatType) throw new Error(`unknown chat_mode from im.chat.get: ${quote(chatMode, 32)}`);
    return chatType;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Session group for any endpoint, including a bare chat id.
 * - With `|type:` (or any `|` part): exactly sessionGroupFromEndpoint.
 * - Bare chat id: type from the cache, else from im.chat.get (then cached);
 *   maps to dm-<id> or group-<id>, never a topic.
 * @param {string} endpoint
 * @param {object} [opts]
 * @param {string} [opts.cachePath]
 * @param {function} [opts.fetchChatMode] - Test hook: chatId -> Promise<chat_mode>
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<string>} group name without namespace
 * @throws {Error} when the endpoint cannot be mapped or the lookup fails
 */
export async function resolveSessionGroup(endpoint, {
  cachePath = CHAT_TYPE_CACHE_PATH,
  fetchChatMode = defaultFetchChatMode,
  timeoutMs = CHAT_LOOKUP_TIMEOUT_MS,
} = {}) {
  if (typeof endpoint !== 'string' || endpoint.includes('|')) {
    return sessionGroupFromEndpoint(endpoint);
  }
  const chatId = endpoint;
  if (!FEISHU_ID.test(chatId)) {
    throw new Error(`invalid Feishu chat id in endpoint: ${quote(endpoint)}`);
  }
  let chatType = readChatTypeCache(cachePath)[chatId];
  if (!CHAT_TYPES.has(chatType)) {
    try {
      chatType = await lookupChatType(chatId, fetchChatMode, timeoutMs);
    } catch (err) {
      throw new Error(`cannot look up chat type for ${quote(chatId)}: ${err.message}`);
    }
    recordChatType(chatId, chatType, cachePath);
  }
  return sessionGroupFromEndpoint(buildEndpoint(chatId, { chatType }));
}
