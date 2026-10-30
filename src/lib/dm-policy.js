/**
 * DM access rules, shared by the WebSocket path (index.js) and the
 * feishu-recovery poller. The poller delivers straight to C4, so it must apply
 * the same owner/dmPolicy/dmAllowFrom decision the component applies before it
 * accepts a private message; otherwise removing someone from the allowlist
 * revokes them on one path only.
 *
 * Pure functions: pass the component config object, no file or network access.
 */

/** True when the sender is the bound owner. */
export function isOwner(config, { userId, openId } = {}) {
  if (!config?.owner?.bound) return false;
  const ownerUserId = config.owner.user_id;
  const ownerOpenId = config.owner.open_id;
  return (ownerUserId !== undefined && ownerUserId !== null && userId !== undefined && userId !== null && String(ownerUserId) === String(userId))
    || (ownerOpenId !== undefined && ownerOpenId !== null && openId !== undefined && openId !== null && String(ownerOpenId) === String(openId));
}

/**
 * DM access — dmPolicy 'owner' (default) | 'allowlist' | 'open'.
 * Mirrors handleMessage()'s p2p branch in index.js.
 */
export function isDmAllowed(config, { userId, openId } = {}) {
  if (isOwner(config, { userId, openId })) return true;
  const policy = config?.dmPolicy || 'owner';
  if (policy === 'open') return true;
  if (policy === 'owner') return false;
  // policy === 'allowlist'
  const allowFrom = (Array.isArray(config?.dmAllowFrom) ? config.dmAllowFrom : []).map(String);
  const normalizedUserId = userId === undefined || userId === null ? '' : String(userId);
  const normalizedOpenId = openId === undefined || openId === null ? '' : String(openId);
  return (normalizedUserId && allowFrom.includes(normalizedUserId)) ||
    (normalizedOpenId && allowFrom.includes(normalizedOpenId));
}
