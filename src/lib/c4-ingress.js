/** C4 ingress metadata, independent of SDK and network for contract tests. */
import { effectiveInternal } from './group-classification.js';
export function ingressArgs({ sourceId, chatId, senderId, mentioned = false, needsGate = false } = {}) {
  const args = [];
  for (const [flag, value] of [['--source-id', sourceId], ['--chat', chatId], ['--sender', senderId]]) {
    if (value) args.push(flag, String(value));
  }
  args.push('--mentioned', mentioned ? '1' : '0');
  if (needsGate) args.push('--needs-gate');
  return args;
}

// Explicit user configuration wins over cached automatic evidence.
export function groupGatePolicy(config, chatId) {
  const group = config.groups?.[chatId] || {};
  const internal = effectiveInternal(group);
  let gateMode = group.gateMode || (internal ? 'auto' : 'observe');
  if (!['off', 'observe', 'auto'].includes(gateMode)) gateMode = 'observe';
  if (!internal && gateMode === 'auto') gateMode = 'observe';
  if (group.mode === 'mention' || group.requireMention === true) gateMode = 'off';
  return { internal, gateMode };
}
export function smartGroup(config, chatId) {
  if (config.groupPolicy === 'disabled') return false;
  const group = config.groups?.[chatId];
  if (group && ('mode' in group || 'requireMention' in group)) {
    return group.mode === 'smart' || group.requireMention === false;
  }
  const legacyAllowed = (config.allowed_groups || []).some(g => String(g.chat_id) === String(chatId));
  const legacySmart = (config.smart_groups || []).some(g => String(g.chat_id) === String(chatId));
  return legacySmart || !legacyAllowed;
}
export function receivedGroupAllowed(config, chatId) {
  if (config.groupPolicy === 'disabled' || !chatId) return false;
  return config.groups?.[chatId]?.enabled !== false;
}
export function replyIsBot(item, botId, appId) {
  const sender = item?.sender;
  return Boolean(sender && ((botId && sender.id === botId) || (appId && sender.sender_type === 'app' && sender.id === appId)));
}
