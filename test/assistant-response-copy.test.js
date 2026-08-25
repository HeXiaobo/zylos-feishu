import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAssistantResponseCopyRuntime } from '../src/lib/assistant-response-copy.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';

function withState(testFn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-response-copy-'));
  return Promise.resolve()
    .then(() => testFn(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

function createClient() {
  let messages = 0;
  return {
    im: {
      message: {
        async create() {
          messages += 1;
          return { code: 0, data: { message_id: `om_copy_${messages}` } };
        },
        async reply() {
          messages += 1;
          return { code: 0, data: { message_id: `om_copy_${messages}` } };
        },
      },
      v1: { message: { async patch() { return { code: 0 }; } } },
    },
    cardkit: { v1: { card: {
      async idConvert() { return { code: 0, data: { card_id: 'AA_copy' } }; },
      async update() { return { code: 0 }; },
      async settings() { return { code: 0 }; },
    } } },
  };
}

test('returns a card answer as plain text only after its own copy button is clicked', () => withState(async stateDirectory => {
  const requestId = 'assistant.feishu.proactive.copy-1';
  const output = '可复制的完整答案。'.repeat(250);
  const stream = createConversationResponseStream({
    client: createClient(),
    stateDirectory,
    throttleMs: 0,
  });
  const sent = await stream.sendCompleted({
    requestId,
    target: { chatId: 'oc_copy', chatType: 'p2p', replyToMessageId: null },
    output,
  });
  const sends = [];
  const runtime = createAssistantResponseCopyRuntime({
    stateDirectory,
    maxChunkCharacters: 1_800,
    sendText: async input => {
      sends.push(input);
      return { success: true, messageId: `om_plain_${sends.length}` };
    },
  });

  const result = await runtime.handle({
    context: { open_message_id: sent.messageId, open_chat_id: 'oc_copy' },
    operator: { open_id: 'ou_copying_user' },
    action: {
      tag: 'button',
      value: { action: 'assistant_response_copy', requestId },
    },
  });

  assert.equal(result.kind, 'assistant-response-copy');
  assert.deepEqual(result.toast, { type: 'success', content: '已发送可复制文本' });
  assert.ok(sends.length > 1);
  assert.equal(sends.map(item => item.text).join(''), output);
  assert.ok(sends.every(item => item.target.chatId === 'oc_copy'));
  assert.ok(sends.every(item => item.messageId === sent.messageId));
}));

test('rejects a forged copy action that does not belong to the clicked card', () => withState(async stateDirectory => {
  const requestId = 'assistant.feishu.proactive.copy-2';
  const stream = createConversationResponseStream({
    client: createClient(),
    stateDirectory,
    throttleMs: 0,
  });
  await stream.sendCompleted({
    requestId,
    target: { chatId: 'oc_copy', chatType: 'p2p', replyToMessageId: null },
    output: '受保护的答案。'.repeat(40),
  });
  const runtime = createAssistantResponseCopyRuntime({
    stateDirectory,
    sendText: async () => ({ success: true }),
  });

  await assert.rejects(() => runtime.handle({
    context: { open_message_id: 'om_forged', open_chat_id: 'oc_copy' },
    operator: { open_id: 'ou_copying_user' },
    action: {
      tag: 'button',
      value: { action: 'assistant_response_copy', requestId },
    },
  }), /does not own the clicked card/);
}));
