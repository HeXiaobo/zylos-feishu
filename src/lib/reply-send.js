/**
 * Send a message, replying-to the triggering/thread message only when the chat
 * type warrants it.
 *
 * In a 1:1 p2p DM a reply-to send via Feishu `im.message.reply` is NOT surfaced
 * in the main DM view — the API still returns `code:0` (success), so the
 * recipient silently never sees it. Therefore p2p (and any unknown chat type)
 * take the base `sendMessage(chatId, text)` path, except when the message came
 * from a topic thread (`threadId` set): then the reply goes to parent||root with
 * `reply_in_thread: true` so it lands in the thread the user is reading. Groups
 * keep reply-to for thread/@mention continuation. A failed reply falls back to
 * the base send.
 *
 * The reply-target decision is delegated to `chooseReplyTarget` so this path
 * (reject/error replies from the message handler) stays consistent with the
 * outbound send routing in `scripts/send.js`.
 *
 * @param {object} msg
 * @param {string} msg.chatId
 * @param {string} msg.text
 * @param {string} [msg.chatType] - 'p2p' | 'group'
 * @param {string} [msg.rootId]
 * @param {string} [msg.parentId]
 * @param {string} [msg.messageId]
 * @param {string} [msg.threadId] - Feishu thread id when the message came from a topic thread.
 * @param {object} deps
 * @param {(target: string, text: string, msgType?: string, opts?: { replyInThread?: boolean }) => Promise<{ success?: boolean }>} deps.replyToMessage
 * @param {(chatId: string, text: string) => Promise<{ success?: boolean }>} deps.sendMessage
 * @returns {Promise<boolean>} whether the message was delivered
 */
import { chooseReplyTarget } from './reply-target.js';

export async function sendThreadAware(
  { chatId, text, chatType, rootId, parentId, messageId, threadId } = {},
  { replyToMessage, sendMessage } = {},
) {
  const replyTarget = chooseReplyTarget({
    type: chatType,
    root: rootId,
    parent: parentId,
    msg: messageId,
    thread: threadId,
  });
  if (replyTarget) {
    try {
      const replyResult = await replyToMessage(replyTarget, text, 'text', { replyInThread: Boolean(threadId) });
      if (replyResult && replyResult.success) return true;
    } catch {
      // fall through to the base send below
    }
  }
  const result = await sendMessage(chatId, text);
  return !!(result && result.success);
}
