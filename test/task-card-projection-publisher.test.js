import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskActionContextSigner } from '../src/lib/task-action-context.js';
import {
  createSdkTaskCardProjectionPublisher,
  createTaskCardProjectionPublisher,
} from '../src/lib/task-card-projection-publisher.js';

const NOW = 1_700_000_000_000;
const SECRET = 'projection-publisher-secret-at-least-32-bytes';

function task(overrides = {}) {
  return {
    id: 'task-projection-1',
    title: 'Follow up with the customer',
    description: 'Confirm the next meeting.',
    state: 'review',
    ownerId: 'ou_owner',
    acceptorId: 'ou_acceptor',
    assigneeId: 'agent:yueran',
    version: 7,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

test('creates one task card with a stable Feishu UUID and returns its external link ID', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const sends = [];
  const publisher = createTaskCardProjectionPublisher({
    sendMessage: async (...args) => {
      sends.push(args);
      return { success: true, messageId: 'om_projected_task_1' };
    },
    updateInteractiveCard: async () => {
      throw new Error('update must not be called');
    },
    issueTaskActionContext: claims => signer.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const request = {
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    task: task(),
    idempotencyKey: 'feishu:create:task-projection-1',
  };

  const first = await publisher.createTask(request);
  const second = await publisher.createTask(request);

  assert.deepEqual(first, { externalId: 'om_projected_task_1' });
  assert.deepEqual(second, first);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].slice(0, 4), [
    'ou_acceptor',
    sends[0][1],
    'open_id',
    'interactive',
  ]);
  assert.equal(sends[0][1].header.title.content, '任务待验收');
  assert.equal(sends[0][1].schema, '2.0');
  assert.equal(Array.isArray(sends[0][1].body.elements), true);
  assert.match(sends[0][4].uuid, /^ztc_[a-f0-9]{40}$/);
  assert.equal(sends[1][4].uuid, sends[0][4].uuid);
});

test('updates the linked card in place using Core task version as the CardKit sequence', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const updates = [];
  const publisher = createTaskCardProjectionPublisher({
    sendMessage: async () => {
      throw new Error('create must not be called');
    },
    updateInteractiveCard: async (...args) => {
      updates.push(args);
      return { success: true };
    },
    issueTaskActionContext: claims => signer.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const request = {
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    externalId: 'om_projected_task_1',
    task: task({ state: 'done', version: 8 }),
    idempotencyKey: 'feishu:update:task-projection-1:8',
  };

  const result = await publisher.updateTask(request);

  assert.deepEqual(result, { externalId: 'om_projected_task_1' });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], 'om_projected_task_1');
  assert.equal(updates[0][1].header.title.content, '任务已完成');
  assert.deepEqual(updates[0][2], {
    uuid: updates[0][2].uuid,
    sequence: 8,
  });
  assert.match(updates[0][2].uuid, /^ztc_[a-f0-9]{40}$/);
});

test('SDK publisher forwards the stable create UUID to Feishu message.create', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const creates = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          creates.push(payload);
          return { code: 0, data: { message_id: 'om_sdk_projected_task' } };
        },
      },
    },
    cardkit: { v1: { card: {} } },
  };
  const publisher = createSdkTaskCardProjectionPublisher({
    client,
    issueTaskActionContext: claims => signer.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  const result = await publisher.createTask({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    task: task(),
    idempotencyKey: 'feishu:create:task-projection-1',
  });

  assert.deepEqual(result, { externalId: 'om_sdk_projected_task' });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].params.receive_id_type, 'open_id');
  assert.equal(creates[0].data.receive_id, 'ou_acceptor');
  assert.equal(creates[0].data.msg_type, 'interactive');
  assert.match(creates[0].data.uuid, /^ztc_[a-f0-9]{40}$/);
  assert.equal(JSON.parse(creates[0].data.content).header.title.content, '任务待验收');
});

test('SDK publisher converts a message ID and performs one CardKit full update', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const converts = [];
  const updates = [];
  const client = {
    im: { message: { async create() { throw new Error('create must not run'); } } },
    cardkit: {
      v1: {
        card: {
          async idConvert(payload) {
            converts.push(payload);
            return { code: 0, data: { card_id: 'AAqbc-card-instance' } };
          },
          async update(payload) {
            updates.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
  };
  const publisher = createSdkTaskCardProjectionPublisher({
    client,
    issueTaskActionContext: claims => signer.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  const result = await publisher.updateTask({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    externalId: 'om_sdk_projected_task',
    task: task({ state: 'in_progress', version: 9 }),
    idempotencyKey: 'feishu:update:task-projection-1:9',
  });

  assert.deepEqual(result, { externalId: 'om_sdk_projected_task' });
  assert.deepEqual(converts, [{ data: { message_id: 'om_sdk_projected_task' } }]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].path.card_id, 'AAqbc-card-instance');
  assert.equal(updates[0].data.sequence, 9);
  assert.match(updates[0].data.uuid, /^ztc_[a-f0-9]{40}$/);
  assert.equal(updates[0].data.card.type, 'card_json');
  assert.equal(JSON.parse(updates[0].data.card.data).header.title.content, '任务执行中');
  assert.equal(JSON.parse(updates[0].data.card.data).schema, '2.0');
});

test('fails closed on ambiguous request fields and unbounded identities', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const publisher = createTaskCardProjectionPublisher({
    sendMessage: async () => ({ success: true, messageId: 'om_unused' }),
    updateInteractiveCard: async () => ({ success: true }),
    issueTaskActionContext: claims => signer.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  await assert.rejects(
    publisher.createTask({
      target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
      task: task(),
      idempotencyKey: 'feishu:create:task-projection-1',
      debug: true,
    }),
    /unsupported or missing fields/,
  );
  await assert.rejects(
    publisher.createTask({
      target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
      task: task(),
      idempotencyKey: 'x'.repeat(513),
    }),
    /exceeds 512 characters/,
  );
});
