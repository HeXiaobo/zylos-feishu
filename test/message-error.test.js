import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sendFailureResult } from '../src/lib/message.js';
import { sendCard } from '../src/lib/card-send.js';

// Feishu can reject a request with HTTP 4xx/5xx while the response body still
// carries the actionable { code, msg }. The SDK's own error message only says
// "Request failed with status code 400", which used to be all that reached
// ERR_CARD_SEND. Keep the Feishu detail; leave pure network errors alone.

test('an HTTP error response keeps the Feishu code and msg', () => {
  const err = new Error('Request failed with status code 400');
  err.response = { status: 400, data: { code: 230099, msg: 'invalid card payload' } };

  assert.deepEqual(sendFailureResult(err), {
    success: false,
    code: 230099,
    message: 'invalid card payload',
  });
});

test('a response body with msg but no code still keeps the msg', () => {
  const err = new Error('Request failed with status code 500');
  err.response = { status: 500, data: { msg: 'server busy' } };

  assert.deepEqual(sendFailureResult(err), { success: false, message: 'server busy' });
});

test('a pure network error keeps its original message and has no code', () => {
  const err = new Error('socket hang up');

  assert.deepEqual(sendFailureResult(err), { success: false, message: 'socket hang up' });
});

test('a non-object response body is ignored', () => {
  const err = new Error('Request failed with status code 502');
  err.response = { status: 502, data: '<html>bad gateway</html>' };

  assert.deepEqual(sendFailureResult(err), {
    success: false,
    message: 'Request failed with status code 502',
  });
});

test('card send reports the Feishu code/msg from an HTTP error response', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-card-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cardPath = path.join(dir, 'card.json');
  fs.writeFileSync(cardPath, JSON.stringify({ schema: '2.0', body: { elements: [] } }));

  const err = new Error('Request failed with status code 400');
  err.response = { status: 400, data: { code: 230099, msg: 'invalid card payload' } };
  const send = async () => sendFailureResult(err);

  await assert.rejects(
    sendCard(
      { chatId: 'oc_test_chat', type: 'p2p', cardPath },
      { replyToMessage: send, sendMessage: send },
    ),
    (error) => {
      assert.equal(error.code, 'ERR_CARD_SEND');
      assert.equal(error.message, 'ERR_CARD_SEND: 230099 invalid card payload');
      return true;
    },
  );
});
