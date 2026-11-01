import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CARD_MAX_REQUEST_BYTES,
  sendCard,
  readCardFile,
  cardSummary,
  sendRequestBody,
  requestBodyBytes,
} from '../src/lib/card-send.js';

// C4 sends a prepared card as `[MEDIA:card]<absolute path>`. The send path must
// be strict: a card that is not card 2.0 JSON, does not fit Feishu's 30 KB
// request limit, or cannot be delivered is an error. It must never turn into a
// text message and must never be truncated.

const CHAT = 'oc_test_chat';

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-card-send-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const VALID_CARD = {
  schema: '2.0',
  config: { summary: { content: '日报 2026-11-01' } },
  header: { title: { tag: 'plain_text', content: '日报' } },
  body: { elements: [{ tag: 'markdown', content: '**hi**' }] },
};

function writeCard(dir, card, name = 'card.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof card === 'string' ? card : JSON.stringify(card));
  return file;
}

function makeDeps({ replyResults, sendResult } = {}) {
  const replies = replyResults ?? [{ success: true, messageId: 'om_test_reply' }];
  const finalSend = sendResult ?? { success: true, messageId: 'om_test_sent' };
  const calls = { reply: [], send: [] };
  let replyIndex = 0;

  return {
    calls,
    deps: {
      replyToMessage: async (target, content, msgType) => {
        calls.reply.push({ target, content, msgType });
        const result = replies[Math.min(replyIndex++, replies.length - 1)];
        if (result instanceof Error) throw result;
        return result;
      },
      sendMessage: async (chatId, content, receiveIdType, msgType) => {
        calls.send.push({ chatId, content, receiveIdType, msgType });
        if (finalSend instanceof Error) throw finalSend;
        return finalSend;
      },
    },
  };
}

function assertAllInteractive(calls) {
  for (const call of [...calls.reply, ...calls.send]) {
    assert.equal(call.msgType, 'interactive', 'the card path must only ever send interactive messages');
  }
}

async function expectError(fn, code, pattern) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

test('p2p sends the card directly as interactive and never replies', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps();

  const result = await sendCard(
    {
      chatId: CHAT,
      type: 'p2p',
      root: 'om_test_root',
      parent: 'om_test_parent',
      msg: 'om_test_msg',
      cardPath,
    },
    deps,
  );

  assert.equal(result.via, 'send');
  assert.equal(result.messageId, 'om_test_sent');
  assert.equal(result.summary, '日报 2026-11-01');
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].chatId, CHAT);
  assert.equal(calls.send[0].receiveIdType, 'chat_id');
  assert.equal(calls.send[0].msgType, 'interactive');
  assert.deepEqual(JSON.parse(calls.send[0].content), VALID_CARD);
  assertAllInteractive(calls);
});

test('group @mention replies to the triggering message with the card', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps();

  const result = await sendCard(
    { chatId: CHAT, type: 'group', msg: 'om_test_msg', cardPath },
    deps,
  );

  assert.equal(result.via, 'reply');
  assert.equal(calls.send.length, 0);
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0].target, 'om_test_msg');
  assert.equal(calls.reply[0].msgType, 'interactive');
  assert.deepEqual(JSON.parse(calls.reply[0].content), VALID_CARD);
  assertAllInteractive(calls);
});

test('topic thread replies to parent||root, not to the plain chat', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps();

  const result = await sendCard(
    {
      chatId: CHAT,
      type: 'group',
      root: 'om_test_root',
      parent: 'om_test_parent',
      msg: 'om_test_msg',
      cardPath,
    },
    deps,
  );

  assert.equal(result.via, 'reply');
  assert.equal(calls.send.length, 0);
  assert.deepEqual(calls.reply.map((c) => c.target), ['om_test_parent']);
  assertAllInteractive(calls);
});

test('topic reply failure falls back to the thread root, still as a card', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps({
    replyResults: [
      { success: false, code: 230013, message: 'parent gone' },
      { success: true, messageId: 'om_test_root_reply' },
    ],
  });

  const result = await sendCard(
    { chatId: CHAT, type: 'group', root: 'om_test_root', parent: 'om_test_parent', cardPath },
    deps,
  );

  assert.equal(result.via, 'reply-root');
  assert.equal(result.messageId, 'om_test_root_reply');
  assert.equal(calls.send.length, 0);
  assert.deepEqual(calls.reply.map((c) => c.target), ['om_test_parent', 'om_test_root']);
  assertAllInteractive(calls);
});

test('reply failure falls back to a direct card send (not text)', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps({
    replyResults: [{ success: false, code: 230013, message: 'reply failed' }],
  });

  const result = await sendCard(
    { chatId: CHAT, type: 'group', msg: 'om_test_msg', cardPath },
    deps,
  );

  assert.equal(result.via, 'send');
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].msgType, 'interactive');
  assert.deepEqual(JSON.parse(calls.send[0].content), VALID_CARD);
  assertAllInteractive(calls);
});

test('reply throwing also falls back to a direct card send', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps({
    replyResults: [new Error('socket hang up')],
  });

  const result = await sendCard(
    { chatId: CHAT, type: 'group', root: 'om_test_root', parent: 'om_test_parent', cardPath },
    deps,
  );

  assert.equal(result.via, 'send');
  assert.equal(calls.send.length, 1);
  assertAllInteractive(calls);
});

test('every attempt failing reports ERR_CARD_SEND and still never sends text', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { calls, deps } = makeDeps({
    replyResults: [
      { success: false, code: 230013, message: 'parent gone' },
      { success: false, code: 230014, message: 'root gone' },
    ],
    sendResult: { success: false, code: 230020, message: 'bot not in chat' },
  });

  await assert.rejects(
    sendCard(
      { chatId: CHAT, type: 'group', root: 'om_test_root', parent: 'om_test_parent', cardPath },
      deps,
    ),
    (err) => {
      assert.equal(err.code, 'ERR_CARD_SEND');
      assert.equal(err.message, 'ERR_CARD_SEND: 230020 bot not in chat');
      return true;
    },
  );

  assert.deepEqual(calls.reply.map((c) => c.target), ['om_test_parent', 'om_test_root']);
  assert.equal(calls.send.length, 1);
  assertAllInteractive(calls);
});

test('invalid JSON is rejected before anything is sent', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, '{ not json', 'broken.card.json');
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath }, deps),
    'ERR_CARD_JSON',
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('non-object top-level JSON is rejected', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, '[]', 'array.card.json');
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath }, deps),
    'ERR_CARD_JSON',
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('schema other than "2.0" is rejected', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, { schema: '1.0', body: { elements: [] } }, 'old.card.json');
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath }, deps),
    'ERR_CARD_SCHEMA',
    /expected schema "2\.0"/,
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('card 2.0 without a body object is rejected', async (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, { schema: '2.0', header: {} }, 'no-body.card.json');
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath }, deps),
    'ERR_CARD_SCHEMA',
    /missing body object/,
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('a missing file is rejected', async (t) => {
  const dir = tmpdir(t);
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath: path.join(dir, 'nope.card.json') }, deps),
    'ERR_CARD_PATH',
    /cannot stat/,
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('a relative path is rejected', async (t) => {
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath: 'relative/card.json' }, deps),
    'ERR_CARD_PATH',
    /not an absolute path/,
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('a directory is rejected', async (t) => {
  const dir = tmpdir(t);
  const { calls, deps } = makeDeps();

  await expectError(
    () => sendCard({ chatId: CHAT, type: 'p2p', cardPath: dir }, deps),
    'ERR_CARD_PATH',
    /not a regular file/,
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

/**
 * Build a card whose base-send request body is exactly `bytes` UTF-8 bytes.
 * The fill is mostly CJK (3 bytes per character) so the test would fail if the
 * size check counted characters instead of UTF-8 bytes.
 */
function cardForSendBytes(bytes, chatId = CHAT) {
  const cardWith = (content) => ({ schema: '2.0', body: { elements: [{ tag: 'markdown', content }] } });
  const baseContent = JSON.stringify(cardWith(''));
  const baseBytes = requestBodyBytes(sendRequestBody(chatId, baseContent));
  const delta = bytes - baseBytes;
  assert.ok(delta >= 0, `request body is already ${baseBytes} bytes`);
  const cjk = Math.floor(delta / 3);
  const ascii = delta - cjk * 3;
  return cardWith('中'.repeat(cjk) + 'x'.repeat(ascii));
}

test('a card request body of exactly 30720 UTF-8 bytes is accepted', async (t) => {
  const dir = tmpdir(t);
  const card = cardForSendBytes(CARD_MAX_REQUEST_BYTES);
  const cardPath = writeCard(dir, card);
  const { calls, deps } = makeDeps();

  const result = await sendCard({ chatId: CHAT, type: 'p2p', cardPath }, deps);

  assert.equal(result.via, 'send');
  assert.equal(calls.send.length, 1);
  const content = calls.send[0].content;
  assert.equal(requestBodyBytes(sendRequestBody(CHAT, content)), CARD_MAX_REQUEST_BYTES);
  assert.match(content, /中/, 'the boundary card must actually contain multi-byte text');
  assertAllInteractive(calls);
});

test('a card request body of 30721 UTF-8 bytes is rejected before sending', async (t) => {
  const dir = tmpdir(t);
  const card = cardForSendBytes(CARD_MAX_REQUEST_BYTES + 1);
  const cardPath = writeCard(dir, card);
  const { calls, deps } = makeDeps();

  await assert.rejects(
    sendCard({ chatId: CHAT, type: 'p2p', cardPath }, deps),
    (err) => {
      assert.equal(err.code, 'ERR_CARD_TOO_LARGE');
      assert.equal(err.message, `ERR_CARD_TOO_LARGE: ${CARD_MAX_REQUEST_BYTES + 1}/${CARD_MAX_REQUEST_BYTES}`);
      return true;
    },
  );
  assert.equal(calls.reply.length + calls.send.length, 0);
});

test('readCardFile returns the parsed card and its compact content', (t) => {
  const dir = tmpdir(t);
  const cardPath = writeCard(dir, VALID_CARD);
  const { card, content } = readCardFile(cardPath);
  assert.deepEqual(card, VALID_CARD);
  assert.equal(content, JSON.stringify(VALID_CARD));
});

test('summary falls back to the header title, then to "card"', () => {
  assert.equal(cardSummary({ config: { summary: { content: 'S' } }, header: { title: { content: 'T' } } }), 'S');
  assert.equal(cardSummary({ header: { title: { content: 'T' } } }), 'T');
  assert.equal(cardSummary({ header: { title: 'Plain title' } }), 'Plain title');
  assert.equal(cardSummary({ body: {} }), 'card');
});
