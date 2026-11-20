/**
 * Group mode for messages that arrive in a group.
 *
 * Official behaviour (3018e4b): a group is "smart" — it receives every message
 * without an @mention — only when `config.groups[chat_id].mode === "smart"` (or
 * `requireMention === false`), or when the legacy `smart_groups` list names it.
 * Everything else is mention-only. There is no setting for "a group nobody
 * registered yet"; the operator registers each group with
 * `admin.js add-group <chat_id> <name> smart`.
 *
 * This distribution wants a new group to be smart by default, so there is one
 * addition: `defaultGroupMode: "smart"` in config.json. It fills in the mode
 * for a group that has no explicit entry of its own. It does not touch:
 *
 *   - `groupPolicy: "disabled"`      (official: nothing gets through)
 *   - `groupPolicy: "allowlist"`     (official: unlisted groups are not allowed
 *                                     at all, so they never reach this decision)
 *   - an explicit `mode`/`requireMention` on a group — that always wins, so a
 *     single group can still be pinned back to mention-only.
 *
 * Only the literal string "smart" is honoured. A typo, a boolean, `"SMART"` or
 * a trailing space keeps the official behaviour, the same rule the arch2 switch
 * uses: a mistake here must never widen who the bot answers in a group.
 */

/** Parse `groups[chatId]` into the mode the official code would use, or null. */
export function explicitGroupMode(config, chatId) {
  const group = config?.groups?.[chatId];
  if (!group) return null;
  if (group.mode === 'smart' || group.requireMention === false) return 'smart';
  if (group.mode === 'mention' || group.requireMention === true) return 'mention';
  return null;
}

/** Whether the legacy `smart_groups` list names this chat. */
export function listedAsSmart(config, chatId) {
  return (config?.smart_groups || []).some(g => String(g.chat_id) === String(chatId));
}

/** Whether this chat is smart, with the distribution default applied. */
export function isSmartGroup(config, chatId) {
  const normalized = chatId === undefined || chatId === null ? '' : String(chatId);
  if ((config?.groupPolicy || 'allowlist') === 'disabled') return false;

  const explicit = explicitGroupMode(config, normalized);
  if (explicit) return explicit === 'smart';
  if (listedAsSmart(config, normalized)) return true;

  return config?.defaultGroupMode === 'smart';
}
