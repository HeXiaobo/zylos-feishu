import test from 'node:test';
import assert from 'node:assert/strict';

import { buildC4ReceiveArgs } from '../src/lib/task-entry.js';
import { createWorkIntakeResultHandler } from '../src/lib/work-intake-result.js';

test('natural-language intake carries a stable assistant request but opens a card only for chat', async () => {
  const assistantRequest = {
    requestId: 'assistant.feishu.om_natural',
    sourceId: 'om_natural',
  };
  const workIntakeEnvelope = {
    source: {
      channel: 'feishu',
      messageId: 'om_natural',
      conversationId: 'oc_natural',
      conversationType: 'direct',
      threadId: null,
    },
    sender: { id: 'ou_sender', kind: 'human' },
    text: '请玥然整理客户记录',
    intentRevision: 1,
    receivedAt: null,
    timeZone: 'Asia/Shanghai',
    people: [],
  };

  const args = buildC4ReceiveArgs({
    receiverPath: '/opt/zylos/c4-receive.js',
    source: 'feishu',
    endpoint: 'oc_natural|type:p2p|msg:om_natural',
    content: '[Feishu DM] Sender said: natural task',
    assistantRequest,
    workIntakeEnvelope,
  });
  assert.ok(args.includes('--assistant-request-id'));
  assert.ok(args.includes('--work-intake-envelope-json'));

  const opened = [];
  const receipts = [];
  const confirmations = [];
  const handler = createWorkIntakeResultHandler({
    startAssistantResponse: async (input) => {
      opened.push(input);
      return { success: true };
    },
    sendTaskReceipt: async (input) => {
      receipts.push(input);
      return { success: true };
    },
    sendConfirmationCard: async (input) => {
      confirmations.push(input);
      return { success: true };
    },
  });
  const context = { assistantRequest, inboundEnvelope: workIntakeEnvelope };

  await handler.handle({
    workIntake: { decision: 'chat_only', replayed: false },
    assistantResponse: { requestId: assistantRequest.requestId },
  }, context);
  assert.equal(opened.length, 1);

  await handler.handle({
    workIntake: {
      decision: 'create_task',
      replayed: false,
      sourceKey: 'feishu:om_natural:work-intake:r1',
      taskDraft: { title: '整理客户记录' },
    },
  }, context);
  assert.equal(receipts.length, 1);
  assert.equal(opened.length, 1);

  await handler.handle({
    workIntake: {
      decision: 'confirm',
      replayed: false,
      sourceKey: 'feishu:om_natural:work-intake:r1',
    },
  }, context);
  assert.equal(confirmations.length, 1);
  assert.equal(opened.length, 1);
});
