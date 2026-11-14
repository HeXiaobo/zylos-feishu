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
 * Invariant: `groups[id].internal` and `groups[id].autoClassification.internal`
 * are the *verdict*, not raw evidence, and always agree with
 * `effectiveInternal()`. The core gate (`c4-gate.js policyFor`) reads exactly
 * those two fields, preferring `internal`, so any disagreement between the two
 * sides would open the group on one of them.
 *
 * A manual `internal: true` is a claim, not evidence. It survives only while no
 * evidence contradicts it; a successful lookup saying external, an outside
 * sender tenant, or a failed refresh all overwrite it. The operator's wish is
 * remembered in `internalDemoted` and restored by a later successful lookup, so
 * it is downgraded rather than silently deleted.
 */
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
  return {
    // A failed refresh leaves no usable answer, not "external": the caller must
    // treat it as unknown and stay conservative.
    external: verdict === null ? null : verdict !== true,
    degraded: retry || Boolean(demoted),
    fresh: verdict !== null && !demoted,
    source: cached?.source || 'unavailable',
    checkedAt: Number(cached?.checkedAt) || null,
    retry,
    demotedReason: demoted?.reason || null,
    lastKnownInternal: typeof cached?.lastKnownInternal === 'boolean' ? cached.lastKnownInternal : null,
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
function demote(group, reason, at) {
  const wasManual = group.internal === true;
  if (wasManual) group.internal = false;
  if (wasManual && !group.internalDemoted) group.internalDemoted = { at, reason };
  const previous = group.autoClassification;
  const lastKnown = previous?.lastKnownInternal ?? (typeof previous?.internal === 'boolean' ? previous.internal : null);
  group.autoClassification = { ...previous, internal: false, lastKnownInternal: lastKnown === true };
  return wasManual;
}

function restore(group) {
  if (!group.internalDemoted) return false;
  delete group.internalDemoted;
  group.internal = true;
  return true;
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

export function createGroupClassifier({ getChatInfo, saveConfig, now = Date.now, timeoutMs = 5000 }) {
  const pending = new Map();
  const externalEpoch = new WeakMap();
  const query = chatId => {
    if (!pending.has(chatId)) {
      let timer;
      const work = Promise.race([
        Promise.resolve().then(() => getChatInfo(chatId)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('chat info timeout')), timeoutMs); }),
      ]).catch(() => ({ success: false })).finally(() => { clearTimeout(timer); pending.delete(chatId); });
      pending.set(chatId, work);
    }
    return pending.get(chatId);
  };
  return async ({ config, chatId, senderTenantKey, botTenantKey }) => {
    const group = config.groups?.[chatId];
    if (!group) return false;
    const tenants = internalTenantKeys(config, botTenantKey);
    // Missing own-tenant identity cannot certify any sender as internal.
    const externalSender = Boolean(senderTenantKey && !tenants.has(senderTenantKey));
    let changed = false;
    const cached = group.autoClassification;
    const at = now();
    if (externalSender) {
      externalEpoch.set(group, (externalEpoch.get(group) || 0) + 1);
      demote(group, 'external_sender', at);
      group.autoClassification = { internal: false, checkedAt: at, retry: cached?.retry === true, source: 'external_sender' };
      saveConfig(config);
      if (!cached || cached.retry === true || at - cached.checkedAt >= GROUP_CLASSIFICATION_TTL_MS) {
        const result = await query(chatId);
        group.autoClassification.retry = !(result.success && typeof result.chat?.external === 'boolean');
        if (group.autoClassification.retry) demote(group, 'refresh_failed', at);
        saveConfig(config);
      }
      return effectiveInternal(group);
    }
    const epoch = externalEpoch.get(group) || 0;
    // Refresh once per TTL per group, including groups the operator marked
    // internal: that is how the component learns a group became external.
    const stale = !cached || cached.retry === true || at - cached.checkedAt >= GROUP_CLASSIFICATION_TTL_MS;
    if (stale) {
      const result = await query(chatId);
      // A concurrent external-sender observation wins over this lookup.
      if ((externalEpoch.get(group) || 0) !== epoch) return effectiveInternal(group);
      if (result.success && typeof result.chat?.external === 'boolean') {
        group.autoClassification = { internal: !result.chat.external, checkedAt: at, retry: false, source: 'chat_info' };
        if (result.chat.external) demote(group, 'chat_external', at);
        else restore(group);
      } else {
        // Expired (or never obtained) evidence that cannot be refreshed: the
        // verdict must not stay internal. Keep the raw value for reporting and
        // retry on the next message until a query succeeds.
        group.autoClassification = {
          ...cached,
          checkedAt: cached?.checkedAt || 0,
          retry: true,
          source: cached?.source || 'unavailable',
        };
        demote(group, 'refresh_failed', at);
      }
      changed = true;
    }
    if (changed) saveConfig(config);
    return effectiveInternal(group);
  };
}
