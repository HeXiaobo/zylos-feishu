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

test('updates the linked card in place using a version-scoped CardKit sequence', async () => {
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
    sequence: 89,
  });
  assert.match(updates[0][2].uuid, /^ztc_[a-f0-9]{40}$/);
});

test('SDK publisher forwards the stable create UUID to the placeholder message', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const creates = [];
  const patches = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          creates.push(payload);
          return { code: 0, data: { message_id: 'om_sdk_projected_task' } };
        },
      },
      v1: {
        message: {
          async patch(payload) {
            patches.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            return { code: 230001, msg: 'CardKit unavailable' };
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
  assert.equal(JSON.parse(creates[0].data.content).config.streaming_mode, true);
  assert.equal(JSON.parse(patches[0].data.content).header.title.content, '任务待验收');
});

test('SDK publisher resolves Feishu member IDs to names before projecting a task card', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const patches = [];
  const names = new Map([
    ['ou_owner', '业务负责人'],
    ['ou_acceptor', '任务验收人'],
    ['ou_assignee', '任务执行人'],
  ]);
  const client = {
    contact: {
      user: {
        async get(payload) {
          return {
            code: 0,
            data: { user: { name: names.get(payload.path.user_id) } },
          };
        },
      },
    },
    im: {
      message: {
        async create() {
          return { code: 0, data: { message_id: 'om_named_task' } };
        },
      },
      v1: {
        message: {
          async patch(payload) {
            patches.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            return { code: 230001, msg: 'CardKit unavailable' };
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

  await publisher.createTask({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    task: task({ assigneeId: 'ou_assignee' }),
    idempotencyKey: 'feishu:create:task-projection-named',
  });

  const projectedCard = JSON.parse(patches[0].data.content);
  const serialized = JSON.stringify(projectedCard);
  assert.match(serialized, /负责人：业务负责人/);
  assert.match(serialized, /验收人：任务验收人/);
  assert.match(serialized, /执行人：任务执行人/);
  assert.doesNotMatch(serialized, /ou_owner|ou_acceptor|ou_assignee/);
});

test('SDK publisher uses native CardKit streaming for task-card creation', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  const calls = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          calls.push(['send', payload]);
          return { code: 0, data: { message_id: 'om_sdk_streamed_task' } };
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert(payload) {
            calls.push(['id-convert', payload]);
            return { code: 0, data: { card_id: 'AA-sdk-streamed-task' } };
          },
          async update(payload) {
            calls.push(['final-card', payload]);
            return { code: 0, data: {} };
          },
          async settings(payload) {
            calls.push(['finish', payload]);
            return { code: 0, data: {} };
          },
        },
        cardElement: {
          async content(payload) {
            calls.push(['progress', payload]);
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

  const result = await publisher.createTask({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    task: task(),
    idempotencyKey: 'feishu:create:task-projection-streamed',
  });

  assert.deepEqual(result, { externalId: 'om_sdk_streamed_task' });
  assert.deepEqual(calls.map(([name]) => name), [
    'send',
    'id-convert',
    'progress',
    'progress',
    'final-card',
    'finish',
  ]);
  assert.deepEqual(
    calls.filter(([name]) => name === 'progress').map(([, payload]) => payload.data.sequence),
    [71, 72],
  );
  assert.equal(calls.at(-2)[1].data.sequence, 73);
  assert.equal(calls.at(-1)[1].data.sequence, 74);
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
  assert.equal(updates[0].data.sequence, 99);
  assert.match(updates[0].data.uuid, /^ztc_[a-f0-9]{40}$/);
  assert.equal(updates[0].data.card.type, 'card_json');
  assert.equal(JSON.parse(updates[0].data.card.data).header.title.content, '任务执行中');
  assert.equal(JSON.parse(updates[0].data.card.data).schema, '2.0');
});

test('SDK publisher treats an already-applied CardKit sequence as an idempotent replay', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  let updates = 0;
  const client = {
    im: { message: { async create() { throw new Error('create must not run'); } } },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            return { code: 0, data: { card_id: 'AA-replayed-card' } };
          },
          async update() {
            updates += 1;
            return { code: 300317, msg: 'sequence number compare failed' };
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
    externalId: 'om_replayed_task',
    task: task({ state: 'done', version: 8 }),
    idempotencyKey: 'feishu:update:task-projection-1:8',
  });

  assert.deepEqual(result, { externalId: 'om_replayed_task' });
  assert.equal(updates, 1);
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

test('rejects task versions outside the Feishu int32 sequence range before updating', async () => {
  const signer = createTaskActionContextSigner({ secret: SECRET, clock: () => NOW });
  let updates = 0;
  const publisher = createTaskCardProjectionPublisher({
    sendMessage: async () => ({ success: true, messageId: 'om_unused' }),
    updateInteractiveCard: async () => {
      updates += 1;
      return { success: true };
    },
    issueTaskActionContext: claims => signer.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  await assert.rejects(
    publisher.updateTask({
      target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
      externalId: 'om_sequence_too_large',
      task: task({ version: 214_748_365 }),
      idempotencyKey: 'feishu:update:task-sequence-too-large',
    }),
    /32-bit CardKit sequence/,
  );
  assert.equal(updates, 0);
});
