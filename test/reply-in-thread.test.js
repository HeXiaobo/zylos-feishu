import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate from the real ~/zylos config: config.js reads HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-reply-thread-test-'));
process.env.HOME = tmpHome;
test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
process.env.FEISHU_APP_ID = 'cli_test';
process.env.FEISHU_APP_SECRET = 'secret_test';
const { getClient, resetClient } = await import('../src/lib/client.js');
const { replyToMessage, replyMarkdownCard } = await import('../src/lib/message.js');

function captureReply() {
  resetClient();
  const calls = [];
  getClient().im.message.reply = async (req) => {
    calls.push(req);
    return { code: 0, data: { message_id: 'om_new' } };
  };
  return calls;
}

test('replyToMessage sends reply_in_thread only when replyInThread is set', async () => {
  const calls = captureReply();
  await replyToMessage('om_p', 'hi', 'text', { replyInThread: true });
  await replyToMessage('om_p', 'hi');
  assert.equal(calls[0].path.message_id, 'om_p');
  assert.equal(calls[0].data.reply_in_thread, true);
  assert.equal('reply_in_thread' in calls[1].data, false);
});

test('replyMarkdownCard sends reply_in_thread only when replyInThread is set', async () => {
  const calls = captureReply();
  await replyMarkdownCard('om_p', '**hi**', { replyInThread: true });
  await replyMarkdownCard('om_p', '**hi**');
  assert.equal(calls[0].data.msg_type, 'interactive');
  assert.equal(calls[0].data.reply_in_thread, true);
  assert.equal('reply_in_thread' in calls[1].data, false);
});
