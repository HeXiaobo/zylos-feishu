/**
 * Send a message, replying-to the triggering/thread message only when the chat
 * type warrants it.
 *
 * In a 1:1 p2p DM a reply-to send via Feishu `im.message.reply` is NOT surfaced
 * in the main DM view — the API still returns `code:0` (success), so the
 * recipient silently never sees it. Therefore p2p (and any unknown chat type)
 * ALWAYS take the base `sendMessage(chatId, text)` path. Groups keep reply-to
 * for thread/@mention continuation, falling back to the base send if the reply
 * API fails.
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
 * @param {object} deps
 * @param {(target: string, text: string) => Promise<{ success?: boolean }>} deps.replyToMessage
 * @param {(chatId: string, text: string) => Promise<{ success?: boolean }>} deps.sendMessage
 * @returns {Promise<boolean>} whether the message was delivered
 */
import { chooseReplyTarget } from './reply-target.js';

export async function sendThreadAware(
  { chatId, text, chatType, rootId, parentId, messageId, uuid } = {},
  { replyToMessage, sendMessage } = {},
) {
  const replyTarget = chooseReplyTarget({
    type: chatType,
    root: rootId,
    parent: parentId,
    msg: messageId,
  });
  if (replyTarget) {
    try {
      const replyResult = await replyToMessage(replyTarget, text, 'text', { uuid });
      if (replyResult && replyResult.success) return true;
    } catch {
      // fall through to the base send below
    }
  }
  const result = await sendMessage(chatId, text, 'chat_id', 'text', { uuid });
  return !!(result && result.success);
}
