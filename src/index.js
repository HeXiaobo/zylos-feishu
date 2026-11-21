#!/usr/bin/env node
/**
 * zylos-feishu - Feishu Bot Service
 *
 * Supports two connection modes (configured via config.json connection_mode):
 *   - websocket: Feishu SDK WSClient for persistent long connection
 *   - webhook: Express HTTP server for receiving webhook events
 */

import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';
// zylos-lab-safe-logger: never print request bodies/headers (app_secret).
// Kept as the canonical lab logger module; since upstream 0.4.0 the SDK clients
// below use src/lib/redact.js's createRedactingLogger(), which redacts the same
// values and more (token shapes, Authorization headers), so safeLogger is no
// longer wired into a client. The file stays byte-identical to zylos-core's
// cli/lib/runtime/feishu-safe-logger.js so lab.mjs can still verify it.

// Load .env from ~/zylos/.env (absolute path, not cwd-dependent)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });
// zylos-lab-mention-patch: @everyone is not a mention of this bot.
// Upstream 0.4.0 also exports an isBotMentioned() from ./lib/bot-identity.js,
// but that one counts `@_all` as a mention of the bot; the lab patch keeps the
// stricter policy module as the single call site (see feishu-group-policy.js).
import { isBotMentioned } from './lib/feishu-group-policy.js';

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';
import { downloadImage, downloadFile, sendMessage, replyToMessage, extractPermissionError, addReaction, removeReaction, listMessages } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';
import { listChatMembers } from './lib/chat.js';
import { sendThreadAware } from './lib/reply-send.js';
import { extractInteractiveText } from './lib/card-text.js';
import { createCardActionHandler } from './lib/card-action.js';
import { renderMergeForward, itemsFromResponse } from './lib/merge-forward.js';
// 3ai-dedupe: one claim per message id, shared with the feishu-recovery poller.
import { loadClaimStore } from './lib/dedupe-claim-loader.js';
// 3ai-recovery: body parsing and DM rules live in lib/ so the recovery poller
// applies the same ones instead of keeping its own copies.
import { extractPostText, resolveMentions } from './lib/message-text.js';
// 3ai-forward-media: display text for im.message.get items lives in lib/ so the
// merge-forward resource-id rule is unit-testable (see the module's docblock).
import { parseMessageItemText } from './lib/message-item-text.js';
import { isDmAllowed as isDmAllowedByConfig, isOwner as isOwnerByConfig } from './lib/dm-policy.js';
import { sendToC4 as sendToC4Core, createRejectReply } from './lib/c4.js';
import { buildEndpoint } from './lib/endpoint.js';
import { selectContextWindow, isBehindCursor, createCursorMarker } from './lib/group-context.js';
import { installConsoleRedaction, registerSecrets, createRedactingLogger } from './lib/redact.js';

// Keep credentials out of the PM2 logs, whatever logs them (src/lib/redact.js).
installConsoleRedaction();
import { recordChatType } from './lib/session-group.js';
import { getBotInfo } from './lib/client.js';
import { createBotIdentity, botIdentityConfigUpdate } from './lib/bot-identity.js';

// WSClient instance for graceful shutdown (websocket mode only)
let wsClient = null;
let webhookServer = null;
let isShuttingDown = false;

// Initialize
let config = getConfig();
const connectionMode = config.connection_mode || 'websocket';
const INTERNAL_SECRET = crypto.randomUUID();
registerSecrets(INTERNAL_SECRET, getCredentials().app_secret, config.bot?.encrypt_key, config.bot?.verification_token);
// Persist token to file so send.js (spawned by C4 in a separate process tree) can read it
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
} catch (err) {
  console.error(`[feishu] Failed to write internal token file: ${err.message}`);
}
console.log(`[feishu] Starting (${connectionMode} mode)...`);
console.log(`[feishu] Data directory: ${DATA_DIR}`);

// Ensure directories exist
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

// State files
const CURSORS_PATH = path.join(DATA_DIR, 'group-cursors.json');
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');

// ============================================================
// Message deduplication (shared by websocket and webhook modes)
// ============================================================
const DEDUP_TTL = 5 * 60 * 1000; // 5 minutes
const processedMessages = new Map();

// The recovery poller is a separate process and cannot see this Map. Both
// paths create a claim file for a message id before handling it; the first
// creator wins and the other one skips. Without the module (plain `zylos add`,
// no 3ai image) this stays memory-only, which is what it was before.
const claimLoad = await loadClaimStore({ via: 'ws', log: (message) => console.warn(`[feishu] ${message}`) });
const claimStore = claimLoad.store;
if (claimStore) {
  console.log(`[feishu] Dedupe claims shared with feishu-recovery at ${claimStore.dir}`);
} else {
  console.warn(`[feishu] Dedupe claims unavailable (${claimLoad.error}); memory-only dedupe, the recovery poller will not run`);
}

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) {
    console.log(`[feishu] Duplicate message_id ${messageId}, skipping`);
    return true;
  }
  if (claimStore && !claimStore.claim(messageId)) {
    const owner = claimStore.ownerOf(messageId);
    console.log(`[feishu] Duplicate message_id ${messageId}, skipping (already claimed by ${owner?.via || 'another path'})`);
    return true;
  }
  processedMessages.set(messageId, Date.now());
  // Cleanup old entries
  if (processedMessages.size > 200) {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(id);
    }
  }
  return false;
}

// Periodic cleanup of expired dedup entries (avoids accumulation in low-traffic chats)
const dedupCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, DEDUP_TTL);

// Claim files live 24 h on the data volume; sweep them once an hour.
const claimSweepInterval = setInterval(() => {
  if (claimStore) claimStore.sweep();
}, 60 * 60 * 1000);

console.log(`[feishu] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[feishu] Component disabled in config, exiting.`);
  process.exit(0);
}

if (connectionMode === 'webhook' && !config.bot?.verification_token) {
  console.error(`[feishu] ERROR: bot.verification_token is not configured (required for webhook mode).`);
  console.error(`[feishu] Set it in ~/zylos/components/feishu/config.json (get from developer console → Event Subscriptions).`);
  process.exit(1);
}

// Bot identity: one object read by every consumer so a later recovery takes
// effect without a restart (see src/lib/bot-identity.js).
let currentAppId = '';
try {
  currentAppId = getCredentials().app_id || '';
} catch {}
const botIdentity = createBotIdentity({
  fetchBotInfo: getBotInfo,
  appId: currentAppId,
  // Persist open_id + app_id so the next start has the identity without an
  // API call. Skipped when already current.
  persist: (identity) => {
    const next = botIdentityConfigUpdate(config, identity);
    if (!next) return;
    if (saveConfig(next)) config = next;
  },
});
botIdentity.loadCached(config.bot);

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[feishu] Config reloaded`);
  config = newConfig;
  registerSecrets(newConfig.bot?.encrypt_key, newConfig.bot?.verification_token);
  if (!newConfig.enabled) {
    console.log(`[feishu] Component disabled, stopping...`);
    shutdown();
  }
});

// Load/save group cursors
function loadCursors() {
  try {
    if (fs.existsSync(CURSORS_PATH)) {
      return JSON.parse(fs.readFileSync(CURSORS_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveCursors(cursors) {
  const tmpPath = CURSORS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cursors, null, 2));
    fs.renameSync(tmpPath, CURSORS_PATH);
    return true;
  } catch (err) {
    console.log(`[feishu] Failed to save cursors: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// ============================================================
// Typing indicator (emoji reaction on message while processing)
// ============================================================
const TYPING_EMOJI = 'Typing';  // ⌨️ keyboard typing indicator
const TYPING_TIMEOUT = 120 * 1000; // 120 seconds max

// Track active typing indicators: Map<messageId, { reactionId, timer }>
const activeTypingIndicators = new Map();

/**
 * Add a typing indicator (emoji reaction) to a message.
 * Returns the state needed to remove it later.
 */
async function addTypingIndicator(messageId) {
  try {
    const result = await addReaction(messageId, TYPING_EMOJI);
    if (result.success && result.reactionId) {
      // Set auto-remove timeout
      const timer = setTimeout(() => {
        removeTypingIndicator(messageId);
      }, TYPING_TIMEOUT);

      activeTypingIndicators.set(messageId, {
        reactionId: result.reactionId,
        timer,
      });

      return true;
    }
  } catch (err) {
    // Non-critical; silently fail
    console.log(`[feishu] Failed to add typing indicator: ${err.message}`);
  }
  return false;
}

/**
 * Remove a typing indicator from a message.
 */
async function removeTypingIndicator(messageId) {
  const state = activeTypingIndicators.get(messageId);
  if (!state) return;

  clearTimeout(state.timer);
  let removed = false;

  try {
    const result = await removeReaction(messageId, state.reactionId);
    if (result.success) {
      removed = true;
    } else {
      await new Promise(r => setTimeout(r, 1000));
      const retry = await removeReaction(messageId, state.reactionId);
      removed = retry.success;
    }
  } catch (err) {
    console.log(`[feishu] Failed to remove typing indicator: ${err.message}`);
  }

  if (removed) {
    activeTypingIndicators.delete(messageId);
  } else {
    // Deferred retry to avoid orphaned emoji reaction
    state.timer = setTimeout(() => {
      removeReaction(messageId, state.reactionId)
        .catch(() => {})
        .finally(() => activeTypingIndicators.delete(messageId));
    }, 10000);
  }
}

/**
 * Check for typing-done marker files written by send.js.
 * When found, remove the typing indicator and clean up the marker.
 */
const TYPING_DIR = path.join(DATA_DIR, 'typing');
fs.mkdirSync(TYPING_DIR, { recursive: true });

// Clean up stale typing markers from previous run
try {
  const staleFiles = fs.readdirSync(TYPING_DIR);
  for (const f of staleFiles) {
    try { fs.unlinkSync(path.join(TYPING_DIR, f)); } catch {}
  }
  if (staleFiles.length > 0) console.log(`[feishu] Cleaned ${staleFiles.length} stale typing markers`);
} catch {}

function checkTypingDoneMarkers() {
  try {
    const files = fs.readdirSync(TYPING_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith('.done')) continue;
      const messageId = file.replace('.done', '');
      const filePath = path.join(TYPING_DIR, file);

      if (activeTypingIndicators.has(messageId)) {
        removeTypingIndicator(messageId);
        console.log(`[feishu] Typing indicator removed for ${messageId} (reply sent)`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      } else {
        // Clean up orphaned markers older than 60s (indicator timed out or never registered)
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const markerTime = parseInt(content, 10);
          if (now - markerTime > 60000) {
            fs.unlinkSync(filePath);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// Poll for typing-done markers every 2 seconds
const typingCheckInterval = setInterval(checkTypingDoneMarkers, 2000);

// ============================================================
// Permission error tracking (cooldown to avoid spam)
// ============================================================
const PERMISSION_ERROR_COOLDOWN = 5 * 60 * 1000; // 5 minutes
let lastPermissionErrorNotified = 0;

/**
 * Handle a detected Feishu API permission error.
 * Sends a notification to the owner via C4 (with cooldown).
 */
function handlePermissionError(permErr) {
  const now = Date.now();
  if (now - lastPermissionErrorNotified < PERMISSION_ERROR_COOLDOWN) return;
  lastPermissionErrorNotified = now;

  const grantUrl = permErr.grantUrl || '';
  const msg = `[System] Feishu API permission error (code ${permErr.code}): ${permErr.message}`;
  const detail = grantUrl
    ? `${msg}\nGrant permissions at: ${grantUrl}`
    : msg;

  console.error(`[feishu] ${detail}`);

  // Notify owner directly via Feishu DM (bypass C4 — this is a system alert)
  if (config.owner?.bound && config.owner?.open_id) {
    const alertText = `[Feishu SYSTEM] Permission error detected: ${permErr.message}${grantUrl ? '\nAdmin grant URL: ' + grantUrl : ''}`;
    sendMessage(config.owner.open_id, alertText, 'open_id', 'text')
      .catch(e => console.error('[feishu] Failed to send permission alert to owner:', e.message));
  }
}

// ============================================================
// User name cache with TTL (in-memory primary, file for cold start)
// ============================================================
const SENDER_NAME_TTL = 10 * 60 * 1000; // 10 minutes

// In-memory cache: Map<userId, { name: string, expireAt: number }>
const userCacheMemory = new Map();

/**
 * Load file cache on cold start to seed the in-memory cache.
 * File entries are loaded with a fresh TTL since they were recently valid.
 */
function loadUserCacheFromFile() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
      const now = Date.now();
      for (const [userId, name] of Object.entries(data)) {
        if (typeof name === 'string') {
          userCacheMemory.set(userId, { name, expireAt: now + SENDER_NAME_TTL });
        }
      }
      console.log(`[feishu] Loaded ${userCacheMemory.size} names from file cache`);
    }
  } catch (err) {
    console.log(`[feishu] Failed to load user cache file: ${err.message}`);
  }
}

/**
 * Persist in-memory cache to file (for cold start acceleration).
 * Called periodically when new names are resolved.
 */
let _userCacheDirty = false;
function persistUserCache() {
  if (!_userCacheDirty) return;
  _userCacheDirty = false;
  const obj = {};
  for (const [userId, entry] of userCacheMemory) {
    obj[userId] = entry.name;
  }
  const tmpPath = USER_CACHE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    fs.renameSync(tmpPath, USER_CACHE_PATH);
  } catch (err) {
    console.log(`[feishu] Failed to persist user cache: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    _userCacheDirty = true;
  }
}

// Persist cache every 5 minutes
const userCachePersistInterval = setInterval(persistUserCache, 5 * 60 * 1000);

// Load file cache on startup
loadUserCacheFromFile();

// Keep backward-compatible reference
let userCache = null; // unused, kept for compat
let groupCursors = loadCursors();

// ============================================================
// In-memory chat history (replaces file-based context building)
// File logs are kept for audit; this Map is used for fast context.
// ============================================================
const DEFAULT_HISTORY_LIMIT = 5;
const chatHistories = new Map(); // Map<historyKey, Array<{ message_id, user_name, user_id, text, timestamp }>>

function getHistoryKey(chatId, threadId = null) {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

/**
 * Record a message entry into in-memory chat history.
 * Caps entries at the configured limit per chat.
 */
function recordHistoryEntry(historyKey, entry) {
  if (!chatHistories.has(historyKey)) {
    chatHistories.set(historyKey, []);
  }
  const history = chatHistories.get(historyKey);
  // Deduplicate by message_id (lazy load + real-time can overlap)
  if (entry.message_id && history.some(m => m.message_id === entry.message_id)) {
    return;
  }
  history.push(entry);
  const baseChatId = historyKey.includes(':') ? historyKey.split(':')[0] : historyKey;
  const limit = getGroupHistoryLimit(baseChatId);
  // Cap at 2x limit to avoid unbounded growth; trim to limit when reading
  if (history.length > limit * 2) {
    chatHistories.set(historyKey, history.slice(-limit));
  }
}

/**
 * Get recent context messages from in-memory history (chronological).
 * Excludes the current message itself; with options.afterMessageId (the group
 * cursor) only entries after it (src/lib/group-context.js).
 */
function getInMemoryContext(historyKey, currentMessageId, options = {}) {
  const history = chatHistories.get(historyKey);
  if (!history || history.length === 0) return [];

  const baseChatId = historyKey.includes(':') ? historyKey.split(':')[0] : historyKey;
  const limit = getGroupHistoryLimit(baseChatId);
  return selectContextWindow(history, currentMessageId, limit, options);
}

/**
 * Pin the root message to the first position in thread context.
 * If root was trimmed by the context limit, fetch it from the full history.
 */
function pinRootMessage(context, rootId, historyKey) {
  if (!rootId || !context) return context;
  const result = [...context];
  const rootIdx = result.findIndex(m => m.message_id === rootId);
  if (rootIdx > 0) {
    // Root exists but not first — move it
    const [root] = result.splice(rootIdx, 1);
    result.unshift(root);
  } else if (rootIdx === -1) {
    // Root was trimmed by limit — try to recover from full history
    const fullHistory = chatHistories.get(historyKey);
    if (fullHistory) {
      const rootEntry = fullHistory.find(m => m.message_id === rootId);
      if (rootEntry) {
        result.unshift(rootEntry);
      }
    }
  }
  return result;
}

/**
 * Get context with lazy load fallback.
 * If in-memory history is empty (e.g. after restart), fetch from API once.
 * @param {string} containerId - chat_id or thread_id
 * @param {string} currentMessageId - current message to exclude
 * @param {'chat'|'thread'} containerType - container type for API fallback
 */
const _lazyLoadedContainers = new Set();

// Preload group member names into cache (avoids cross-tenant API errors)
const _preloadedGroups = new Set();
async function preloadGroupMembers(chatId) {
  if (_preloadedGroups.has(chatId)) return;
  _preloadedGroups.add(chatId);
  try {
    const result = await listChatMembers(chatId);
    if (result.success && result.members) {
      const now = Date.now();
      let count = 0;
      for (const member of result.members) {
        if (member.memberId && member.name && !userCacheMemory.has(member.memberId)) {
          userCacheMemory.set(member.memberId, { name: member.name, expireAt: now + SENDER_NAME_TTL });
          _userCacheDirty = true;
          count++;
        }
      }
      console.log(`[feishu] Preloaded ${count} member names for group ${chatId}`);
    }
  } catch (err) {
    console.log(`[feishu] Failed to preload group members for ${chatId}: ${err.message}`);
  }
}

async function getContextWithFallback(containerId, currentMessageId, containerType = 'chat', historyKey = containerId, historyLimit = null, options = {}) {
  if (_lazyLoadedContainers.has(historyKey)) {
    return getInMemoryContext(historyKey, currentMessageId, options);
  }

  // First access after restart — try to fetch from API
  try {
    const limit = historyLimit || (containerType === 'thread'
      ? (config.message?.context_messages || DEFAULT_HISTORY_LIMIT)
      : getGroupHistoryLimit(containerId));
    const result = await listMessages(containerId, limit, 'desc', null, null, containerType);
    if (result.success) {
      _lazyLoadedContainers.add(historyKey);
      if (result.messages.length > 0) {
        // Sort by createTime to ensure chronological order
        // (reverse of desc is usually correct, but thread root may be returned out of order)
        const msgs = result.messages.sort((a, b) => new Date(a.createTime) - new Date(b.createTime));
        for (const msg of msgs) {
          const userName = await resolveUserName(msg.sender);
          // Parse post messages (raw JSON) into readable text
          let text = msg.content;
          if (msg.type === 'post' && typeof text === 'string') {
            try {
              const parsed = JSON.parse(text);
              const content = parsed.content || [];
              ({ text } = extractPostText(content, msg.id));
            } catch { /* use raw content */ }
          }
          // Resolve @_user_N mentions in lazy-loaded messages
          if (msg.mentions && msg.mentions.length > 0) {
            text = resolveMentions(text, msg.mentions);
          }
          recordHistoryEntry(historyKey, {
            timestamp: msg.createTime,
            message_id: msg.id,
            user_id: msg.sender,
            user_name: userName,
            text
          });
        }
        console.log(`[feishu] Lazy-loaded ${msgs.length} messages for ${containerType} ${historyKey}`);
      }
      return getInMemoryContext(historyKey, currentMessageId, options);
    }
  } catch (err) {
    console.log(`[feishu] Lazy-load failed for ${containerType} ${historyKey}: ${err.message}`);
  }
  return getInMemoryContext(historyKey, currentMessageId, options);
}

// Resolve user_id (or open_id fallback) to name (with TTL-based in-memory cache)
async function resolveUserName(userId, openId) {
  const id = userId || openId;
  if (!id) return 'unknown';

  // Recognize bot's own messages (exact open_id or app_id match)
  const { openId: botOpenId, appId: botAppId, appName: botAppName } = botIdentity;
  if (botOpenId && id === botOpenId) return botAppName || 'bot';
  if (botAppId && id === botAppId) return botAppName || 'bot';

  const now = Date.now();
  const cached = userCacheMemory.get(id);
  if (cached && cached.expireAt > now) {
    return cached.name;
  }

  try {
    const result = await getUserInfo(id);
    if (result.success && result.user?.name) {
      userCacheMemory.set(id, { name: result.user.name, expireAt: now + SENDER_NAME_TTL });
      _userCacheDirty = true;
      return result.user.name;
    }
    // Check for permission error in the result
    if (!result.success && result.code === 99991672) {
      handlePermissionError({ code: result.code, message: result.message || '' });
    }
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      handlePermissionError(permErr);
    } else {
      console.log(`[feishu] Failed to lookup user ${id}: ${err.message}`);
    }
    // If we have an expired cached name, return it as fallback
    if (cached) return cached.name;
  }
  return id;
}

// Decrypt message if encrypt_key is set (webhook mode only)
function decrypt(encrypt, encryptKey) {
  if (!encryptKey) return null;
  const encryptBuffer = Buffer.from(encrypt, 'base64');
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const iv = encryptBuffer.slice(0, 16);
  const encrypted = encryptBuffer.slice(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

// Log message (mentions resolved to real names for readable context)
// Also records to in-memory chat history for fast context building.
async function logMessage(chatType, chatId, userId, openId, text, messageId, timestamp, mentions, threadId = null) {
  const userName = await resolveUserName(userId, openId);
  const resolvedText = resolveMentions(text, mentions);
  const logEntry = {
    timestamp: timestamp || new Date().toISOString(),
    message_id: messageId,
    user_id: userId,
    open_id: openId,
    user_name: userName,
    text: resolvedText
  };
  const logLine = JSON.stringify(logEntry) + '\n';

  // File log for audit — per thread when applicable
  const logId = chatType === 'p2p' ? userId : chatId;
  const safeLogId = String(logId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeThreadId = threadId ? String(threadId).replace(/[^a-zA-Z0-9_-]/g, '_') : null;
  const logFileName = safeThreadId ? `${safeLogId}_t_${safeThreadId}.log` : `${safeLogId}.log`;
  const logFile = path.resolve(LOGS_DIR, logFileName);
  if (!logFile.startsWith(path.resolve(LOGS_DIR) + path.sep)) {
    console.error(`[feishu] Log path escapes LOGS_DIR: ${logFile}`);
    return;
  }
  try {
    fs.appendFileSync(logFile, logLine);
  } catch (err) {
    console.error(`[feishu] Failed to write log: ${err.message}`);
  }

  // In-memory history for context (group chats and threads)
  // Thread messages go to thread history only (context isolation)
  if (threadId) {
    recordHistoryEntry(getHistoryKey(chatId, threadId), logEntry);
  } else if (chatType === 'group') {
    recordHistoryEntry(chatId, logEntry);
  }

  console.log(`[feishu] Logged: [${userName}] ${(resolvedText || '').substring(0, 30)}...`);
}

// Get group context messages (with API fallback after restart): only what
// came after the last group message Core confirmed (the cursor).
async function getGroupContext(chatId, currentMessageId) {
  return getContextWithFallback(chatId, currentMessageId, 'chat', chatId, null, {
    afterMessageId: groupCursors[chatId] || null
  });
}

// Move the group cursor to a message Core confirmed. Called only through
// markCursorDelivered (after delivery), never before sending.
function updateCursor(chatId, messageId) {
  if (isBehindCursor(chatHistories.get(chatId), groupCursors[chatId], messageId)) {
    // An older @mention confirmed after a newer one: keep the newer cursor.
    console.log(`[feishu] Cursor for ${chatId} already past ${messageId}, not moving it back`);
    return;
  }
  groupCursors[chatId] = messageId;
  if (!saveCursors(groupCursors)) {
    console.log(`[feishu] Failed to persist cursor for ${chatId}`);
  }
}

// ============================================================
// Group policy helpers (references OpenClaw policy.ts patterns)
// ============================================================

/**
 * Resolve per-group config from the groups map.
 * @param {string} chatId
 * @returns {object|undefined} Group config or undefined
 */
function resolveGroupConfig(chatId) {
  const groups = config.groups || {};
  return groups[chatId];
}

/**
 * Check if a group is allowed based on groupPolicy and config.
 * Also handles backward compat with legacy allowed_groups/smart_groups.
 */
function isGroupAllowed(chatId) {
  const normalizedChatId = chatId === undefined || chatId === null ? '' : String(chatId);
  const groupPolicy = config.groupPolicy || 'allowlist';

  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;

  // allowlist mode: check groups map
  const groupConfig = resolveGroupConfig(normalizedChatId);
  if (groupConfig) return true;

  // Backward compat: check legacy arrays if groups map doesn't have this chat
  const legacyAllowed = (config.allowed_groups || []).some(g => String(g.chat_id) === normalizedChatId);
  const legacySmart = (config.smart_groups || []).some(g => String(g.chat_id) === normalizedChatId);
  if (legacyAllowed || legacySmart) return true;

  return false;
}

/**
 * Check if a group is in "smart" mode (receives all messages without @mention).
 */
function isSmartGroup(chatId) {
  const normalizedChatId = chatId === undefined || chatId === null ? '' : String(chatId);
  if ((config.groupPolicy || 'allowlist') === 'disabled') return false;
  const groupConfig = resolveGroupConfig(normalizedChatId);
  if (groupConfig) {
    return groupConfig.mode === 'smart' || groupConfig.requireMention === false;
  }
  // Legacy fallback
  return (config.smart_groups || []).some(g => String(g.chat_id) === normalizedChatId);
}

/**
 * Check if a sender is allowed in a specific group.
 * If the group has an allowFrom list, check it; otherwise allow all.
 */
function isSenderAllowedInGroup(chatId, senderUserId, senderOpenId) {
  const groupConfig = resolveGroupConfig(chatId);
  if (!groupConfig?.allowFrom || groupConfig.allowFrom.length === 0) {
    return true; // No per-group sender restriction
  }
  const allowed = groupConfig.allowFrom.map(s => String(s).toLowerCase());
  const normalizedSenderUserId = senderUserId === undefined || senderUserId === null ? '' : String(senderUserId).toLowerCase();
  const normalizedSenderOpenId = senderOpenId === undefined || senderOpenId === null ? '' : String(senderOpenId).toLowerCase();
  if (allowed.includes('*')) return true;
  if (normalizedSenderUserId && allowed.includes(normalizedSenderUserId)) return true;
  if (normalizedSenderOpenId && allowed.includes(normalizedSenderOpenId)) return true;
  return false;
}

/**
 * Get the history limit for a specific group.
 */
function getGroupHistoryLimit(chatId) {
  const groupConfig = resolveGroupConfig(chatId);
  return groupConfig?.historyLimit || config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
}

/**
 * Get display name for a group.
 */
function getGroupName(chatId) {
  const groupConfig = resolveGroupConfig(chatId);
  if (groupConfig?.name) return groupConfig.name;
  const legacyAllowed = (config.allowed_groups || []).find(g => String(g.chat_id) === String(chatId));
  if (legacyAllowed?.name) return legacyAllowed.name;
  const legacySmart = (config.smart_groups || []).find(g => String(g.chat_id) === String(chatId));
  if (legacySmart?.name) return legacySmart.name;
  return String(chatId || 'unknown');
}

/**
 * Send a message to the agent via C4 (src/lib/c4.js). c4-receive gets
 * FEISHU_INTERNAL_SECRET in its environment, as before.
 */
function sendToC4(source, endpoint, content, onReject, onSuccess = null, options = {}) {
  sendToC4Core(source, endpoint, content, onReject, onSuccess,
    { silentStatus: options.silentStatus === true,
      env: { ...process.env, FEISHU_INTERNAL_SECRET: INTERNAL_SECRET } });
}

// Params shared by every `im.message.get` call.
//
// user_id_type: 'open_id' — NOT 'user_id'. This app holds no user_id-class
//   scope (`contact:user.employee_id:readonly`), which Feishu documents as the
//   gate on the `user_id` field of this endpoint's response, so asking for
//   user_id yields nothing to resolve a name from. It also matches the id
//   namespace used everywhere else here: inbound events carry
//   `sender_id.user_id = null`, and preloadGroupMembers seeds the name cache
//   with open_ids (listChatMembers defaults to member_id_type 'open_id').
// card_msg_content_type: request the ORIGINAL Schema 2.0 card JSON (with
//   body.elements) for interactive/card messages; without it the API returns
//   the transformed form whose top-level elements[] has dropped the markdown
//   body, and a card degrades to the generic "[interactive message]".
const MESSAGE_GET_PARAMS = { user_id_type: 'open_id', card_msg_content_type: 'user_card_content' };

/**
 * Fetch content of a quoted/replied message (best-effort).
 * Returns { sender, text } with resolved sender name.
 */
async function fetchQuotedMessage(messageId) {
  try {
    const { getClient } = await import('./lib/client.js');
    const client = getClient();
    const res = await client.im.message.get({
      path: { message_id: messageId },
      params: MESSAGE_GET_PARAMS,
    });
    if (res.code === 0 && res.data?.items?.[0]) {
      const msg = res.data.items[0];
      const senderName = await resolveUserName(null, msg.sender?.id);
      return { sender: senderName, text: parseMessageItemText(msg, messageId) };
    }
  } catch (err) {
    console.log(`[feishu] Failed to fetch quoted message ${messageId}: ${err.message}`);
  }
  return null;
}

/**
 * Fetch a merge_forward message's items via `im.message.get`.
 * Returns the raw items array (wrapper + children). THROWS on a failed call —
 * see itemsFromResponse: a failure must not degrade into "no child messages".
 */
async function fetchMessageItems(messageId) {
  const { getClient } = await import('./lib/client.js');
  const client = getClient();
  const res = await client.im.message.get({
    path: { message_id: messageId },
    params: MESSAGE_GET_PARAMS,
  });
  return itemsFromResponse(res, messageId);
}

/**
 * Fetch and render a merge_forward (合并转发 /「聊天记录」) message's content.
 *
 * The inbound event carries no content for these — Feishu fixes it to the
 * literal string `Merged and Forwarded Message` (「接收消息内容」§合并转发) — so
 * the child messages must be read back with `im.message.get`. The tree
 * assembly (including the undocumented nested-forward case) lives in
 * lib/merge-forward.js so it can be unit-tested without the network.
 */
async function fetchMergeForwardContent(messageId) {
  try {
    return await renderMergeForward({
      items: await fetchMessageItems(messageId),
      rootId: messageId,
      // Resource markers inside a forward must cite the id of the forward
      // message the bot received, not the child's own id — with the child id
      // Feishu rejects the download (400「图片与消息不匹配」); the outer id
      // downloads the same key. renderMergeForward threads that id down through
      // every nesting level.
      parseItemText: (item, outerId) =>
        parseMessageItemText(item, item.message_id, { resourceMessageId: outerId }),
      resolveSenderName: (item) => resolveUserName(null, item.sender?.id),
      fetchItems: fetchMessageItems,
      log: (msg) => console.log(`[feishu] ${msg}`),
    });
  } catch (err) {
    console.log(`[feishu] Failed to fetch merge_forward content ${messageId}: ${err.message}`);
    return '[merge_forward message, failed to fetch content]';
  }
}

/**
 * Resolve a merge_forward's deferred remote fetch. Call only after the message
 * has passed its DM/group access gate — see extractMessageContent's
 * 'merge_forward' case for why the fetch is deferred that far.
 */
async function resolveMergeForwardText(extracted) {
  if (!extracted.deferredMergeForwardId) return extracted.text;
  return fetchMergeForwardContent(extracted.deferredMergeForwardId);
}

/**
 * Format message for C4
 */
function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

function formatMessage(
  chatType,
  userName,
  text,
  contextMessages = [],
  mediaPath = null,
  { quotedContent, threadContext, threadRootId, groupName, smartHint } = {}
) {
  const prefix = chatType === 'p2p'
    ? '[Feishu DM]'
    : `[Feishu GROUP:${escapeXml(groupName || 'unknown')}]`;
  const safeUserName = escapeXml(userName);
  const safeText = escapeXml(text);
  let parts = [`${prefix} ${safeUserName} said: `];

  if (threadContext && threadContext.length > 0) {
    const lines = [];
    for (const m of threadContext) {
      const line = `[${escapeXml(m.user_name || m.user_id)}]: ${escapeXml(m.text)}`;
      if (threadRootId && m.message_id === threadRootId) {
        lines.push(`<thread-root>\n${line}\n</thread-root>`);
      } else {
        lines.push(line);
      }
    }
    parts.push(`<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`);
  } else if (contextMessages.length > 0) {
    const contextLines = contextMessages.map(m => `[${escapeXml(m.user_name || m.user_id)}]: ${escapeXml(m.text)}`).join('\n');
    parts.push(`<group-context>\n${contextLines}\n</group-context>\n\n`);
  }

  // Include quoted message content if replying to a specific message
  // Skip for thread messages (threadContext present) — context is already provided
  if (quotedContent && !threadContext) {
    const sender = escapeXml(quotedContent.sender || 'unknown');
    const quoted = escapeXml(quotedContent.text || '');
    parts.push(`<replying-to>\n[${sender}]: ${quoted}\n</replying-to>\n\n`);
  }

  if (smartHint) {
    parts.push(`<smart-mode>
Decide whether to respond. Do NOT reply if: the message is unrelated to you,
just casual chat, or doesn't need your input. Only reply when:
1) someone asks a question you can help with,
2) discussing technical topics you know well,
3) someone clearly needs assistance.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>\n\n`);
  }

  parts.push(`<current-message>\n${safeText}\n</current-message>`);

  let message = parts.join('');

  if (mediaPath) {
    message += ` ---- file: ${escapeXml(mediaPath)}`;
  }

  return message;
}

function buildSafeDownloadPath(downloadDir, prefix, fileName) {
  const safeName = path.basename(fileName || 'file').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'file';
  const filePath = path.join(downloadDir, `${prefix}-${safeName}`);
  const resolvedDir = path.resolve(downloadDir);
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    throw new Error('Path traversal blocked');
  }
  return filePath;
}

// Extract content from Feishu message
// Returns imageKeys as array (all images from post messages, or single image)
function extractMessageContent(message) {
  const msgType = message.message_type;
  let content;
  try {
    content = JSON.parse(message.content || '{}');
  } catch {
    console.error(`[feishu] Failed to parse message content: ${String(message.content).slice(0, 100)}`);
    content = {};
  }

  switch (msgType) {
    case 'text':
      return { text: content.text || '', imageKeys: [], fileKey: null, fileName: null };
    case 'post': {
      if (content.content) {
        const { text, imageKeys } = extractPostText(content.content, message.message_id);
        const fullText = content.title ? `[${content.title}] ${text}` : text;
        return { text: fullText, imageKeys, fileKey: null, fileName: null };
      }
      return { text: '', imageKeys: [], fileKey: null, fileName: null };
    }
    case 'image':
      return { text: '', imageKeys: content.image_key ? [content.image_key] : [], fileKey: null, fileName: null };
    case 'file':
      return { text: '', imageKeys: [], fileKey: content.file_key, fileName: content.file_name || 'unknown' };
    case 'audio':
      return { text: `[audio, file_key: ${content.file_key || 'unknown'}, msg_id: ${message.message_id}]`, imageKeys: [], fileKey: null, fileName: null };
    case 'media':
      return { text: `[media: ${content.file_name || 'video'}, file_key: ${content.file_key || 'unknown'}, msg_id: ${message.message_id}]`, imageKeys: [], fileKey: null, fileName: null };
    case 'sticker':
      return { text: `[sticker, file_key: ${content.file_key || 'unknown'}]`, imageKeys: [], fileKey: null, fileName: null };
    case 'interactive':
      return { text: extractInteractiveText(content), imageKeys: [], fileKey: null, fileName: null };
    case 'merge_forward':
      // Deliberately no remote fetch here: this runs before any DM/group access
      // gate in handleMessageEvent, and fetchMergeForwardContent is a live
      // im.message.get call that would otherwise fire (and log its result) for
      // a sender/chat that ends up rejected anyway. The caller resolves
      // deferredMergeForwardId via resolveMergeForwardText() only after the
      // relevant gate has passed.
      return { text: null, imageKeys: [], fileKey: null, fileName: null, deferredMergeForwardId: message.message_id };
    default:
      return { text: `[${msgType} message]`, imageKeys: [], fileKey: null, fileName: null };
  }
}

// Bind owner (first private chat user)
async function bindOwner(userId, openId) {
  const userName = await resolveUserName(userId, openId);
  const previousOwner = config.owner;
  config.owner = {
    bound: true,
    user_id: userId,
    open_id: openId,
    name: userName
  };
  if (!saveConfig(config)) {
    config.owner = previousOwner;
    console.error('[feishu] Failed to persist owner binding');
    return null;
  }
  console.log(`[feishu] Owner bound: ${userName} (${userId})`);
  return userName;
}

// Check if user is owner — rule lives in lib/dm-policy.js (shared with recovery).
function isOwner(userId, openId) {
  return isOwnerByConfig(config, { userId, openId });
}

// Check DM access — dmPolicy + dmAllowFrom, same shared rule.
function isDmAllowed(userId, openId) {
  return isDmAllowedByConfig(config, { userId, openId });
}

// Reply-to (threaded/quoted) sends only make sense in group chats and p2p topic
// threads. In a p2p DM outside a thread they silently drop (Feishu returns code:0
// but the reply is not surfaced in the main view), so this must be chat-type- and
// thread-aware — hence chatType (and threadId when present) are passed.
// Delegates the target decision to chooseReplyTarget (via sendThreadAware) so it
// stays consistent with the outbound send routing.
async function sendThreadAwareMessage(chatId, text, { chatType, rootId, parentId, messageId, threadId } = {}) {
  return sendThreadAware(
    { chatId, text, chatType, rootId, parentId, messageId, threadId },
    { replyToMessage, sendMessage },
  );
}

/**
 * Handle im.message.receive_v1 event.
 * Shared by both websocket and webhook modes.
 *
 * @param {object} data - { message, sender } from the event
 */
async function handleMessage(data) {
  const message = data.message;
  const sender = data.sender;
  const mentions = message.mentions;

  const senderId = sender.sender_id?.open_id || sender.sender_id?.app_id || sender.sender_id?.user_id || '';
  if (senderId && (
    String(senderId) === String(botIdentity.appId || '') ||
    String(senderId) === String(botIdentity.openId || '') ||
    String(senderId) === String(config.app_id || '') ||
    String(senderId) === String(config.bot_open_id || '')
  )) return;

  const senderUserId = sender.sender_id?.user_id;
  const senderOpenId = sender.sender_id?.open_id;
  const chatId = message.chat_id;
  const messageId = message.message_id;
  const chatType = message.chat_type;
  const rootId = message.root_id || null;
  const parentId = message.parent_id || null;
  const threadId = message.thread_id || null;
  const upperMessageId = message.upper_message_id || null;

  // DEBUG: log threading fields for analysis
  console.log(`[feishu] DEBUG threading: msg=${messageId} root=${rootId} parent=${parentId} thread=${threadId} upper=${upperMessageId}`);

  // Unified dedup check (both websocket and webhook modes)
  if (isDuplicate(messageId)) return;

  // If the startup getBotInfo failed and no cached identity exists, the first
  // received message triggers one bounded refetch before any mention check.
  // This is the only place a message waits for the bot identity.
  await botIdentity.ensureForMessage();

  const extracted = extractMessageContent(message);
  let { text } = extracted;
  const { imageKeys, fileKey, fileName } = extracted;
  // A pending merge_forward has no text yet (deliberately not fetched until the
  // DM/group access gate passes below) — log a fixed marker instead of real
  // content from a sender/chat that may end up rejected anyway.
  console.log(`[feishu] ${chatType} message from ${senderUserId}: ${extracted.deferredMergeForwardId ? '[merge_forward, pending access check]' : ((text || '').substring(0, 50) || '[media]')}...`);

  // Build log text with file/image metadata
  let logText = text;
  for (const imgKey of imageKeys) {
    const imageInfo = `[image, image_key: ${imgKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${imageInfo}` : imageInfo;
  }
  if (fileKey) {
    const fileInfo = `[file: ${fileName}, file_key: ${fileKey}, msg_id: ${messageId}]`;
    logText = logText ? `${logText}\n${fileInfo}` : fileInfo;
  }

  // Build structured endpoint with routing metadata
  const endpoint = buildEndpoint(chatId, { chatType, rootId, parentId, messageId, threadId });
  // Remember DM vs group so a bare chat id (proactive send) maps to its
  // session group without an API call (scripts/session-group.js).
  recordChatType(chatId, chatType);

  // quotedContent is fetched lazily after routing eligibility checks
  let quotedContent = null;
  // Thread context for topic messages
  let threadContext = null;

  // Private chat handling
  if (chatType === 'p2p') {
    if (!config.owner?.bound) {
      const boundOwner = await bindOwner(senderUserId, senderOpenId);
      if (!boundOwner) return;
    }

    if (!isDmAllowed(senderUserId, senderOpenId)) {
      console.log(`[feishu] Private message from non-allowed user ${senderUserId} (dmPolicy=${config.dmPolicy || 'owner'}), rejecting`);
      sendMessage(chatId, "Sorry, I'm not available for private messages. Please ask my owner to grant you access.").catch(() => {});
      return;
    }

    if (extracted.deferredMergeForwardId) {
      text = await resolveMergeForwardText(extracted);
      logText = text;
    }

    await logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, data._timestamp || null, mentions, threadId);

    // Add typing indicator
    addTypingIndicator(messageId);

    // Fetch context: thread context for topic messages, quoted content for replies
    if (threadId) {
      const threadHistoryKey = getHistoryKey(chatId, threadId);
      const threadHistoryLimit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
      threadContext = await getContextWithFallback(threadId, messageId, 'thread', threadHistoryKey, threadHistoryLimit);
      // Pin root message first in thread context
      if (threadContext && rootId) {
        threadContext = pinRootMessage(threadContext, rootId, threadHistoryKey);
      }
    } else if (parentId) {
      quotedContent = await fetchQuotedMessage(parentId);
    }

    const senderName = await resolveUserName(senderUserId, senderOpenId);
    const cleanText = resolveMentions(text, mentions);
    const threadRootId = threadId ? rootId : null;
    const rejectReply = createRejectReply({
      removeTyping: () => removeTypingIndicator(messageId),
      deliver: (errMsg) => sendThreadAwareMessage(chatId, errMsg, { chatType, rootId, parentId, messageId, threadId })
        .catch(e => console.error('[feishu] reject reply failed:', e.message))
    });

    // Handle images (lazy download: only when message is being sent to C4)
    if (imageKeys.length > 0) {
      const mediaPaths = [];
      for (const imgKey of imageKeys) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `feishu-${timestamp}-${imgKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8)}.png`);
        const result = await downloadImage(messageId, imgKey, localPath);
        if (result.success) {
          mediaPaths.push(localPath);
        }
      }
      if (mediaPaths.length > 0) {
        const mediaLabel = mediaPaths.length === 1 ? '[image]' : `[${mediaPaths.length} images]`;
        const msg = formatMessage('p2p', senderName, `${mediaLabel}${cleanText ? ' ' + cleanText : ''}`, [], mediaPaths[0], { quotedContent, threadContext, threadRootId });
        sendToC4('feishu', endpoint, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, '[image download failed]', [], null, { quotedContent, threadContext, threadRootId });
        sendToC4('feishu', endpoint, msg, rejectReply);
      }
      return;
    }

    if (fileKey) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let localPath = null;
      try {
        localPath = buildSafeDownloadPath(MEDIA_DIR, `feishu-${timestamp}`, fileName);
      } catch (err) {
        console.warn(`[feishu] Blocked unsafe file path: ${err.message}`);
      }
      const result = localPath ? await downloadFile(messageId, fileKey, localPath) : { success: false };
      if (result.success && localPath) {
        const msg = formatMessage('p2p', senderName, `[file: ${fileName}]`, [], localPath, { quotedContent, threadContext, threadRootId });
        sendToC4('feishu', endpoint, msg, rejectReply);
      } else {
        const msg = formatMessage('p2p', senderName, `[file download failed: ${fileName}]`, [], null, { quotedContent, threadContext, threadRootId });
        sendToC4('feishu', endpoint, msg, rejectReply);
      }
      return;
    }

    const msg = formatMessage('p2p', senderName, cleanText, [], null, { quotedContent, threadContext, threadRootId });
    sendToC4('feishu', endpoint, msg, rejectReply);
    return;
  }

  // Group chat handling
  if (chatType === 'group') {
    const mentioned = isBotMentioned(mentions, botIdentity.openId);
    const senderIsOwner = isOwner(senderUserId, senderOpenId);
    const groupPolicy = config.groupPolicy || 'allowlist';
    if (groupPolicy === 'disabled') {
      if (mentioned) {
        replyToMessage(messageId, "Sorry, group chat is currently disabled.").catch(() => {});
      }
      console.log(`[feishu] Group policy disabled, ignoring group message from ${senderUserId}`);
      return;
    }
    const allowedGroup = isGroupAllowed(chatId);
    const smart = isSmartGroup(chatId);
    const smartNoMention = smart && !mentioned;

    if (!allowedGroup && !(senderIsOwner && mentioned)) {
      if (mentioned) {
        console.log(`[feishu] Group ${chatId} not allowed by policy, rejecting`);
        replyToMessage(messageId, "Sorry, I'm not available in this group.").catch(() => {});
      } else {
        console.log(`[feishu] Group ${chatId} not allowed by policy, ignoring`);
      }
      return;
    }

    if (!isSenderAllowedInGroup(chatId, senderUserId, senderOpenId) && !senderIsOwner) {
      if (mentioned) {
        console.log(`[feishu] Sender ${senderUserId} not in group ${chatId} allowFrom, rejecting`);
        replyToMessage(messageId, "Sorry, you don't have permission to interact with me in this group.").catch(() => {});
      } else {
        console.log(`[feishu] Sender ${senderUserId} not in group ${chatId} allowFrom, ignoring`);
      }
      return;
    }

    if (extracted.deferredMergeForwardId) {
      text = await resolveMergeForwardText(extracted);
      logText = text;
    }

    if (!smart && !mentioned) {
      if (allowedGroup) {
        await logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, data._timestamp || null, mentions, threadId);
      }
      console.log(`[feishu] Group message without @mention, logged only`);
      return;
    }

    // Group user access is controlled by groupPolicy + groups config + per-group allowFrom.
    // No separate user-level whitelist for groups (dmPolicy/dmAllowFrom only applies to DMs).

    await logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, data._timestamp || null, mentions, threadId);

    console.log(`[feishu] ${smart ? 'Smart group' : 'Bot @mentioned in'} group ${chatId}`);
    await preloadGroupMembers(chatId);
    const contextMessages = await getGroupContext(chatId, messageId);
    // The cursor moves only once Core confirms delivery (sent, or stored then
    // rejected). TRY_LATER / MAYBE_LOST, a throw below, or a crash before Core
    // answers leave it where it was, so the next @mention still carries this
    // message as context.
    const markCursorDelivered = createCursorMarker(() => updateCursor(chatId, messageId));

    // Smart mode without @mention may skip reply entirely ([SKIP]), so do not show typing.
    if (!smartNoMention) {
      addTypingIndicator(messageId);
    }

    // Fetch context: thread context for topic messages, quoted content for replies
    if (threadId) {
      const threadHistoryKey = getHistoryKey(chatId, threadId);
      const threadHistoryLimit = getGroupHistoryLimit(chatId);
      threadContext = await getContextWithFallback(threadId, messageId, 'thread', threadHistoryKey, threadHistoryLimit);
      // Pin root message first in thread context
      if (threadContext && rootId) {
        threadContext = pinRootMessage(threadContext, rootId, threadHistoryKey);
      }
    } else if (parentId) {
      quotedContent = await fetchQuotedMessage(parentId);
    }

    const senderName = await resolveUserName(senderUserId, senderOpenId);
    const cleanText = resolveMentions(text, mentions);
    const cleanLogText = resolveMentions(logText, mentions);
    const threadRootId = threadId ? rootId : null;
    const silentGroup = config.c4?.smartNoMentionSilent === true && smartNoMention;
    const groupRejectReply = createRejectReply({
      silent: silentGroup,
      removeTyping: () => removeTypingIndicator(messageId),
      onStored: markCursorDelivered,
      deliver: (errMsg) => sendThreadAwareMessage(chatId, errMsg, { chatType, rootId, parentId, messageId, threadId })
        .catch(e => console.error('[feishu] reject reply failed:', e.message))
    });

    // Handle images (lazy download: only for messages being sent to C4)
    if (imageKeys.length > 0) {
      if (smartNoMention) {
        const msg = formatMessage('group', senderName, cleanLogText || '[image]', contextMessages, null, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId), smartHint: true });
        sendToC4('feishu', endpoint, msg, groupRejectReply, markCursorDelivered, { silentStatus: silentGroup });
        return;
      }

      const mediaPaths = [];
      for (const imgKey of imageKeys) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(MEDIA_DIR, `feishu-group-${timestamp}-${imgKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(-8)}.png`);
        const result = await downloadImage(messageId, imgKey, localPath);
        if (result.success) {
          mediaPaths.push(localPath);
        }
      }
      if (mediaPaths.length > 0) {
        const mediaLabel = mediaPaths.length === 1 ? '[image]' : `[${mediaPaths.length} images]`;
        const msg = formatMessage('group', senderName, `${mediaLabel}${cleanText ? ' ' + cleanText : ''}`, contextMessages, mediaPaths[0], { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId) });
        sendToC4('feishu', endpoint, msg, groupRejectReply, markCursorDelivered, { silentStatus: silentGroup });
      } else {
        removeTypingIndicator(messageId);
        sendThreadAwareMessage(chatId, 'Image download failed. Please resend the image.', { chatType, rootId, parentId, messageId, threadId })
          .catch(e => console.error('[feishu] image error reply failed:', e.message));
      }
      return;
    }

    if (fileKey) {
      if (smartNoMention) {
        const msg = formatMessage('group', senderName, cleanLogText || `[file: ${fileName}]`, contextMessages, null, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId), smartHint: true });
        sendToC4('feishu', endpoint, msg, groupRejectReply, markCursorDelivered, { silentStatus: silentGroup });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      let localPath = null;
      try {
        localPath = buildSafeDownloadPath(MEDIA_DIR, `feishu-group-${timestamp}`, fileName);
      } catch (err) {
        console.warn(`[feishu] Blocked unsafe file path: ${err.message}`);
      }
      const result = localPath ? await downloadFile(messageId, fileKey, localPath) : { success: false };
      if (result.success && localPath) {
        const msg = formatMessage('group', senderName, `[file: ${fileName}]${cleanText ? ' ' + cleanText : ''}`, contextMessages, localPath, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId) });
        sendToC4('feishu', endpoint, msg, groupRejectReply, markCursorDelivered, { silentStatus: silentGroup });
      } else {
        removeTypingIndicator(messageId);
        sendThreadAwareMessage(chatId, 'File download failed. Please resend the file.', { chatType, rootId, parentId, messageId, threadId })
          .catch(e => console.error('[feishu] file error reply failed:', e.message));
      }
      return;
    }

    const msg = formatMessage('group', senderName, cleanText || text, contextMessages, null, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId), smartHint: smartNoMention });
    sendToC4('feishu', endpoint, msg, groupRejectReply, markCursorDelivered, { silentStatus: silentGroup });
  }
}

// ============================================================
// Transport: WebSocket mode (Feishu SDK WSClient)
// ============================================================

function startWebSocket(creds) {
  wsClient = new Lark.WSClient({
    appId: creds.app_id,
    appSecret: creds.app_secret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
    logger: createRedactingLogger(),
    autoReconnect: true
  });

  console.log('[feishu] Connecting to Feishu via WebSocket...');

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({ logger: createRedactingLogger() }).register({
      'card.action.trigger': createCardActionHandler({
        appId: creds.app_id,
        getSettings: () => config.card_actions,
        logger: createRedactingLogger()
      }),
      'im.message.receive_v1': async (data) => {
        try {
          await handleMessage(data);
        } catch (err) {
          console.error(`[feishu] Error handling message: ${err.message}`);
        }
      }
    })
  });
}

// ============================================================
// Transport: Webhook mode (Express HTTP server)
// ============================================================

function startWebhook(creds) {
  const PORT = config.webhook_port || 3458;

  // Dedup is now handled at handleMessage() level (shared by both modes)

  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    console.log('[feishu] Received webhook request');

    let event = req.body;

    // Handle encrypted events
    if (event.encrypt && config.bot?.encrypt_key) {
      try {
        event = decrypt(event.encrypt, config.bot.encrypt_key);
      } catch (err) {
        console.error('[feishu] Decryption failed:', err.message);
        return res.status(400).json({ error: 'Decryption failed' });
      }
    }

    // Verify token (required for webhook mode)
    const verificationToken = config.bot?.verification_token;
    if (!verificationToken) {
      console.error('[feishu] verification_token not configured — rejecting request. Set bot.verification_token in config.json.');
      return res.status(500).json({ error: 'Server misconfigured: verification_token missing' });
    }
    const eventToken = event.token || event.header?.token;
    if (eventToken !== verificationToken) {
      console.warn(`[feishu] Verification token mismatch, rejecting request`);
      return res.status(403).json({ error: 'Token verification failed' });
    }

    // URL Verification Challenge
    if (event.type === 'url_verification') {
      console.log('[feishu] URL verification challenge received');
      return res.json({ challenge: event.challenge });
    }

    // Respond immediately to prevent Feishu retry (timeout ~15s)
    res.json({ code: 0 });

    // Handle message event asynchronously
    if (event.header?.event_type === 'im.message.receive_v1') {
      // Validate required payload shape
      if (!event.event?.message || !event.event?.sender) {
        console.warn('[feishu] Malformed message event: missing event.message or event.sender');
        return;
      }
      // Dedup is handled inside handleMessage() (unified for both modes)

      // Normalize data shape to match WSClient format for shared handleMessage
      const data = {
        message: event.event.message,
        sender: event.event.sender,
        _timestamp: event.header.create_time
      };
      handleMessage(data).catch(err => {
        console.error(`[feishu] Error handling message: ${err.message}`);
      });
    }
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'zylos-feishu',
      mode: 'webhook',
      cursors: Object.keys(groupCursors).length,
      botIdentity: botIdentity.status()
    });
  });

  // Internal endpoint: record bot's outgoing messages into in-memory history
  app.post('/internal/record-outgoing', (req, res) => {
    // Validate internal token (process-local secret) to prevent unauthorized injection
    const token = req.headers['x-internal-token'];
    if (!token || token !== INTERNAL_SECRET) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    const { chatId, threadId, text, messageId } = req.body || {};
    if (!text) return res.status(400).json({ error: 'missing text' });
    const entry = {
      timestamp: new Date().toISOString(),
      message_id: messageId || `bot_${Date.now()}`,
      user_id: botIdentity.openId || 'bot',
      user_name: botIdentity.appName || 'bot',
      text
    };
    // Thread messages go to thread only (context isolation)
    if (threadId) {
      recordHistoryEntry(getHistoryKey(chatId, threadId), entry);
    } else if (chatId) {
      recordHistoryEntry(chatId, entry);
    }
    res.json({ ok: true });
  });

  const maxRetries = 5;
  const retryDelayMs = 1000;
  let attempt = 0;

  const listenWithRetry = () => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      webhookServer = server;
      console.log(`[feishu] Webhook server running on 127.0.0.1:${PORT}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
        attempt += 1;
        console.warn(`[feishu] Port ${PORT} in use, retrying (${attempt}/${maxRetries})...`);
        try { server.close(); } catch {}
        setTimeout(listenWithRetry, retryDelayMs);
        return;
      }
      console.error(`[feishu] Webhook server failed: ${err.message}`);
      process.exit(1);
    });
  };

  listenWithRetry();
}

// ============================================================
// Startup
// ============================================================

// Graceful shutdown
function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[feishu] Shutting down...`);

  clearInterval(dedupCleanupInterval);
  clearInterval(typingCheckInterval);
  clearInterval(userCachePersistInterval);
  botIdentity.stop();

  stopWatching();
  persistUserCache();

  for (const [messageId, state] of activeTypingIndicators.entries()) {
    clearTimeout(state.timer);
    if (state.reactionId) {
      removeReaction(messageId, state.reactionId).catch(() => {});
    }
    activeTypingIndicators.delete(messageId);
  }

  if (wsClient) {
    wsClient.close({ force: false });
  }

  const finalizeExit = () => process.exit(0);
  if (webhookServer) {
    webhookServer.close(() => finalizeExit());
    setTimeout(finalizeExit, 1000).unref();
  } else {
    finalizeExit();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Validate credentials
const creds = getCredentials();

if (!creds.app_id || !creds.app_secret) {
  console.error('[feishu] FEISHU_APP_ID and FEISHU_APP_SECRET must be set in ~/zylos/.env');
  process.exit(1);
}

// Fetch bot identity, then start the selected transport
(async () => {
  await botIdentity.fetchAtStartup();

  // Start selected transport
  if (connectionMode === 'webhook') {
    startWebhook(creds);
  } else {
    startWebSocket(creds);
  }
})();
