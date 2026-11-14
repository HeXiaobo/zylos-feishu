/** Automatic evidence lives separately from user-owned internal/gateMode.
 * Cache is persisted in groups[id].autoClassification for C4 and restarts.
 */
export const GROUP_CLASSIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export function effectiveInternal(group = {}) {
  return typeof group.internal === 'boolean' ? group.internal : group.autoClassification?.internal === true;
}
export function internalTenantKeys(config, botTenantKey) {
  return new Set(Array.isArray(config.internalTenants)
    ? config.internalTenants.filter(key => typeof key === 'string' && key)
    : [botTenantKey || config.bot?.tenant_key].filter(Boolean));
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
    const group = config.groups[chatId];
    const tenants = internalTenantKeys(config, botTenantKey);
    // Missing own-tenant identity cannot certify any sender as internal.
    const externalSender = Boolean(senderTenantKey && !tenants.has(senderTenantKey));
    let changed = false;
    const cached = group.autoClassification;
    if (externalSender) {
      externalEpoch.set(group, (externalEpoch.get(group) || 0) + 1);
      group.autoClassification = { internal: false, checkedAt: now(), retry: cached?.retry || false, source: 'external_sender' };
      saveConfig(config);
      if (typeof group.internal !== 'boolean' && (!cached || cached.retry || now() - cached.checkedAt >= GROUP_CLASSIFICATION_TTL_MS)) {
        const result = await query(chatId);
        group.autoClassification.retry = !(result.success && typeof result.chat?.external === 'boolean');
        saveConfig(config);
      }
      return effectiveInternal(group);
    }
    const epoch = externalEpoch.get(group) || 0;
    // Explicit internal is user-owned. Do not replace it with API evidence.
    if (typeof group.internal !== 'boolean' && (!cached || cached.retry || now() - cached.checkedAt >= GROUP_CLASSIFICATION_TTL_MS)) {
      const result = await query(chatId);
      if ((externalEpoch.get(group) || 0) !== epoch) return effectiveInternal(group);
      if (result.success && typeof result.chat?.external === 'boolean') {
        group.autoClassification = { internal: !result.chat.external, checkedAt: now(), retry: false, source: 'chat_info' };
      } else {
        group.autoClassification = { ...cached, internal: cached?.internal === true, checkedAt: cached?.checkedAt || 0, retry: true, source: cached?.source || 'unavailable' };
      }
      changed = true;
    }
    if (changed) saveConfig(config);
    return effectiveInternal(group);
  };
}
