/**
 * Feishu @mention resolution module.
 *
 * Two-layer design:
 * 1. Auto-sync: fetch group members from a source group (e.g. company-wide group)
 * 2. Override map: manually configured aliases (nicknames, external users)
 *
 * Cache is stored at ~/zylos/components/feishu/mention-cache.json with TTL.
 * Config is read from config.json under the "mention" key.
 */

import fs from 'fs';
import path from 'path';
import { getClient } from './client.js';
import { getConfig, DATA_DIR } from './config.js';

const CACHE_PATH = path.join(DATA_DIR, 'mention-cache.json');

// In-memory mention map: { displayName → open_id }
let mentionMap = {};
let lastSyncAt = 0;
let syncTimer = null;

/**
 * Load cache from disk.
 */
function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (data.map && data.synced_at) {
        return data;
      }
    }
  } catch (err) {
    console.warn('[mention] Failed to load cache:', err.message);
  }
  return null;
}

/**
 * Save cache to disk.
 */
function saveCache(map, syncedAt) {
  try {
    const tmpPath = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ map, synced_at: syncedAt }, null, 2));
    fs.renameSync(tmpPath, CACHE_PATH);
  } catch (err) {
    console.warn('[mention] Failed to save cache:', err.message);
  }
}

/**
 * Fetch all members from a Feishu group chat via paginated API.
 * Returns { name → open_id } map.
 */
async function fetchGroupMembers(chatId) {
  const client = getClient();
  const members = {};
  let pageToken = undefined;

  do {
    const params = { member_id_type: 'open_id', page_size: 100 };
    if (pageToken) params.page_token = pageToken;

    const res = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params,
    });

    if (res.code !== 0) {
      console.error('[mention] Failed to fetch group members:', res.msg, `(code: ${res.code})`);
      return null;
    }

    const items = res.data?.items || [];
    for (const item of items) {
      if (item.name && item.member_id) {
        members[item.name] = item.member_id;
      }
    }

    pageToken = res.data?.page_token;
  } while (pageToken);

  return members;
}

/**
 * Sync mention map from source group.
 * Returns true if sync succeeded, false otherwise.
 */
export async function syncMentionMap() {
  const config = getConfig();
  const mentionConfig = config.mention;
  if (!mentionConfig?.source_group_id) {
    return false;
  }

  console.log('[mention] Syncing from group:', mentionConfig.source_group_id);
  const members = await fetchGroupMembers(mentionConfig.source_group_id);
  if (!members) {
    console.warn('[mention] Sync failed, keeping existing cache');
    return false;
  }

  const now = Date.now();

  // Merge: override_map takes priority over auto-synced members
  const overrideMap = mentionConfig.override_map || {};
  mentionMap = { ...members, ...overrideMap };
  lastSyncAt = now;

  saveCache(members, now);
  console.log(`[mention] Synced ${Object.keys(members).length} members, ${Object.keys(overrideMap).length} overrides`);
  return true;
}

/**
 * Get the current mention map (auto-synced + overrides).
 * Falls back to override_map only if no sync has happened.
 */
export function getMentionMap() {
  return mentionMap;
}

/**
 * Check if cache is stale and needs refresh.
 */
function isCacheStale() {
  const config = getConfig();
  const hours = config.mention?.refresh_interval_hours || 6;
  const ttlMs = hours * 60 * 60 * 1000;
  return (Date.now() - lastSyncAt) > ttlMs;
}

/**
 * Initialize mention system.
 * - Load cache from disk
 * - Merge with override_map from config
 * - If cache is stale or missing, trigger async sync
 * - Set up periodic refresh timer
 */
export function initMention() {
  const config = getConfig();
  const mentionConfig = config.mention;

  // Always load override_map as baseline
  const overrideMap = mentionConfig?.override_map || {};
  mentionMap = { ...overrideMap };

  // Load disk cache
  const cached = loadCache();
  if (cached) {
    mentionMap = { ...cached.map, ...overrideMap };
    lastSyncAt = cached.synced_at;
  }

  // If no source group configured, just use override_map
  if (!mentionConfig?.source_group_id) {
    console.log(`[mention] No source_group_id configured, using override_map only (${Object.keys(overrideMap).length} entries)`);
    return;
  }

  // Async sync if cache is stale or empty
  if (!cached || isCacheStale()) {
    syncMentionMap().catch(err => {
      console.warn('[mention] Initial sync failed:', err.message);
    });
  }

  // Set up periodic refresh
  const hours = mentionConfig.refresh_interval_hours || 6;
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    syncMentionMap().catch(err => {
      console.warn('[mention] Periodic sync failed:', err.message);
    });
  }, hours * 60 * 60 * 1000);

  // Don't block process exit
  if (syncTimer.unref) syncTimer.unref();

  console.log(`[mention] Initialized: ${Object.keys(mentionMap).length} entries, refresh every ${hours}h`);
}

/**
 * Build a regex pattern from a mention map's keys.
 * Names sorted by length (longest first) to avoid partial matches.
 */
function buildMentionPattern(map) {
  const names = Object.keys(map);
  if (names.length === 0) return null;
  const sorted = names.sort((a, b) => b.length - a.length);
  const escaped = sorted.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`@(${escaped.join('|')})`, 'g');
}

/**
 * Detect @mentions in text and convert to Feishu rich-text (post) format.
 * Used for the plain text sending path.
 *
 * Returns { msgType, content }:
 * - No mentions: { msgType: 'text', content: originalText }
 * - With mentions: { msgType: 'post', content: JSON.stringify(postContent) }
 */
export function buildMentionContent(text) {
  const map = mentionMap; // snapshot to avoid race with async sync
  const pattern = buildMentionPattern(map);
  if (!pattern) return { msgType: 'text', content: text };

  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return { msgType: 'text', content: text };
  }

  // Build post content elements
  const elements = [];
  let lastIdx = 0;
  for (const m of matches) {
    if (m.index > lastIdx) {
      elements.push({ tag: 'text', text: text.slice(lastIdx, m.index) });
    }
    const openId = map[m[1]];
    if (openId) {
      elements.push({ tag: 'at', user_id: openId });
    } else {
      elements.push({ tag: 'text', text: m[0] }); // preserve original @name
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    elements.push({ tag: 'text', text: text.slice(lastIdx) });
  }

  const postContent = { zh_cn: { title: '', content: [elements] } };
  return { msgType: 'post', content: JSON.stringify(postContent) };
}

/**
 * Replace @mentions in markdown text with Feishu card <at> tags.
 * Used for the markdown card sending path.
 *
 * Feishu card markdown supports: <at id=ou_xxx></at>
 */
export function buildMentionMarkdown(text) {
  const map = mentionMap; // snapshot to avoid race with async sync
  const pattern = buildMentionPattern(map);
  if (!pattern) return text;

  return text.replace(pattern, (match, name) => {
    const openId = map[name];
    if (openId) {
      return `<at id=${openId}></at>`;
    }
    return match;
  });
}

/**
 * Set mention map directly (for testing only).
 */
export function _setMapForTest(map) {
  mentionMap = map;
}

/**
 * Stop periodic sync timer (for clean shutdown).
 */
export function stopMentionSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
