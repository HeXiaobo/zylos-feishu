/**
 * Pure routing helper: decide the reply-to target for an outbound message.
 *
 * Reply-to (threaded/quoted) sends via Feishu's `im.message.reply` API are ONLY
 * meaningful in GROUP chats. In a 1:1 p2p DM, a reply lands on a thread/quote
 * line that Feishu does NOT surface in the main DM view — the API still returns
 * `code:0` (success), so the recipient silently never sees the message.
 *
 * Therefore: for p2p DMs (and any non-group chat) the reply target is null
 * unless the message arrived inside a topic thread, forcing callers down the
 * base send path (sendMessage/sendImage/sendFile to the chatId), which is
 * delivered normally. Groups keep their reply-to behavior for @mention/thread
 * continuation.
 *
 * Exception: a p2p message that arrived inside a Feishu topic thread (the
 * endpoint carries `thread:`). The user is reading that thread, so the reply
 * goes to parent||root with `reply_in_thread: true` and lands in the thread;
 * a base send would land in the main DM view, outside the thread.
 *
 * @param {object} endpoint - Parsed endpoint fields.
 * @param {string} [endpoint.type] - Chat type ('p2p' | 'group').
 * @param {string} [endpoint.thread] - Feishu thread id when the message came
 *   from a topic thread.
 * @param {string} [endpoint.root] - Root message id of a topic/thread.
 * @param {string} [endpoint.parent] - Parent message id within a thread.
 * @param {string} [endpoint.msg] - Triggering message id (@mention reply).
 * @param {object} [opts]
 * @param {boolean} [opts.isFirstChunk=true] - Whether this is the first chunk;
 *   @mention replies (msg without root) only apply to the first chunk.
 * @returns {string|null} The message id to reply to, or null for a base send.
 */
export function chooseReplyTarget({ type, root, parent, msg, thread } = {}, { isFirstChunk = true } = {}) {
  // p2p: base-send, except inside a topic thread (see header comment).
  if (type !== 'group') return (thread && (parent || root)) || null;
  // A topic/thread root: keep every chunk inside the thread.
  if (root) return parent || root;
  // An @mention reply: only the first chunk quotes the triggering message.
  if (isFirstChunk && msg) return msg;
  return null;
}
