/**
 * Group internal/external evidence for the arch2 group gate.
 *
 * Review R1 item 9: external evidence always wins, and manual configuration may
 * only make a group MORE conservative. The dangerous states are:
 *   - a manual `internal: true` left in the config of a group that had gained
 *     outside members;
 *   - a 24h cache that said internal, whose refresh now fails;
 *   - either of the above surviving long enough for an unmentioned message to be
 *     answered in a group with outsiders.
 *
 * Issue #162 adds three triggers that invalidate a cached verdict instead of
 * waiting for the 24h TTL:
 *   - a member joined or left (`handleMemberEvent`);
 *   - `internalTenants` / `bot.tenant_key` changed (`syncConfig`, which also
 *     drops "external sender" evidence collected under the old configuration);
 *   - a lookup failed, which never becomes internal and records why.
 *
 * Ordering matters. A member event must take effect *before* it awaits anything,
 * and any classification that was already in flight must not write its older
 * answer afterwards. Both are handled by a per-chat epoch: the event bumps the
 * epoch and rewrites the verdict synchronously, and every writer re-checks the
 * epoch after its `await`.
 *
 * Invariant: `groups[id].internal` and `groups[id].autoClassification.internal`
 * are the *verdict*, not raw evidence, and always agree with
 * `effectiveInternal()`. The core gate (`c4-gate.js policyFor`) reads exactly
 * those two fields, preferring `internal`, so any disagreement between the two
 * sides would open the group on one of them.
 */
import { parseScopeError } from './scope-error.js';

export const GROUP_CLASSIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize the persisted state into a report-friendly shape.
 *
 * `external`: true = proven external, false = proven internal, null = unknown.
 * `degraded`: no usable evidence — the lookup failed, or external evidence
 *   contradicted the configuration.
 */
export function groupEvidence(group = {}) {
  const cached = group.autoClassification;
  const retry = cached?.retry === true;
  const demoted = group.internalDemoted || null;
  const verdict = !retry && typeof cached?.internal === 'boolean' ? cached.internal : null;
  const lastError = cached?.lastError || null;
  return {
    // A failed refresh leaves no usable answer, not "external": the caller must
    // treat it as unknown and stay conservative.
    external: verdict === null ? null : verdict !== true,
    degraded: retry || Boolean(demoted),
    fresh: verdict !== null && !demoted,
    source: cached?.source || 'unavailable',
    checkedAt: Number(cached?.checkedAt) || null,
    retry,
    // Why the group is not internal right now: 'member_joined_external',
    // 'member_left', 'config_changed', 'refresh_failed', 'permission_denied', …
    reason: demoted?.reason || cached?.invalidatedReason || lastError?.reason || (retry ? 'refresh_failed' : null),
    demotedReason: demoted?.reason || null,
    lastKnownInternal: typeof cached?.lastKnownInternal === 'boolean' ? cached.lastKnownInternal : null,
    lastError,
  };
}

/**
 * Effective internal flag.
 *
 *  1. manual `internal: false` → false (the operator asked for caution);
 *  2. a recorded demotion → false until a successful lookup restores it;
 *  3. a verdict from the classifier → that verdict, and a failed refresh counts
 *     as "not internal";
 *  4. no verdict at all → the manual claim, because there is no contrary
 *     evidence yet. The classifier overwrites this on the first group message.
 *
 * Staleness is deliberately not re-derived here: the classifier refreshes before
 * the policy is read on the message path, and `normalizeGroupEvidence` demotes
 * stale persisted rows at startup. Re-deriving it from `Date.now()` here would
 * also disagree with an injected clock in tests.
 */
export function effectiveInternal(group = {}) {
  if (group.internal === false) return false;
  if (group.internalDemoted) return false;
  const cached = group.autoClassification;
  if (typeof cached?.internal === 'boolean') {
    if (cached.retry === true) return false;
    return cached.internal === true;
  }
  return group.internal === true;
}

export function internalTenantKeys(config, botTenantKey) {
  return new Set(Array.isArray(config.internalTenants)
    ? config.internalTenants.filter(key => typeof key === 'string' && key)
    : [botTenantKey || config.bot?.tenant_key].filter(Boolean));
}

/**
 * Record a demotion without losing the operator's intent, and keep the two
 * persisted fields consistent so the core gate reaches the same conclusion.
 */
function demote(group, reason, at, detail = null) {
  const wasManual = group.internal === true;
  if (wasManual) group.internal = false;
  if (wasManual && !group.internalDemoted) group.internalDemoted = { at, reason };
  const previous = group.autoClassification;
  const lastKnown = previous?.lastKnownInternal ?? (typeof previous?.internal === 'boolean' ? previous.internal : null);
  group.autoClassification = { ...previous, internal: false, lastKnownInternal: lastKnown === true, lastDemotedReason: reason };
  if (detail) group.autoClassification.lastError = detail;
  return wasManual;
}

function restore(group) {
  if (!group.internalDemoted) return false;
  delete group.internalDemoted;
  group.internal = true;
  return true;
}

/**
 * Drop a cached verdict so the next message re-judges it.
 *
 * The persisted verdict becomes "not internal, needs a lookup" (`retry: true`).
 * That has to hold for **both** readers:
 *   - `effectiveInternal()` reads `internalDemoted` first;
 *   - the core gate (`c4-gate.js policyFor`) reads `group.internal` directly and
 *     prefers it over `autoClassification`, so `group.internal` must be `false`
 *     for the whole asynchronously re-judged window. Leaving a manual `true`
 *     there answers already-queued unmentioned messages in a now-external group.
 *
 * The operator's manual claim is not deleted: it is remembered in
 * `internalDemoted` and restored only when a lookup verifies it (`restore()`).
 *
 * @param {(chatId?: string) => void} [onInvalidate] called per invalidated group
 *   so a creator that tracks per-chat ordering can bump its epoch.
 */
export function invalidateGroupEvidence(group, reason, at = Date.now()) {
  if (!group || typeof group !== 'object') return false;
  const cached = group.autoClassification || {};
  const wasInternal = cached.internal === true || group.internal === true;
  if (group.internal === true) {
    // Conservative for every reader, and keep the manual intent for a later
    // successful restore instead of dropping the operator's setting.
    group.internal = false;
    group.internalDemoted = group.internalDemoted || { at, reason };
  }
  group.autoClassification = {
    ...cached,
    internal: false,
    lastKnownInternal: wasInternal,
    retry: true,
    source: cached.source || 'unavailable',
    invalidatedAt: at,
    invalidatedReason: reason,
  };
  return true;
}

/** Invalidate every registered group; returns the number of groups touched. */
export function invalidateAllGroups(config, reason, at = Date.now(), onInvalidate = null) {
  let count = 0;
  for (const [chatId, group] of Object.entries(config.groups || {})) {
    if (!invalidateGroupEvidence(group, reason, at)) continue;
    count++;
    if (onInvalidate) onInvalidate(chatId);
  }
  return count;
}

/**
 * Normalize persisted classification state so that "persisted = verdict" holds
 * for every reader, including the core gate which reads the two fields directly
 * and cannot run this logic itself.
 *
 * Two states written by the pre-fix component are unsafe and are demoted here:
 *   - a cache whose refresh failed (`retry: true`) but which still says internal;
 *   - a cache older than the TTL that still says internal. The classifier would
 *     re-query on the next message, but the core gate may consume a leftover
 *     `gating` row before any message arrives.
 *
 * Returns true when something changed, so the caller can persist.
 */
export function normalizeGroupEvidence(config, now = Date.now()) {
  let changed = false;
  for (const [chatId, group] of Object.entries(config.groups || {})) {
    if (!group || typeof group !== 'object') continue;
    const cached = group.autoClassification;
    if (!cached || typeof cached.internal !== 'boolean') continue;
    if (cached.internal !== true) continue;
    const checkedAt = Number(cached.checkedAt) || 0;
    const stale = cached.retry === true || checkedAt === 0 || now - checkedAt >= GROUP_CLASSIFICATION_TTL_MS;
    if (!stale) continue;
    const at = now;
    // Keep the raw value for reporting and for a later successful restore.
    if (group.internal === true || group.internal === undefined) {
      group.internalDemoted = group.internalDemoted || { at, reason: 'stale_cache' };
      group.internal = false;
    }
    group.autoClassification = { ...cached, internal: false, lastKnownInternal: true, retry: true, source: cached.source || 'unavailable' };
    changed = true;
    void chatId;
  }
  return changed;
}

/**
 * A lookup failed. Keep the raw value for reporting, but the verdict must not
 * stay internal, and the reason must be readable later (`status.json`, logs).
 */
function describeFailure(result) {
  const parsed = parseScopeError(result);
  if (parsed?.permissionDenied) {
    return { at: Date.now(), reason: 'permission_denied', code: parsed.code, scopes: parsed.scopes, detail: parsed.msg };
  }
  const detail = [result?.msg, result?.message, result?.error?.code].filter(Boolean).join(' ').slice(0, 200) || 'lookup failed';
  return { at: Date.now(), reason: 'refresh_failed', code: Number.isFinite(Number(result?.code)) ? Number(result.code) : null, scopes: [], detail };
}

export function createGroupClassifier({ getChatInfo, saveConfig, now = Date.now, timeoutMs = 5000, log = () => {} }) {
  const pending = new Map();  // chatId -> { epoch, work }
  const epochs = new Map();   // chatId -> number; survives config reloads
  // Fingerprint of the settings that decide what "internal" means. A change
  // invalidates every group's cached verdict, because a verdict recorded under
  // the old tenant list is evidence about a different question.
  let fingerprint = null;

  const epochOf = (chatId) => epochs.get(chatId) || 0;
  const bumpEpoch = (chatId) => {
    const next = epochOf(chatId) + 1;
    epochs.set(chatId, next);
    return next;
  };

  const configFingerprint = (config) => JSON.stringify({
    tenants: Array.isArray(config?.internalTenants)
      ? config.internalTenants.filter(key => typeof key === 'string' && key).slice().sort()
      : null,
    botTenant: config?.bot?.tenant_key || null,
  });

  const query = (chatId, epoch = epochOf(chatId)) => {
    const existing = pending.get(chatId);
    if (existing && existing.epoch === epoch) return existing.work;
    let timer;
    const work = Promise.race([
      Promise.resolve().then(() => getChatInfo(chatId)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('chat info timeout')), timeoutMs); }),
    ]).catch((error) => ({ success: false, message: error?.message, error }))
      .finally(() => {
        clearTimeout(timer);
        if (pending.get(chatId)?.work === work) pending.delete(chatId);
      });
    pending.set(chatId, { epoch, work });
    return work;
  };

  /** Apply a lookup result as the verdict. Returns true when it was usable. */
  const applyLookup = (group, result, at, { allowRestore = true, lockExternal = false } = {}) => {
    const external = result?.success && typeof result.chat?.external === 'boolean' ? result.chat.external : null;
    if (external === null) {
      // Expired (or never obtained) evidence that cannot be refreshed: the
      // verdict must not stay internal. Keep the raw value for reporting and
      // retry on the next message until a query succeeds.
      const cached = group.autoClassification;
      const failure = describeFailure(result);
      group.autoClassification = {
        ...cached,
        checkedAt: cached?.checkedAt || 0,
        retry: true,
        source: cached?.source || 'unavailable',
        lastError: failure,
      };
      demote(group, failure.reason, at);
      log(`group ${group.chatId || ''} lookup failed: ${failure.reason} ${failure.detail} (treated as external)`.trim());
      return false;
    }
    if (lockExternal && !external) {
      // A newer event proved this group external (an outside member joined).
      // `chat.external` is a weaker, older fact; record it without reopening.
      group.autoClassification = {
        ...group.autoClassification,
        internal: false,
        retry: false,
        source: group.autoClassification?.source || 'member_event',
        checkedAt: at,
        lastLookup: { external: false, at },
      };
      return false;
    }
    const previous = group.autoClassification;
    group.autoClassification = { internal: !external, checkedAt: at, retry: false, source: 'chat_info', lastError: null };
    // Keep the record of why the previous verdict was voided: an operator looking
    // at status.json needs to see that a member event started the re-judge.
    if (previous?.invalidatedReason) {
      group.autoClassification.lastInvalidation = { at: previous.invalidatedAt || null, reason: previous.invalidatedReason };
    }
    if (external) demote(group, 'chat_external', at);
    else if (allowRestore) restore(group);
    return true;
  };

  /**
   * Detect a change of `internalTenants` / `bot.tenant_key` and invalidate every
   * group. Called on the message path, the member path and the config watcher,
   * so a hot reload takes effect on the next message without a restart.
   */
  const syncConfig = (config) => {
    const next = configFingerprint(config);
    if (fingerprint === null) { fingerprint = next; return false; }
    if (next === fingerprint) return false;
    fingerprint = next;
    // Bump every invalidated chat's epoch *while* invalidating. A classification
    // that was already waiting on `im.chat.get` under the old tenant list would
    // otherwise still match the epoch when it resolves and write a verdict that
    // belongs to the previous configuration.
    const count = invalidateAllGroups(config, 'config_changed', now(), bumpEpoch);
    // Persist immediately: a restart between the change and the next message must
    // not resurrect a verdict recorded under the previous tenant list.
    if (count > 0) saveConfig(config);
    log(`internalTenants/bot tenant changed: invalidated ${count} group verdict(s), re-judging on the next message`);
    return true;
  };

  const classify = async ({ config, chatId, senderTenantKey, botTenantKey }) => {
    syncConfig(config);
    const group = config.groups?.[chatId];
    if (!group) return false;
    group.chatId = chatId;
    const tenants = internalTenantKeys(config, botTenantKey);
    // Missing own-tenant identity cannot certify any sender as internal.
    const externalSender = Boolean(senderTenantKey && !tenants.has(senderTenantKey));
    let changed = false;
    const cached = group.autoClassification;
    const at = now();
    if (externalSender) {
      const epoch = bumpEpoch(chatId);
      demote(group, 'external_sender', at);
      group.autoClassification = { internal: false, checkedAt: at, retry: cached?.retry === true, source: 'external_sender' };
      saveConfig(config);
      if (!cached || cached.retry === true || at - cached.checkedAt >= GROUP_CLASSIFICATION_TTL_MS) {
        const result = await query(chatId, epoch);
        if (epochOf(chatId) !== epoch) return effectiveInternal(group);
        if (result.success && typeof result.chat?.external === 'boolean') group.autoClassification.retry = false;
        else {
          group.autoClassification.retry = true;
          group.autoClassification.lastError = describeFailure(result);
          demote(group, 'refresh_failed', at);
        }
        saveConfig(config);
      }
      return effectiveInternal(group);
    }
    const epoch = epochOf(chatId);
    // Refresh once per TTL per group, including groups the operator marked
    // internal: that is how the component learns a group became external.
    const stale = !cached || cached.retry === true || at - cached.checkedAt >= GROUP_CLASSIFICATION_TTL_MS;
    if (stale) {
      const result = await query(chatId, epoch);
      // A concurrent external-sender observation or member event wins.
      if (epochOf(chatId) !== epoch) return effectiveInternal(group);
      applyLookup(group, result, at);
      changed = true;
    }
    if (changed) saveConfig(config);
    return effectiveInternal(group);
  };

  /**
   * A member joined or left (issue #162 item 1).
   *
   * The first half is synchronous, before any `await`, so a message processed
   * right behind the event already sees the conservative verdict:
   *   - an outside tenant joined → the group is external, full stop;
   *   - any other membership change → the cached verdict is void (`retry`), which
   *     `effectiveInternal` reads as "not internal" until a lookup succeeds.
   * Then the group is re-judged from `im.chat.get`. A lookup that says
   * `external: false` right after an outside member joined is *not* trusted to
   * reopen the group — the event is newer and more specific than the flag.
   *
   * @returns {Promise<{chatId: string, handled: boolean, internal: boolean, rejudged: boolean}>}
   */
  classify.handleMemberEvent = async ({ config, chatId, event = {}, botTenantKey }) => {
    syncConfig(config);
    const group = chatId ? config.groups?.[chatId] : null;
    if (!group) return { chatId, handled: false, internal: false, rejudged: false };
    group.chatId = chatId;
    const at = now();
    const tenants = internalTenantKeys(config, botTenantKey);
    const users = Array.isArray(event.users) ? event.users.filter(user => user && typeof user === 'object') : [];
    const outside = users.filter(user => typeof user.tenant_key === 'string' && user.tenant_key && !tenants.has(user.tenant_key));
    const unknown = users.filter(user => typeof user.tenant_key !== 'string' || !user.tenant_key);
    const joined = event.type === 'added';
    // --- synchronous conservative invalidation starts here, before any await ---
    const epoch = bumpEpoch(chatId);
    const outsideJoined = joined && outside.length > 0;
    if (outsideJoined) {
      demote(group, 'member_joined_external', at, { at, reason: 'member_joined_external', tenants: outside.map(user => user.tenant_key), detail: 'member joined from a tenant outside internalTenants' });
      group.autoClassification = { internal: false, checkedAt: at, retry: false, source: 'member_event', lastError: group.autoClassification.lastError };
    } else {
      const reason = joined ? (unknown.length ? 'member_tenant_unknown' : 'member_joined') : 'member_left';
      invalidateGroupEvidence(group, reason, at);
    }
    saveConfig(config);
    // --- async re-judgment ---
    const result = await query(chatId, epoch);
    if (epochOf(chatId) !== epoch) {
      // A newer event or observation owns this group now; do not overwrite it.
      log(`group ${chatId} membership re-judge discarded (superseded by a newer event)`);
      return { chatId, handled: true, internal: effectiveInternal(group), rejudged: false };
    }
    applyLookup(group, result, at, { allowRestore: !outsideJoined, lockExternal: outsideJoined });
    saveConfig(config);
    log(`group ${chatId} re-judged after member ${event.type}: internal=${effectiveInternal(group)} `
      + `(source=${group.autoClassification?.source || 'unavailable'}, reason=${groupEvidence(group).reason || 'none'})`.trim());
    return { chatId, handled: true, internal: effectiveInternal(group), rejudged: true };
  };

  /** Called from the config watcher so a hot reload invalidates immediately. */
  classify.syncConfig = syncConfig;

  return classify;
}
