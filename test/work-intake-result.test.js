import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkIntakeResultHandler } from '../src/lib/work-intake-result.js';

const decision = {
  decision: 'confirm',
  reasonCode: 'INSUFFICIENT_TASK_DETAIL',
  intentRevision: 1,
  sourceKey: 'feishu:om_recover:work-intake:r1',
  taskDraft: {
    title: '跟一下这个事',
    description: null,
    ownerId: 'ou_sender',
    acceptorId: 'ou_sender',
    assigneeId: null,
    dueText: null,
    riskLevel: 'normal',
  },
};

test('a replay retries an undelivered confirmation with the same delivery identity', async () => {
  const attempts = [];
  const handler = createWorkIntakeResultHandler({
    sendConfirmationCard: async (request) => {
      attempts.push(request);
      if (attempts.length === 1) throw new Error('temporary Feishu failure');
      return { success: true, messageId: 'om_card' };
    },
    sendTaskReceipt: async () => ({ success: true }),
    startAssistantResponse: async () => ({ success: true }),
  });
  const context = {
    inboundEnvelope: { source: { messageId: 'om_recover' } },
    endpoint: 'oc_chat|type:p2p|msg:om_recover',
    messageId: 'om_recover',
    chatId: 'oc_chat',
    chatType: 'p2p',
    rootId: null,
    parentId: null,
  };

  await assert.rejects(
    () => handler.handle({ workIntake: { ...decision, replayed: false } }, context),
    /temporary Feishu failure/,
  );
  await handler.handle({ workIntake: { ...decision, replayed: true } }, context);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].deliveryKey, attempts[1].deliveryKey);
  assert.equal(attempts[0].deliveryKey, 'feishu:om_recover:work-intake:r1:confirmation-card');
  assert.equal(attempts[0].deliveryUuid, attempts[1].deliveryUuid);
  assert.match(attempts[0].deliveryUuid, /^zwi_[a-f0-9]{40}$/);
  assert.deepEqual(attempts[0].confirmation, {
    decision,
    inboundEnvelope: context.inboundEnvelope,
    endpoint: context.endpoint,
  });
  assert.equal(Object.hasOwn(attempts[0].confirmation.decision, 'replayed'), false);
});

test('only chat-only WorkIntake opens the deferred assistant response card', async () => {
  const starts = [];
  const handler = createWorkIntakeResultHandler({
    sendConfirmationCard: async () => ({ success: true }),
    sendTaskReceipt: async () => ({ success: true }),
    startAssistantResponse: async (request) => {
      starts.push(request);
      return { success: true };
    },
  });
  const context = {
    inboundEnvelope: { source: { messageId: 'om_chat' } },
    endpoint: 'oc_chat|type:p2p|msg:om_chat',
    messageId: 'om_chat',
    chatId: 'oc_chat',
    chatType: 'p2p',
    rootId: null,
    parentId: null,
    assistantRequest: {
      requestId: 'assistant.feishu.deferred-chat',
      sourceId: 'om_chat',
    },
  };

  const result = await handler.handle({
    workIntake: { decision: 'chat_only', replayed: false },
    assistantResponse: { requestId: context.assistantRequest.requestId },
  }, context);

  assert.deepEqual(result, { handled: true, replayed: false });
  assert.deepEqual(starts, [{
    requestId: context.assistantRequest.requestId,
    context,
  }]);
});

test('a Core replay retries a lost task receipt with the same Feishu UUID', async () => {
  const attempts = [];
  const handler = createWorkIntakeResultHandler({
    sendConfirmationCard: async () => ({ success: true }),
    startAssistantResponse: async () => ({ success: true }),
    sendTaskReceipt: async (request) => {
      attempts.push(request);
      if (attempts.length === 1) throw new Error('temporary receipt failure');
      return { success: true };
    },
  });
  const context = { chatId: 'oc_chat', chatType: 'p2p', messageId: 'om_task' };
  const workIntake = {
    decision: 'create_task',
    sourceKey: 'feishu:om_task:work-intake:r1',
    taskDraft: { title: '跟进客户' },
  };

  await assert.rejects(
    handler.handle({ workIntake: { ...workIntake, replayed: false } }, context),
    /temporary receipt failure/,
  );
  const replay = await handler.handle({ workIntake: { ...workIntake, replayed: true } }, context);

  assert.deepEqual(replay, { handled: true, replayed: true });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].deliveryKey, attempts[1].deliveryKey);
  assert.equal(attempts[0].deliveryUuid, attempts[1].deliveryUuid);
  assert.match(attempts[0].deliveryUuid, /^zwi_[a-f0-9]{40}$/);
});
