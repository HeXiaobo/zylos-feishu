/**
 * C4 reply receipt for the Feishu channel.
 *
 * c4-send spawns this channel with a per-call token in
 * `ZYLOS_REPLY_RECEIPT_TOKEN`. A `C4_RECEIPT` line is the only proof the
 * bridge accepts that a reply reached the platform: without it the outbound
 * row stays `delivery_unconfirmed` and the reply guard reports a missing
 * answer that already happened. Feishu returns `message_id` on every send, so
 * this channel can always prove delivery.
 *
 * A multi-chunk reply is one logical reply to C4. The first chunk's id is
 * recorded and later chunk ids are ignored, keeping one receipt per c4-send
 * call and matching `recordSuccessfulSend` (which maps every receipt line to
 * the same c4 id).
 */
export const RECEIPT_PREFIX = 'C4_RECEIPT ';

export function createReplyReceipt({ token = '', print = (line) => console.log(line) } = {}) {
  let messageId = null;

  function note(result) {
    if (messageId || result?.success !== true) return result;
    const id = result.messageId;
    if (typeof id === 'string' && id.trim() && !/[\r\n]/.test(id) && id.length <= 512) {
      messageId = id;
    }
    return result;
  }

  function wrap(fn) {
    return async (...args) => note(await fn(...args));
  }

  function emit() {
    if (!token || !messageId) return null;
    const line = RECEIPT_PREFIX + JSON.stringify({ receiptToken: token, platformMessageId: messageId });
    print(line);
    return line;
  }

  return {
    note,
    wrap,
    emit,
    get messageId() { return messageId; },
  };
}
