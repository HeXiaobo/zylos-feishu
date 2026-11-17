export function createReplyReceipts({ enabled, token, write = console.log }) {
  const messageIds = new Set();
  let incomplete = false;
  return {
    collect(result) {
      if (result?.success === true && typeof result.messageId === 'string'
        && result.messageId.trim()) messageIds.add(result.messageId);
      else incomplete = true;
    },
    emit() {
      if (enabled !== true || typeof token !== 'string' || !token || incomplete) return;
      for (const platformMessageId of messageIds) {
        write(`C4_RECEIPT ${JSON.stringify({ platformMessageId, receiptToken: token })}`);
      }
    }
  };
}
