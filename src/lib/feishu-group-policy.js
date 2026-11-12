import { decideGroupAccess } from './group-access-policy.js';

/**
 * Group-message sender policy.
 *
 * Feishu exposes @everyone as `mentions[].key === '@_all'`. That is not a
 * mention of this bot, so a group message that only @-all must not reach C4
 * (review-v4). Only an explicit open_id/user_id/app_id match counts.
 */
export function isBotMentioned(mentions, botId) {
  if (!mentions || !Array.isArray(mentions)) return false;
  const normalizedBotId = botId === undefined || botId === null ? '' : String(botId).trim();
  if (!normalizedBotId) return false;
  return mentions.some((mention) => {
    if (!mention || typeof mention !== 'object') return false;
    if (mention.key === '@_all') return false;
    const mentionId = mention.id?.open_id || mention.id?.user_id || mention.id?.app_id || '';
    return Boolean(mentionId) && String(mentionId) === normalizedBotId;
  });
}

/**
 * The lab config contract: only registered groups are allowed, and mention
 * mode requires an explicit bot mention.
 */
export function isGroupAllowed(config, chatId) {
  const policy = config?.groupPolicy || 'allowlist';
  if (policy === 'disabled') return false;
  if (policy === 'open') return true;
  return Boolean(chatId && config?.groups?.[chatId]);
}

function normalizeId(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text === '' ? '' : text.toLowerCase();
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeId(entry))
    .filter((entry) => entry !== '');
}

function sameTenant(left, right) {
  const a = normalizeId(left);
  const b = normalizeId(right);
  return a !== '' && a === b;
}

/**
 * Resolve the per-group config entry, normalizing the chat id the same way the
 * legacy helpers did.
 */
export function resolveGroupEntry(config, chatId) {
  const normalizedChatId = chatId === undefined || chatId === null ? '' : String(chatId);
  if (normalizedChatId === '') return undefined;
  return config?.groups?.[normalizedChatId];
}

/**
 * Tenant keys that admit a sender into a group. A per-group `allowTenants`
 * replaces the global `groupAllowTenants` for that chat; `internalCrossTenantUsers`
 * is additive (global list plus the group list).
 */
function tenantAllowList(config, groupConfig) {
  return normalizeList(
    groupConfig?.allowTenants !== undefined
      ? groupConfig.allowTenants
      : config?.groupAllowTenants,
  );
}

function crossTenantAllowList(config, groupConfig) {
  return [
    ...normalizeList(config?.internalCrossTenantUsers),
    ...normalizeList(groupConfig?.internalCrossTenantUsers),
  ];
}

/**
 * Whether the sender may speak in this group.
 *
 * Decision order:
 *   1. The group `allowFrom` list contains `*` or the sender → allowed.
 *   2. The sender is in the global or group `internalCrossTenantUsers` → allowed.
 *   3. The sender tenant is in the group (or, when the group does not set one,
 *      global) `groupAllowTenants` → allowed.
 *   4. None of `allowFrom`, `internalCrossTenantUsers` and the applicable
 *      tenant list configured → legacy behavior, every group member allowed.
 *   5. Otherwise denied. An empty `tenantKey` can never satisfy step 3.
 *
 * An explicit sender list is authoritative for the group: when it denies a
 * sender, a tenant or cross-tenant grant for that same sender does not apply.
 */
export function isSenderAllowedInGroup(config, chatId, {
  userId,
  openId,
  tenantKey,
} = {}) {
  const groupConfig = resolveGroupEntry(config, chatId);
  const senderIds = [normalizeId(userId), normalizeId(openId)].filter((id) => id !== '');

  const allowFrom = normalizeList(groupConfig?.allowFrom);
  if (allowFrom.includes('*')) return true;
  if (senderIds.some((id) => allowFrom.includes(id))) return true;
  if (allowFrom.length > 0) return false;

  const crossTenantUsers = crossTenantAllowList(config, groupConfig);
  if (senderIds.some((id) => crossTenantUsers.includes(id))) return true;

  const tenants = tenantAllowList(config, groupConfig);
  const senderTenant = normalizeId(tenantKey);
  if (senderTenant !== '' && tenants.some((tenant) => sameTenant(tenant, senderTenant))) {
    return true;
  }

  if (crossTenantUsers.length > 0 || tenants.length > 0) return false;
  return true;
}

/**
 * The default text used when `groupRejectMode` is `reply` but no
 * `groupRejectText` is configured.
 */
export const DEFAULT_GROUP_REJECT_TEXT =
  "Sorry, you don't have permission to interact with me in this group.";

/**
 * Normalize `groupRejectMode` to `'silent'` or `'reply'`. Unknown values fall
 * back to the default, `'silent'`.
 */
export function getGroupRejectMode(config) {
  const mode = config?.groupRejectMode;
  return String(mode ?? '').trim().toLowerCase() === 'reply' ? 'reply' : 'silent';
}

/**
 * What the service does when a group sender is denied before the message is
 * processed. `'silent'` logs only; `{ reply }` sends exactly one visible reply.
 */
export function groupRejectAction(config) {
  if (getGroupRejectMode(config) !== 'reply') return 'silent';
  const configured = config?.groupRejectText;
  const text = typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : DEFAULT_GROUP_REJECT_TEXT;
  return { reply: text };
}

/**
 * Compose the sender decision with the service-level group access decision.
 *
 * Owner and member-access resolution stay in the service (they need live config
 * and, for department policies, network lookups); everything deterministic
 * happens here so the inbound path and the tests share one implementation.
 */
export function decideGroupSenderAccess({
  config,
  chatId,
  userId,
  openId,
  tenantKey,
  chatType,
  senderIsOwner,
  groupConfigured,
  groupAllowed,
  memberAccessAllowed,
  explicitActivation,
}) {
  const groupPolicy = config?.groupPolicy || 'allowlist';
  const senderAllowedByGroup = isSenderAllowedInGroup(config, chatId, {
    userId,
    openId,
    tenantKey,
  });
  const access = decideGroupAccess({
    groupPolicy,
    groupAllowed: groupAllowed === true,
    groupConfigured: groupConfigured === true,
    senderIsOwner: senderIsOwner === true,
    senderAllowedByGroup,
    memberAccessAllowed,
    explicitActivation: explicitActivation === true,
  });
  return Object.freeze({
    ...access,
    senderAllowedByGroup,
    rejectAction: access.allowed ? null : groupRejectAction(config),
  });
}
