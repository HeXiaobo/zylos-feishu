/**
 * Pure routing helper: decide the reply-to target for an outbound message.
 *
 * Reply-to (threaded/quoted) sends via Feishu's `im.message.reply` API are ONLY
 * meaningful in GROUP chats. In a 1:1 p2p DM, a reply lands on a thread/quote
 * line that Feishu does NOT surface in the main DM view — the API still returns
 * `code:0` (success), so the recipient silently never sees the message.
 *
 * Therefore: for p2p DMs (and any non-group chat) the reply target is ALWAYS
 * null, forcing callers down the base send path (sendMessage/sendImage/sendFile
 * to the chatId), which is delivered normally. Groups keep their reply-to
 * behavior for @mention/thread continuation.
 *
 * @param {object} endpoint - Parsed endpoint fields.
 * @param {string} [endpoint.type] - Chat type ('p2p' | 'group' | 'topic_group').
 * @param {string} [endpoint.thread] - Topic/thread id (routing fact only).
 * @param {string} [endpoint.root] - Root message id of a topic/thread.
 * @param {string} [endpoint.parent] - Parent message id within a thread.
 * @param {string} [endpoint.msg] - Triggering message id (@mention reply).
 * @param {object} [opts]
 * @param {boolean} [opts.isFirstChunk=true] - Whether this is the first chunk;
 *   @mention replies (msg without root) only apply to the first chunk.
 * @returns {string|null} The message id to reply to, or null for a base send.
 */
export function chooseReplyTarget({ type, thread, root, parent, msg } = {}, { isFirstChunk = true } = {}) {
  // Only groups ever use reply-to. p2p DMs (and unknown types) always base-send.
  if (type !== 'group' && type !== 'topic_group') return null;
  // A topic/thread root: keep every chunk inside the thread.
  if (thread || root) return parent || root || msg || null;
  // An @mention reply: only the first chunk quotes the triggering message.
  if (isFirstChunk && msg) return msg;
  return null;
}
