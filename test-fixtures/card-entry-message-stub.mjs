// Stand-in for src/lib/message.js in test/card-send-entry.test.js. The test
// spawns the real scripts/send.js with this module loaded instead of the Feishu
// client, so the entry path can be exercised without any network access.
//
// Every call is printed as one `ENTRY_CALL <json>` line on stdout; the test
// parses those lines and asserts that no text message is ever sent.

const result = process.env.CARD_ENTRY_SEND_FAIL === '1'
  ? { success: false, code: 230020, message: 'bot not in chat' }
  : { success: true, messageId: 'om_test_entry' };

function record(name, args) {
  console.log(`ENTRY_CALL ${JSON.stringify({ name, args })}`);
}

let attempts = 0;
function ok(name) {
  attempts++;
  if (process.env.CARD_ENTRY_CARD_FAIL === '1' && name.includes('Markdown')) {
    return { success: false, message: 'card rejected' };
  }
  if (Number(process.env.CARD_ENTRY_FAIL_AT) === attempts) {
    return { success: false, message: 'send rejected' };
  }
  if (process.env.CARD_ENTRY_REPLY_FAIL === '1' && name === 'replyToMessage') {
    return { success: false, message: 'reply rejected' };
  }
  if (Number(process.env.CARD_ENTRY_MISSING_ID_AT) === attempts) return { success: true };
  return { ...result, ...(process.env.CARD_ENTRY_UNIQUE_IDS === '1'
    && result.success && { messageId: `om_entry_${attempts}` }) };
}

export async function sendMessage(...args) {
  record('sendMessage', args);
  return ok('sendMessage');
}

export async function replyToMessage(...args) {
  record('replyToMessage', args);
  return ok('replyToMessage');
}

export async function sendToGroup(...args) {
  record('sendToGroup', args);
  return ok('sendToGroup');
}

export async function uploadImage(...args) {
  record('uploadImage', args);
  return { success: true, imageKey: 'img_test' };
}

export async function sendImage(...args) {
  record('sendImage', args);
  return ok('sendImage');
}

export async function uploadFile(...args) {
  record('uploadFile', args);
  return { success: true, fileKey: 'file_test' };
}

export async function sendFile(...args) {
  record('sendFile', args);
  return ok('sendFile');
}

export async function sendMarkdownCard(...args) {
  record('sendMarkdownCard', args);
  return ok('sendMarkdownCard');
}

export async function replyMarkdownCard(...args) {
  record('replyMarkdownCard', args);
  return ok('replyMarkdownCard');
}
