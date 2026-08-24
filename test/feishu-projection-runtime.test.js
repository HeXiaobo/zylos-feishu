import assert from 'node:assert/strict';
import test from 'node:test';

import { createFeishuProjectionRuntime } from '../src/lib/feishu-projection-runtime.js';

const NOW = 1_700_000_000_000;
const SECRET = 'projection-runtime-secret-at-least-32-bytes';

function task() {
  return {
    id: 'task-runtime-1',
    title: 'Follow up with the customer',
    description: null,
    state: 'ready',
    ownerId: 'ou_owner',
    acceptorId: 'ou_acceptor',
    assigneeId: 'agent:yueran',
    version: 1,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
  };
}

test('exports the narrow Core projection runtime without credentials in Core', async () => {
  const creates = [];
  const runtime = await createFeishuProjectionRuntime({
    env: { FEISHU_TASK_CONTEXT_SECRET: SECRET },
    client: {
      im: {
        message: {
          async create(payload) {
            creates.push(payload);
            return { code: 0, data: { message_id: 'om_runtime_card' } };
          },
        },
      },
      cardkit: { v1: { card: {} } },
    },
    clock: () => NOW,
  });

  assert.deepEqual(Object.keys(runtime), ['publisher']);
  assert.equal(typeof runtime.publisher.createTask, 'function');
  assert.equal(typeof runtime.publisher.updateTask, 'function');

  const result = await runtime.publisher.createTask({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    task: task(),
    idempotencyKey: 'feishu:create:task-runtime-1',
  });

  assert.deepEqual(result, { externalId: 'om_runtime_card' });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].data.receive_id, 'ou_acceptor');
});

test('fails closed when the dedicated task context secret is missing', async () => {
  await assert.rejects(
    createFeishuProjectionRuntime({
      env: {},
      client: {},
      clock: () => NOW,
    }),
    /secret must contain at least 32 bytes/,
  );
});
