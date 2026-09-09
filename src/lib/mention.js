/**
 * Feishu @mention resolution module.
 *
 * open_id is CONTEXT-SCOPED: the same person has different open_id values
 * across chats, bots, and even across purposes within one app (a value that
 * fires @ in a group member list may fail task writes, and vice versa). A
 * single global name→open_id table therefore cannot be trusted at send time —
 * a wrong-scope value fails SILENTLY: the message is delivered, no error is
 * raised, the mentioned person just never gets notified.
 *
 * Resolution layers (highest priority first):
 *
 * 1. LIVE chat members (preferred): at send time, resolve names against the
 *    member list of the very chat the message is going to, fetched in real
 *    time (short per-chat TTL cache to protect the API). A name counts as
 *    resolved only when the member list returns it WITH a readable name —
 *    ids listed without a resolvable name (as `+search-user` does) are not
 *    trusted.
 * 2. FALLBACK cache (override_map from config.json + mention-cache.json
 *    synced from source_group_id): used only when the live member list does
 *    not contain the name. This is kept for backward compatibility (manual
 *    aliases, users outside the current chat) but its values are
 *    context-scoped and may not fire. Every fallback hit is LOGGED (warn)
 *    and counted — never silent.
 *
 * Unresolvable @names are also logged (warn, with name and chat dimensions)
 * and counted, so a mention that will not fire is always observable in the
 * logs instead of silently degrading to plain text.
 *
 * Cache is stored at ~/zylos/components/feishu/mention-cache.json with TTL.
 * Config is read from config.json under the "mention" key.
 */

import fs from 'fs';
import path from 'path';
import { getClient } from './client.js';
import { getConfig, DATA_DIR } from './config.js';
import { mapOutsideCode } from './at-mention.js';

const CACHE_PATH = path.join(DATA_DIR, 'mention-cache.json');

// In-memory mention map: { displayName → open_id }
// FALLBACK layer only: override_map merged over the source-group sync cache.
// The live per-chat member map takes precedence at send time.
let mentionMap = {};
let lastSyncAt = 0;
let syncTimer = null;

// Per-chat live member maps: { chatId → { map: {name → open_id}, fetchedAt } }
// Short-lived cache so bursty sends don't hammer the member-list API; the
// values are still scoped to the exact chat being sent to.
const liveMembersCache = new Map();
const LIVE_MEMBERS_CACHE_MAX = 200;
const DEFAULT_LIVE_TTL_SECONDS = 300;

// Names that look like mentions but target special/aggregate recipients
// rather than a member of the chat — never report these as unresolved.
const NON_MEMBER_MENTION_TARGETS = new Set([
  'all', 'everyone', 'here', 'channel', '所有人', '大家', '全体', '全体成员',
]);

// Observability counters (issue #81: mention failures must never be silent).
const diagnostics = {
  liveLookups: 0,          // live member-list fetches performed
  liveLookupFailures: 0,   // live fetches that failed or returned nothing usable
  fallbackResolutions: 0,  // names resolved from the fallback cache instead of the live chat members
  unresolvedMentions: 0,   // @names that could not be resolved anywhere
  lastEventAt: null,
};

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
 * Returns { name → open_id } map, or null when the API fails.
 *
 * Success criterion: a member counts ONLY if the API returns it with a
 * readable `name` (item.name && item.member_id). Ids that come back without
 * a resolvable name — e.g. from `+search-user`, which lists bare ids too —
 * are deliberately excluded (issue #81).
 */
let fetchMembersImpl = null; // test injection point

async function fetchGroupMembers(chatId) {
  if (fetchMembersImpl) {
    return fetchMembersImpl(chatId);
  }
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

  // Merge: override_map takes priority over auto-synced members. Both are
  // FALLBACK layers now (issue #81) — the live per-chat member map resolved
  // at send time takes precedence over this whole map.
  const overrideMap = mentionConfig.override_map || {};
  mentionMap = { ...members, ...overrideMap };
  lastSyncAt = now;

  saveCache(members, now);
  console.log(`[mention] Synced ${Object.keys(members).length} members, ${Object.keys(overrideMap).length} overrides`);
  return true;
}

/**
 * Get the current mention map (auto-synced + overrides).
 * FALLBACK layer only — the live per-chat member map takes precedence at
 * send time (see resolveMentionMapForChat).
 */
export function getMentionMap() {
  return mentionMap;
}

/**
 * TTL for the per-chat live member cache (config: mention.live_members_ttl_seconds).
 */
function liveTtlMs() {
  const seconds = getConfig().mention?.live_members_ttl_seconds;
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_LIVE_TTL_SECONDS * 1000;
}

/**
 * Resolve the mention map for a specific outgoing chat (issue #81).
 *
 * Fetches the member list of the very chat the message is going to, in real
 * time (with a short per-chat TTL cache), and returns a map where the live
 * chat members take precedence over the fallback cache. Because a member is
 * only recorded when the API returns a readable name, "resolved" here means
 * "name read back from the chat's member list" — the only trustable signal.
 *
 * When the live lookup fails or yields nothing usable, the fallback map
 * (override_map + source-group cache) is returned and the degradation is
 * logged — never silent.
 *
 * Returns { map, liveNames, live, chatId }:
 * - map:       merged { name → open_id } to resolve against
 * - liveNames: Set of names that came from THIS chat's live member list
 * - live:      whether the live member list was usable
 * - chatId:    the chat that was resolved (null when chatId missing)
 */
export async function resolveMentionMapForChat(chatId) {
  if (!chatId) {
    return { map: mentionMap, liveNames: new Set(), live: false, chatId: null };
  }

  const cached = liveMembersCache.get(chatId);
  if (cached && (Date.now() - cached.fetchedAt) < liveTtlMs()) {
    return {
      map: { ...mentionMap, ...cached.map },
      liveNames: new Set(Object.keys(cached.map)),
      live: true,
      chatId,
    };
  }

  diagnostics.liveLookups += 1;
  diagnostics.lastEventAt = Date.now();
  let members = null;
  try {
    members = await fetchGroupMembers(chatId);
  } catch (err) {
    console.warn(`[mention] Live member lookup failed for chat ${chatId}: ${err.message} — falling back to cached map`);
  }

  if (members && Object.keys(members).length > 0) {
    // Bound the per-chat cache; drop the oldest entry when full.
    if (liveMembersCache.size >= LIVE_MEMBERS_CACHE_MAX && !liveMembersCache.has(chatId)) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, value] of liveMembersCache) {
        if (value.fetchedAt < oldestAt) {
          oldestAt = value.fetchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey) liveMembersCache.delete(oldestKey);
    }
    liveMembersCache.set(chatId, { map: members, fetchedAt: Date.now() });
    return {
      map: { ...mentionMap, ...members },
      liveNames: new Set(Object.keys(members)),
      live: true,
      chatId,
    };
  }

  diagnostics.liveLookupFailures += 1;
  console.warn(`[mention] Live member lookup unusable for chat ${chatId} (no members with readable names) — falling back to cached map`);
  return { map: mentionMap, liveNames: new Set(), live: false, chatId };
}

/**
 * Record one name resolved from the FALLBACK cache instead of the live chat
 * members. Context-scoped open_id means this value may belong to another
 * chat/bot scope and not fire — so it must be observable (issue #81).
 */
function reportFallbackResolution(name, chatId, reported) {
  if (reported.has(name)) return;
  reported.add(name);
  diagnostics.fallbackResolutions += 1;
  diagnostics.lastEventAt = Date.now();
  console.warn(
    `[mention] FALLBACK: "@${name}" resolved from cached override/source map, NOT from chat ${chatId || '(unknown)'} members — open_id is context-scoped; verify this mention actually fires`,
  );
}

/**
 * Record an @name that could not be resolved anywhere. The message still
 * goes out (mention kept as plain text), but this must never be silent.
 */
function reportUnresolvedMention(name, chatId, reason, reported) {
  if (reported.has(name)) return;
  reported.add(name);
  diagnostics.unresolvedMentions += 1;
  diagnostics.lastEventAt = Date.now();
  console.warn(
    `[mention] UNRESOLVED: "@${name}" (${reason}) not found for chat ${chatId || '(unknown)'} — message delivered WITHOUT this mention`,
  );
}

/**
 * Loose scan for @candidates that no resolution layer knows about.
 *
 * This catches people who are in NEITHER the live chat members NOR the
 * fallback map (e.g. not in the source group) — previously they produced
 * zero hits and zero errors. To keep the report precise:
 * - code spans/fenced blocks are skipped (a mention inside code is content);
 * - candidates whose longest known-name prefix is in the map count as known
 *   (`@吴优早` matches map name `吴优` + trailing text, not an unknown person);
 * - emails / URL paths (`a@b.com`, `x.com/@user`) and aggregate targets
 *   (@all/@所有人) are excluded.
 */
function reportUnresolvedCandidates(text, map, chatId, reported) {
  const candidateScan = /@([^\s@，。,.;；、!！?？~*#（）()\[\]{}<>|"':：\n\r]+)/g;
  const knownNames = Object.keys(map)
    .sort((a, b) => b.length - a.length);

  mapOutsideCode(text, (segment) => {
    for (const m of segment.matchAll(candidateScan)) {
      const name = m[1];
      if (!name || name.length > 32) continue;
      if (NON_MEMBER_MENTION_TARGETS.has(name.toLowerCase())) continue;
      const charBefore = m.index > 0 ? segment[m.index - 1] : '';
      if (charBefore && /[A-Za-z0-9._%+/-]/.test(charBefore)) continue; // email or URL path
      if (map[name]) continue; // resolved (live or fallback)
      const knownPrefix = knownNames.find(n => name.startsWith(n));
      if (knownPrefix) continue; // matched a known name plus trailing text
      reportUnresolvedMention(name, chatId, 'not in chat members or mention cache', reported);
    }
    return segment;
  });
}

/**
 * Classify one matched @name: fallback-resolved (context-scoped value from
 * cache — must be observable), unresolved (known name, empty id), or ok.
 */
function noteResolutionOutcome(name, openId, { liveNames, chatId, reported }) {
  if (!openId) {
    reportUnresolvedMention(name, chatId, 'map entry has no open_id', reported);
    return;
  }
  if (liveNames && !liveNames.has(name)) {
    reportFallbackResolution(name, chatId, reported);
  }
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

  // Load fallback baseline: override_map is a manually maintained GLOBAL
  // name→open_id table. open_id is context-scoped (chat/bot/purpose), so
  // these values are only a FALLBACK for when the live chat member list
  // cannot resolve a name — every fallback hit at send time is logged.
  const overrideMap = mentionConfig?.override_map || {};
  mentionMap = { ...overrideMap };

  // Load disk cache
  const cached = loadCache();
  if (cached) {
    mentionMap = { ...cached.map, ...overrideMap };
    lastSyncAt = cached.synced_at;
  }

  // If no source group configured, just use override_map (fallback only —
  // live per-chat resolution at send time does not depend on a source group)
  if (!mentionConfig?.source_group_id) {
    console.log(`[mention] No source_group_id configured, using override_map as fallback only (${Object.keys(overrideMap).length} entries)`);
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
 * `context` (optional, issue #81):
 * - map:       { name → open_id } to resolve against (default: fallback map)
 * - liveNames: Set of names resolved from the target chat's live member list
 * - chatId:    target chat id, used for observability dimensions
 *
 * Every fallback-scope resolution (name not in liveNames) and every
 * unresolvable @name is logged (warn) and counted — never silent.
 *
 * Returns { msgType, content }:
 * - No mentions: { msgType: 'text', content: originalText }
 * - With mentions: { msgType: 'post', content: JSON.stringify(postContent) }
 */
export function buildMentionContent(text, context = {}) {
  const map = context.map !== undefined ? context.map : mentionMap; // snapshot to avoid race with async sync
  const liveNames = context.liveNames || null;
  const chatId = context.chatId || null;
  const reported = new Set();
  const pattern = buildMentionPattern(map);
  if (!pattern) {
    reportUnresolvedCandidates(text, map, chatId, reported);
    return { msgType: 'text', content: text };
  }

  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    reportUnresolvedCandidates(text, map, chatId, reported);
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
    noteResolutionOutcome(m[1], openId, { liveNames, chatId, reported });
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

  reportUnresolvedCandidates(text, map, chatId, reported);

  const postContent = { zh_cn: { title: '', content: [elements] } };
  return { msgType: 'post', content: JSON.stringify(postContent) };
}

/**
 * Replace @mentions in markdown text with Feishu card <at> tags.
 * Used for the markdown card sending path.
 *
 * Feishu card markdown supports: <at id=ou_xxx></at>
 *
 * `context` (optional, issue #81): same contract as buildMentionContent —
 * liveNames/chatId drive fallback and unresolved observability.
 */
export function buildMentionMarkdown(text, context = {}) {
  const map = context.map !== undefined ? context.map : mentionMap; // snapshot to avoid race with async sync
  const liveNames = context.liveNames || null;
  const chatId = context.chatId || null;
  const reported = new Set();
  const pattern = buildMentionPattern(map);
  if (!pattern) {
    reportUnresolvedCandidates(text, map, chatId, reported);
    return text;
  }

  const result = text.replace(pattern, (match, name) => {
    const openId = map[name];
    noteResolutionOutcome(name, openId, { liveNames, chatId, reported });
    if (openId) {
      return `<at id=${openId}></at>`;
    }
    return match;
  });

  reportUnresolvedCandidates(text, map, chatId, reported);
  return result;
}

/**
 * Set mention map directly (for testing only).
 */
export function _setMapForTest(map) {
  mentionMap = map;
}

/**
 * Inject the member-list fetch implementation (for testing only).
 * Pass null to restore the real API-backed fetch.
 */
export function _setFetchMembersForTest(fn) {
  fetchMembersImpl = fn;
}

/**
 * Clear the per-chat live member cache (for testing only).
 */
export function _clearLiveMembersCacheForTest() {
  liveMembersCache.clear();
}

/**
 * Read observability counters (for testing only).
 */
export function _getMentionDiagnosticsForTest() {
  return { ...diagnostics };
}

/**
 * Reset observability counters (for testing only).
 */
export function _resetMentionDiagnosticsForTest() {
  diagnostics.liveLookups = 0;
  diagnostics.liveLookupFailures = 0;
  diagnostics.fallbackResolutions = 0;
  diagnostics.unresolvedMentions = 0;
  diagnostics.lastEventAt = null;
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
