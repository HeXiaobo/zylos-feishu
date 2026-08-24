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
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

// Load .env from ~/zylos/.env (absolute path, not cwd-dependent)
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';
import { downloadImage, downloadFile, sendMessage, replyToMessage, extractPermissionError, addReaction, removeReaction, listMessages } from './lib/message.js';
import { getUserInfo } from './lib/contact.js';
import { listChatMembers } from './lib/chat.js';
import { sendThreadAware } from './lib/reply-send.js';
import { extractInteractiveText } from './lib/card-text.js';
import { renderMergeForward, itemsFromResponse } from './lib/merge-forward.js';
import { createTaskActionContextSigner } from './lib/task-action-context.js';
import {
  createTaskCardActionRuntime,
  createTaskCardEventHandlers,
  routeVerifiedWebhookEvent,
} from './lib/task-card-runtime.js';
import {
  buildC4ReceiveArgs,
  buildZylosTaskCommandArgs,
  isExplicitTaskProtocolMessage,
  parseExplicitTaskMessage,
} from './lib/task-entry.js';

// C4 receive interface path
const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const ZYLOS_CLI = process.env.ZYLOS_CLI_PATH
  || path.join(process.env.HOME, '.local/bin/zylos');

let taskActionContextSigner = null;
if (process.env.FEISHU_TASK_CONTEXT_SECRET) {
  try {
    taskActionContextSigner = createTaskActionContextSigner({
      secret: process.env.FEISHU_TASK_CONTEXT_SECRET,
      clock: Date.now,
    });
  } catch (error) {
    console.error(`[feishu] Signed task actions disabled: ${error.message}`);
  }
}

// Bot identity (fetched at startup)
let botOpenId = '';
let botAppId = '';
let botAppName = '';

// WSClient instance for graceful shutdown (websocket mode only)
let wsClient = null;
let webhookServer = null;
let isShuttingDown = false;

// Initialize
let config = getConfig();
const connectionMode = config.connection_mode || 'websocket';
const INTERNAL_SECRET = crypto.randomUUID();
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

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) {
    console.log(`[feishu] Duplicate message_id ${messageId}, skipping`);
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

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[feishu] Config reloaded`);
  config = newConfig;
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
 * Get recent context messages from in-memory history.
 * Excludes the current message itself.
 */
function getInMemoryContext(historyKey, currentMessageId) {
  const history = chatHistories.get(historyKey);
  if (!history || history.length === 0) return [];

  const baseChatId = historyKey.includes(':') ? historyKey.split(':')[0] : historyKey;
  const limit = getGroupHistoryLimit(baseChatId);

  // Filter out the current message and get recent entries
  const filtered = history.filter(m => m.message_id !== currentMessageId);
  const count = Math.min(limit, filtered.length);
  return filtered.slice(-count);
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

async function getContextWithFallback(containerId, currentMessageId, containerType = 'chat', historyKey = containerId, historyLimit = null) {
  if (_lazyLoadedContainers.has(historyKey)) {
    return getInMemoryContext(historyKey, currentMessageId);
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
      return getInMemoryContext(historyKey, currentMessageId);
    }
  } catch (err) {
    console.log(`[feishu] Lazy-load failed for ${containerType} ${historyKey}: ${err.message}`);
  }
  return getInMemoryContext(historyKey, currentMessageId);
}

// Resolve user_id (or open_id fallback) to name (with TTL-based in-memory cache)
async function resolveUserName(userId, openId) {
  const id = userId || openId;
  if (!id) return 'unknown';

  // Recognize bot's own messages (exact open_id or app_id match)
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

// Get group context messages (with API fallback after restart)
async function getGroupContext(chatId, currentMessageId) {
  return getContextWithFallback(chatId, currentMessageId, 'chat');
}

function updateCursor(chatId, messageId) {
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

// Check if bot is mentioned
function isBotMentioned(mentions, botId) {
  if (!mentions || !Array.isArray(mentions)) return false;
  const normalizedBotId = botId === undefined || botId === null ? '' : String(botId);
  return mentions.some(m => {
    const mentionId = m.id?.open_id || m.id?.user_id || m.id?.app_id || '';
    return (normalizedBotId && String(mentionId) === normalizedBotId) || m.key === '@_all';
  });
}

/**
 * Resolve @_user_N placeholders in message text to real names.
 * Feishu replaces @mentions with @_user_1, @_user_2, etc. in the raw text.
 * The mentions array contains the mapping: { key: "@_user_1", name: "Name", id: { ... } }
 */
function resolveMentions(text, mentions, { stripBot = false, botOpenId: botId } = {}) {
  if (!text || !mentions || !Array.isArray(mentions) || mentions.length === 0) return text;

  let resolved = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const isBotMention = botId && (m.id?.open_id === botId || m.id?.app_id === botId);
    if (stripBot && isBotMention) {
      resolved = resolved.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '');
    } else if (m.name) {
      resolved = resolved.replace(m.key, `@${m.name}`);
    }
  }
  return resolved.trim();
}

/**
 * Parse c4-receive JSON response from stdout.
 */
function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Send message to Claude via C4 (with 1 retry on unexpected failure).
 * Explicit task intents atomically carry their normalized envelope.
 */
function sendToC4(source, endpoint, content, onReject, { taskEnvelope } = {}) {
  if (!content) {
    console.error('[feishu] sendToC4 called with empty content');
    return;
  }
  const childEnv = { ...process.env, FEISHU_INTERNAL_SECRET: INTERNAL_SECRET };
  const args = buildC4ReceiveArgs({
    receiverPath: C4_RECEIVE,
    source,
    endpoint,
    content,
    taskEnvelope,
  });

  execFile('node', args, { encoding: 'utf8', timeout: 35000, env: childEnv }, (error, stdout) => {
    if (!error) {
      console.log(`[feishu] Sent to C4: ${content.substring(0, 50)}...`);
      return;
    }
    const response = parseC4Response(error.stdout || stdout);
    if (response && response.ok === false && response.error?.message) {
      console.warn(`[feishu] C4 rejected (${response.error.code}): ${response.error.message}`);
      if (onReject) onReject(response.error.message);
      return;
    }
    console.warn(`[feishu] C4 send failed, retrying in 2s: ${error.message}`);
    setTimeout(() => {
      execFile('node', args, { encoding: 'utf8', timeout: 35000, env: childEnv }, (retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[feishu] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return;
        }
        const retryResponse = parseC4Response(retryError.stdout || retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          console.error(`[feishu] C4 rejected after retry (${retryResponse.error.code}): ${retryResponse.error.message}`);
          if (onReject) onReject(retryResponse.error.message);
        } else {
          console.error(`[feishu] C4 send failed after retry: ${retryError.message}`);
        }
      });
    }, 2000);
  });
}

function verifyTaskActionContext(token) {
  if (!taskActionContextSigner) {
    throw new Error('signed task actions are not configured');
  }
  return taskActionContextSigner.verify(token);
}

function executeTaskAction(taskAction) {
  const args = buildZylosTaskCommandArgs(taskAction);
  return new Promise((resolve, reject) => {
    execFile(ZYLOS_CLI, args, {
      encoding: 'utf8',
      timeout: 35000,
      env: process.env,
    }, (error, stdout) => {
      if (!error) {
        resolve(parseC4Response(stdout) || { ok: true });
        return;
      }
      const response = parseC4Response(error.stdout || stdout);
      const message = response?.error?.message || error.message;
      reject(new Error(message));
    });
  });
}

let taskCardActionRuntime = null;

function getTaskCardActionRuntime() {
  if (!taskActionContextSigner) {
    throw new Error('signed task actions are not configured');
  }
  if (!taskCardActionRuntime) {
    taskCardActionRuntime = createTaskCardActionRuntime({
      verifyTaskActionContext,
      executeTaskAction,
    });
  }
  return taskCardActionRuntime;
}

async function handleTaskCardAction(event) {
  return getTaskCardActionRuntime().handle(event);
}

const taskCardEventHandlers = createTaskCardEventHandlers({
  handleTaskCardAction,
  onError(error) {
    console.error(`[feishu] Task card action rejected: ${error.message}`);
  },
});

function parseAuthorizedTaskMessage(message, text, actorId) {
  return parseExplicitTaskMessage({
    messageType: message.message_type,
    text,
    messageId: message.message_id,
    actorId,
  }, {
    verifyTaskActionContext,
  });
}

async function handleAuthorizedTaskInput({
  message,
  text,
  actorId,
  chatType,
  chatId,
  senderUserId,
  senderOpenId,
  messageId,
  timestamp,
  mentions,
  threadId,
  rootId,
  parentId,
}) {
  let route;
  try {
    route = parseAuthorizedTaskMessage(message, text, actorId);
  } catch (error) {
    console.warn(`[feishu] Explicit task input rejected: ${error.message}`);
    sendThreadAwareMessage(
      chatId,
      'Task input rejected. Check the explicit command and signed context.',
      { chatType, rootId, parentId, messageId },
    ).catch(e => console.error('[feishu] task input reject reply failed:', e.message));
    return { handled: true, route: null };
  }

  if (route?.kind !== 'task-action') {
    return { handled: false, route };
  }

  await logMessage(
    chatType,
    chatId,
    senderUserId,
    senderOpenId,
    `[signed task action: ${route.command.type}]`,
    messageId,
    timestamp,
    mentions,
    threadId,
  );
  addTypingIndicator(messageId);
  executeTaskAction(route)
    .then(() => console.log(`[feishu] Applied ${route.command.type} to ${route.command.taskId}`))
    .catch((error) => {
      console.error(`[feishu] Task action failed: ${error.message}`);
      sendThreadAwareMessage(
        chatId,
        'Task action rejected. Refresh the task state and try again.',
        { chatType, rootId, parentId, messageId },
      ).catch(e => console.error('[feishu] task action reject reply failed:', e.message));
    })
    .finally(() => removeTypingIndicator(messageId));
  return { handled: true, route };
}

/**
 * Build structured endpoint string for C4.
 * Format: chatId|type:group|root:rootId|parent:parentId|msg:messageId
 * C4 treats endpoint as opaque string; send.js parses it.
 */
function buildEndpoint(chatId, { chatType, rootId, parentId, messageId, threadId } = {}) {
  let endpoint = chatId;
  if (chatType) {
    endpoint += `|type:${chatType}`;
  }
  if (rootId) {
    endpoint += `|root:${rootId}`;
  }
  if (parentId) {
    endpoint += `|parent:${parentId}`;
  }
  if (messageId) {
    endpoint += `|msg:${messageId}`;
  }
  if (threadId) {
    endpoint += `|thread:${threadId}`;
  }
  return endpoint;
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
 * Parse the msg_type/body.content of a single Feishu message item (as returned
 * by `im.message.get`) into display text, resolving mentions if present.
 *
 * NOTE on resource keys: image/file/audio keys are rendered as inert text
 * markers only. For merge-forward children they are NOT downloadable at all —
 * Feishu returns error 234043 for the wrapper's id, a child's id, or a card
 * message id (「获取消息中的资源文件」§使用限制) — so they must never be fed
 * into the normal download path.
 */
function parseMessageItemText(msg, fallbackMessageId) {
  const messageId = msg.message_id || fallbackMessageId;
  // body.content is not guaranteed to be JSON for every msg_type — a nested
  // forward-of-a-forward can come back as a bare "Merged and Forwarded
  // Message" string rather than a JSON payload.
  let content;
  try {
    content = JSON.parse(msg.body?.content || '{}');
  } catch {
    content = {};
  }
  let text;
  if (msg.msg_type === 'text') {
    text = content.text || '';
  } else if (msg.msg_type === 'post') {
    ({ text } = extractPostText(content.content || [], messageId));
    if (content.title) text = `[${content.title}] ${text}`;
  } else if (msg.msg_type === 'interactive') {
    text = extractInteractiveText(content);
  } else if (msg.msg_type === 'file') {
    text = `[file: ${content.file_name || 'unknown'}, file_key: ${content.file_key}, msg_id: ${messageId}]`;
  } else if (msg.msg_type === 'image') {
    text = `[image, image_key: ${content.image_key}, msg_id: ${messageId}]`;
  } else if (msg.msg_type === 'audio') {
    text = `[audio, file_key: ${content.file_key}, msg_id: ${messageId}]`;
  } else if (msg.msg_type === 'media') {
    text = `[media: ${content.file_name || 'video'}, file_key: ${content.file_key}, msg_id: ${messageId}]`;
  } else if (msg.msg_type === 'sticker') {
    text = `[sticker, file_key: ${content.file_key || 'unknown'}]`;
  } else if (msg.msg_type === 'merge_forward') {
    text = '[nested merge_forward message]';
  } else {
    text = `[${msg.msg_type} message]`;
  }
  if (msg.mentions && msg.mentions.length > 0) {
    text = resolveMentions(text, msg.mentions);
  }
  return text;
}

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
      parseItemText: (item) => parseMessageItemText(item, item.message_id),
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

/**
 * Extract text from a Feishu post (rich text) message.
 * Post messages have nested arrays: paragraphs > elements.
 * Each element has a tag (text, at, a, img, media, emotion).
 *
 * @param {Array} paragraphs - content.content array from post message
 * @param {string} messageId - message ID for lazy media references
 * @returns {{ text: string, imageKeys: string[] }} Extracted text and image keys
 */
function extractPostText(paragraphs, messageId) {
  const imageKeys = [];
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];

    for (const el of paragraph) {
      switch (el.tag) {
        case 'text':
          parts.push(el.text || '');
          break;
        case 'at':
          parts.push(`@${el.user_name || el.user_id || 'unknown'}`);
          break;
        case 'a':
          if (el.href) {
            parts.push(`${el.text || ''}(${el.href})`);
          } else {
            parts.push(el.text || '');
          }
          break;
        case 'img':
          if (el.image_key) {
            imageKeys.push(el.image_key);
            parts.push(`[image, image_key: ${el.image_key}, msg_id: ${messageId}]`);
          }
          break;
        case 'media':
          parts.push(`[media, file_key: ${el.file_key || 'unknown'}, msg_id: ${messageId}]`);
          break;
        case 'emotion':
          parts.push(el.emoji_type ? `[${el.emoji_type}]` : '');
          break;
        default:
          if (el.text) parts.push(el.text);
          break;
      }
    }

    lines.push(parts.join(''));
  }

  return { text: lines.join('\n'), imageKeys };
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

// Check if user is owner
function isOwner(userId, openId) {
  if (!config.owner?.bound) return false;
  const ownerUserId = config.owner.user_id;
  const ownerOpenId = config.owner.open_id;
  return (ownerUserId !== undefined && ownerUserId !== null && userId !== undefined && userId !== null && String(ownerUserId) === String(userId))
    || (ownerOpenId !== undefined && ownerOpenId !== null && openId !== undefined && openId !== null && String(ownerOpenId) === String(openId));
}

// Check DM access — uses dmPolicy + dmAllowFrom
function isDmAllowed(userId, openId) {
  if (isOwner(userId, openId)) return true;
  const policy = config.dmPolicy || 'owner';
  if (policy === 'open') return true;
  if (policy === 'owner') return false;
  // policy === 'allowlist'
  const allowFrom = (Array.isArray(config.dmAllowFrom) ? config.dmAllowFrom : []).map(String);
  const normalizedUserId = userId === undefined || userId === null ? '' : String(userId);
  const normalizedOpenId = openId === undefined || openId === null ? '' : String(openId);
  return (normalizedUserId && allowFrom.includes(normalizedUserId)) ||
    (normalizedOpenId && allowFrom.includes(normalizedOpenId));
}

// Reply-to (threaded/quoted) sends only make sense in group chats. In a p2p DM
// they silently drop (Feishu returns code:0 but the reply is not surfaced in the
// main view), so this must be chat-type-aware — hence chatType is required.
// Delegates the target decision to chooseReplyTarget (via sendThreadAware) so it
// stays consistent with the outbound send routing.
async function sendThreadAwareMessage(chatId, text, { chatType, rootId, parentId, messageId } = {}) {
  return sendThreadAware(
    { chatId, text, chatType, rootId, parentId, messageId },
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
    String(senderId) === String(botAppId || '') ||
    String(senderId) === String(botOpenId || '') ||
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

  const extracted = extractMessageContent(message);
  let { text } = extracted;
  const { imageKeys, fileKey, fileName } = extracted;
  const explicitTaskText = resolveMentions(text, mentions, {
    stripBot: true,
    botOpenId,
  });
  const hasExplicitTaskProtocol = isExplicitTaskProtocolMessage({
    messageType: message.message_type,
    text: explicitTaskText,
  });
  // A pending merge_forward has no text yet (deliberately not fetched until the
  // DM/group access gate passes below) — log a fixed marker instead of real
  // content from a sender/chat that may end up rejected anyway.
  const messagePreview = extracted.deferredMergeForwardId
    ? '[merge_forward, pending access check]'
    : hasExplicitTaskProtocol
      ? '[explicit task protocol]'
      : ((text || '').substring(0, 50) || '[media]');
  console.log(`[feishu] ${chatType} message from ${senderUserId}: ${messagePreview}...`);

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
  if (hasExplicitTaskProtocol) {
    logText = '[explicit task protocol]';
  }

  // Build structured endpoint with routing metadata
  const endpoint = buildEndpoint(chatId, { chatType, rootId, parentId, messageId, threadId });

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

    const taskInput = await handleAuthorizedTaskInput({
      message,
      text: explicitTaskText,
      actorId: senderOpenId || senderUserId,
      chatType,
      chatId,
      senderUserId,
      senderOpenId,
      messageId,
      timestamp: data._timestamp || null,
      mentions,
      threadId,
      rootId,
      parentId,
    });
    if (taskInput.handled) return;
    const taskRoute = taskInput.route;

    if (taskRoute?.kind === 'task-intent') {
      logText = `[task intent] ${taskRoute.taskEnvelope.task.title}`;
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
    const rejectReply = (errMsg) => {
      removeTypingIndicator(messageId);
      sendThreadAwareMessage(chatId, errMsg, { chatType, rootId, parentId, messageId })
        .catch(e => console.error('[feishu] reject reply failed:', e.message));
    };

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
    sendToC4('feishu', endpoint, msg, rejectReply, {
      taskEnvelope: taskRoute?.kind === 'task-intent'
        ? taskRoute.taskEnvelope
        : undefined,
    });
    return;
  }

  // Group chat handling
  if (chatType === 'group') {
    const mentioned = isBotMentioned(mentions, botOpenId);
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

    const taskInput = await handleAuthorizedTaskInput({
      message,
      text: explicitTaskText,
      actorId: senderOpenId || senderUserId,
      chatType,
      chatId,
      senderUserId,
      senderOpenId,
      messageId,
      timestamp: data._timestamp || null,
      mentions,
      threadId,
      rootId,
      parentId,
    });
    if (taskInput.handled) return;
    const taskRoute = taskInput.route;

    if (taskRoute?.kind === 'task-intent') {
      logText = `[task intent] ${taskRoute.taskEnvelope.task.title}`;
    }

    await logMessage(chatType, chatId, senderUserId, senderOpenId, logText, messageId, data._timestamp || null, mentions, threadId);

    console.log(`[feishu] ${smart ? 'Smart group' : 'Bot @mentioned in'} group ${chatId}`);
    await preloadGroupMembers(chatId);
    const contextMessages = await getGroupContext(chatId, messageId);
    updateCursor(chatId, messageId);

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
    const groupRejectReply = (errMsg) => {
      removeTypingIndicator(messageId);
      sendThreadAwareMessage(chatId, errMsg, { chatType, rootId, parentId, messageId })
        .catch(e => console.error('[feishu] reject reply failed:', e.message));
    };

    // Handle images (lazy download: only for messages being sent to C4)
    if (imageKeys.length > 0) {
      if (smartNoMention) {
        const msg = formatMessage('group', senderName, cleanLogText || '[image]', contextMessages, null, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId), smartHint: true });
        sendToC4('feishu', endpoint, msg, groupRejectReply);
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
        sendToC4('feishu', endpoint, msg, groupRejectReply);
      } else {
        removeTypingIndicator(messageId);
        sendThreadAwareMessage(chatId, 'Image download failed. Please resend the image.', { chatType, rootId, parentId, messageId })
          .catch(e => console.error('[feishu] image error reply failed:', e.message));
      }
      return;
    }

    if (fileKey) {
      if (smartNoMention) {
        const msg = formatMessage('group', senderName, cleanLogText || `[file: ${fileName}]`, contextMessages, null, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId), smartHint: true });
        sendToC4('feishu', endpoint, msg, groupRejectReply);
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
        sendToC4('feishu', endpoint, msg, groupRejectReply);
      } else {
        removeTypingIndicator(messageId);
        sendThreadAwareMessage(chatId, 'File download failed. Please resend the file.', { chatType, rootId, parentId, messageId })
          .catch(e => console.error('[feishu] file error reply failed:', e.message));
      }
      return;
    }

    const msg = formatMessage('group', senderName, cleanText || text, contextMessages, null, { quotedContent, threadContext, threadRootId, groupName: getGroupName(chatId), smartHint: smartNoMention });
    sendToC4('feishu', endpoint, msg, groupRejectReply, {
      taskEnvelope: taskRoute?.kind === 'task-intent'
        ? taskRoute.taskEnvelope
        : undefined,
    });
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
    autoReconnect: true
  });

  console.log('[feishu] Connecting to Feishu via WebSocket...');

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await handleMessage(data);
        } catch (err) {
          console.error(`[feishu] Error handling message: ${err.message}`);
        }
      },
      ...taskCardEventHandlers,
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

  app.post('/webhook', async (req, res) => {
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

    const eventType = event.header?.event_type;
    let callback;
    try {
      callback = await routeVerifiedWebhookEvent(
        event,
        taskCardEventHandlers['card.action.trigger'],
      );
    } catch (error) {
      console.error(`[feishu] Task card callback failed: ${error.message}`);
      return res.status(503).json({ error: 'Task card action unavailable' });
    }

    if (eventType === 'card.action.trigger') {
      if (callback.statusCode === 200) {
        console.log('[feishu] Applied task card action');
      }
      return res.status(callback.statusCode).json(callback.body);
    }

    // routeVerifiedWebhookEvent immediately resolves ordinary callbacks so
    // message processing continues after the acknowledgement is sent.
    res.status(callback.statusCode).json(callback.body);

    // Handle message event asynchronously
    if (eventType === 'im.message.receive_v1') {
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
      return;
    }
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'zylos-feishu',
      mode: 'webhook',
      cursors: Object.keys(groupCursors).length
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
      user_id: botOpenId || 'bot',
      user_name: botAppName || 'bot',
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
  try {
    const client = new Lark.Client({
      appId: creds.app_id,
      appSecret: creds.app_secret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu
    });

    const res = await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });

    if (res.code === 0 && res.bot) {
      botOpenId = res.bot.open_id;
      botAppName = res.bot.app_name || 'bot';
      console.log(`[feishu] Bot identity: ${botAppName} (${botOpenId})`);
    } else {
      console.error(`[feishu] Warning: Could not fetch bot info: ${res.msg}`);
    }
  } catch (err) {
    console.error(`[feishu] Warning: getBotInfo failed: ${err.message}`);
  }

  // Store app_id for exact bot message matching
  try {
    const creds2 = getCredentials();
    botAppId = creds2.app_id || '';
  } catch {}

  // Start selected transport
  if (connectionMode === 'webhook') {
    startWebhook(creds);
  } else {
    startWebSocket(creds);
  }
})();
