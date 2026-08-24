import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskActionContextSigner } from '../src/lib/task-action-context.js';
import { sendTaskCardCommand } from '../src/lib/task-card-send-command.js';

const NOW = 1_700_000_000_000;
const SECRET = 'feishu-card-context-secret-32-bytes';

test('provides a callable local sender seam backed by the existing Feishu message sender', async () => {
  const task = {
    id: 'task-send-command',
    title: 'Prepare the customer review',
    description: null,
    state: 'ready',
    ownerId: 'ou_owner',
    acceptorId: 'ou_acceptor',
    assigneeId: null,
    version: 2,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };
  const calls = [];

  const result = await sendTaskCardCommand({
    args: ['oc_task_chat', 'chat_id', JSON.stringify(task)],
    env: {
      FEISHU_TASK_CONTEXT_SECRET: SECRET,
      FEISHU_TASK_ACTION_TTL_MS: '600000',
    },
  }, {
    clock: () => NOW,
    sendMessage: async (...args) => {
      calls.push(args);
      return { success: true, messageId: 'om_sent_task_card' };
    },
  });

  assert.deepEqual(result, { success: true, messageId: 'om_sent_task_card' });
  assert.equal(calls.length, 1);
  const [receiveId, card, receiveIdType, messageType] = calls[0];
  assert.equal(receiveId, 'oc_task_chat');
  assert.equal(receiveIdType, 'chat_id');
  assert.equal(messageType, 'interactive');
  const context = card.body.elements
    .find((element) => element.tag === 'button')
    .behaviors[0].value.context;
  const verifier = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  assert.deepEqual(verifier.verify(context), {
    taskId: 'task-send-command',
    expectedVersion: 2,
    expiresAt: NOW + 600000,
  });
});

test('fails closed before sending when the dedicated context secret is missing', async () => {
  let sent = false;

  await assert.rejects(() => sendTaskCardCommand({
    args: ['oc_task_chat', 'chat_id', '{}'],
    env: {},
  }, {
    clock: () => NOW,
    sendMessage: async () => {
      sent = true;
      return { success: true };
    },
  }), /secret must contain at least 32 bytes/);
  assert.equal(sent, false);
});
