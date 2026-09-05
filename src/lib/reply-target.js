/**
 * Pure routing helper: decide the reply-to target for an outbound message.
 *
 * Historically, routing a DM through its inherited root/parent produced
 * successful API responses without a visible main-chat reply. Keep that guard
 * by default (including media). Text/card callers may explicitly opt in to
 * quoting only the triggering message, with reply_in_thread=false.
 * Group routing and thread continuation are unchanged.
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
 * @param {boolean} [opts.quoteDirectMessage=false] - Text/card callers may quote
 *   the exact triggering DM message, and MUST send reply_in_thread=false.
 *   Never inherit root/parent for DMs. Media callers retain the safe default.
 * @returns {string|null} The message id to reply to, or null for a base send.
 */
export function chooseReplyTarget({ type, thread, root, parent, msg } = {}, { isFirstChunk = true, quoteDirectMessage = false } = {}) {
  if (type === 'p2p' && quoteDirectMessage) return msg || null;
  // Without the explicit DM opt-in, only groups use reply-to.
  if (type !== 'group' && type !== 'topic_group') return null;
  // A topic/thread root: keep every chunk inside the thread.
  if (thread || root) return parent || root || msg || null;
  // An @mention reply: only the first chunk quotes the triggering message.
  if (isFirstChunk && msg) return msg;
  return null;
}
