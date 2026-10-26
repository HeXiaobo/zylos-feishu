/**
 * Group-message gating shared with the lab vendor patch.
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
