import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('zero-argument production factory loads Feishu credentials from ~/zylos/.env', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-runtime-'));
  const zylosDir = path.join(home, 'zylos');
  fs.mkdirSync(zylosDir, { recursive: true });
  fs.writeFileSync(
    path.join(zylosDir, '.env'),
    [
      'FEISHU_APP_ID=cli_test_app',
      'FEISHU_APP_SECRET=cli_test_secret',
      `FEISHU_TASK_CONTEXT_SECRET=${SECRET}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  try {
    const childEnv = { ...process.env, HOME: home };
    delete childEnv.FEISHU_APP_ID;
    delete childEnv.FEISHU_APP_SECRET;
    delete childEnv.FEISHU_TASK_CONTEXT_SECRET;
    const runtimePath = fileURLToPath(
      new URL('../src/lib/feishu-projection-runtime.js', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const runtime = await import(${JSON.stringify(runtimePath)});`
          + 'const value = await runtime.createFeishuProjectionRuntime();'
          + 'process.stdout.write(JSON.stringify(Object.keys(value)));',
      ],
      {
        encoding: 'utf8',
        env: childEnv,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), ['publisher']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
