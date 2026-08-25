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
