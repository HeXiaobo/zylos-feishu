/** C4 ingress metadata, independent of SDK and network for contract tests.
 *
 * Every helper takes the arch2 switch explicitly. With the switch off the
 * caller gets the pre-arch2 behaviour (baseline 8c0a3e2) and no new c4-receive
 * arguments, so upgrading an existing instance changes nothing.
 */
import { effectiveInternal } from './group-classification.js';

// Baseline: only the original four arguments, no metadata flags.
export function ingressArgs({ sourceId, chatId, senderId, mentioned = false, needsGate = false } = {}) {
  const args = [];
  for (const [flag, value] of [['--source-id', sourceId], ['--chat', chatId], ['--sender', senderId]]) {
    if (value) args.push(flag, String(value));
  }
  args.push('--mentioned', mentioned ? '1' : '0');
  if (needsGate) args.push('--needs-gate');
  return args;
}

// Arch2 adds metadata to the baseline argument list; off returns it unchanged.
export function arch2IngressArgs(arch2, metadata = {}) {
  return arch2 ? ingressArgs(metadata) : [];
}

// ---------------------------------------------------------------------------
// Group allowance. The legacy pair is the exact baseline logic; smartGroup and
// receivedGroupAllowed only add behaviour when arch2 is on.
// ---------------------------------------------------------------------------

// Baseline `isGroupAllowed` from 8c0a3e2: allowlist needs an explicit entry.
export function legacyGroupAllowed(config = {}, chatId) {
  const normalizedChatId = chatId === undefined || chatId === null ? '' : String(chatId);
  const groupPolicy = config.groupPolicy || 'allowlist';
  if (groupPolicy === 'disabled') return false;
  if (groupPolicy === 'open') return true;
  if (config.groups?.[normalizedChatId]) return true;
  const legacyAllowed = (config.allowed_groups || []).some(g => String(g.chat_id) === normalizedChatId);
  const legacySmart = (config.smart_groups || []).some(g => String(g.chat_id) === normalizedChatId);
  return legacyAllowed || legacySmart;
}

// Baseline `isSmartGroup` from 8c0a3e2.
export function legacySmartGroup(config = {}, chatId) {
  const normalizedChatId = chatId === undefined || chatId === null ? '' : String(chatId);
  if ((config.groupPolicy || 'allowlist') === 'disabled') return false;
  const groupConfig = config.groups?.[normalizedChatId];
  if (groupConfig) return groupConfig.mode === 'smart' || groupConfig.requireMention === false;
  return (config.smart_groups || []).some(g => String(g.chat_id) === normalizedChatId);
}

// Explicit user configuration wins over cached automatic evidence.
export function groupGatePolicy(config, chatId) {
  const group = config.groups?.[chatId] || {};
  const internal = effectiveInternal(group);
  let gateMode = group.gateMode || 'auto';
  if (!['off', 'observe', 'auto'].includes(gateMode)) gateMode = 'off';
  if (group.mode === 'mention' || group.requireMention === true) gateMode = 'off';
  return { internal, gateMode };
}

// Arch2: a received group is allowed unless explicitly disabled.
export function smartGroup(config, chatId, arch2 = true) {
  if (!arch2) return legacySmartGroup(config, chatId);
  if (config.groupPolicy === 'disabled') return false;
  const group = config.groups?.[chatId];
  if (group && ('mode' in group || 'requireMention' in group)) {
    return group.mode === 'smart' || group.requireMention === false;
  }
  const legacyAllowed = (config.allowed_groups || []).some(g => String(g.chat_id) === String(chatId));
  const legacySmart = (config.smart_groups || []).some(g => String(g.chat_id) === String(chatId));
  return legacySmart || !legacyAllowed;
}

export function receivedGroupAllowed(config, chatId, arch2 = true) {
  if (!arch2) return legacyGroupAllowed(config, chatId);
  if (config.groupPolicy === 'disabled' || !chatId) return false;
  return config.groups?.[chatId]?.enabled !== false;
}

export function replyIsBot(item, botId, appId) {
  const sender = item?.sender;
  return Boolean(sender && ((botId && sender.id === botId) || (appId && sender.sender_type === 'app' && sender.id === appId)));
}
