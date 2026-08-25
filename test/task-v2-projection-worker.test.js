import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskV2MemberMapper } from '../src/lib/task-v2-member-mapper.js';
import { TASK_V2_PROJECTION } from '../src/lib/task-v2-projection.js';
import {
  initializeTaskV2Projection,
  runTaskV2Reconciliation,
  runTaskV2ProjectionOnce,
  superviseTaskV2Projection,
} from '../src/lib/task-v2-projection-worker.js';

function fakeCore() {
  const calls = [];
  const core = {
    outbox: {
      register(request) {
        calls.push(['register', request]);
        return { created: true, registration: request };
      },
    },
    query() {
      return {
        id: 'task-worker', title: 'Worker task', description: null, state: 'ready',
        ownerId: 'ou_owner', acceptorId: 'ou_owner', assigneeId: 'agent:yueran',
        dueAt: null, version: 1, createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      };
    },
    externalLinks: {
      query() { return []; },
      link() { return { created: true }; },
    },
    close() { calls.push(['close']); },
  };
  return { core, calls };
}

test('registers a separately named Task v2 projection with explicit history policy', () => {
  const harness = fakeCore();
  const result = initializeTaskV2Projection({
    bootstrapPolicy: 'from_now',
    openCore: () => harness.core,
  });
  assert.equal(result.registration.projection, TASK_V2_PROJECTION);
  assert.deepEqual(harness.calls.map(([operation]) => operation), ['register', 'close']);
});

test('one worker cycle injects the Core batch worker and always closes Core', async () => {
  const harness = fakeCore();
  const creates = [];
  const summary = await runTaskV2ProjectionOnce({
    workerId: 'task-v2-worker',
    operationId: 'cycle-1',
    gateway: {
      async findTasksByCoreTaskId() { return []; },
      async createTask(request) {
        creates.push(request);
        return { guid: 'guid-worker', url: 'https://task/guid-worker' };
      },
      async updateTask() { throw new Error('unexpected update'); },
    },
    memberMapper: createTaskV2MemberMapper({ appId: 'cli_yueran' }),
    openCore: () => harness.core,
    async processBatch(options) {
      assert.equal(options.projection, TASK_V2_PROJECTION);
      const receipts = await options.adapter.publishBatch({
        deliveries: [{
          projection: TASK_V2_PROJECTION,
          event: { taskId: 'task-worker' },
        }],
      });
      return { projection: options.projection, published: receipts.length };
    },
  });
  assert.deepEqual(summary, {
    projection: TASK_V2_PROJECTION,
    published: 1,
    receipts: [{
      taskId: 'task-worker',
      taskGuid: 'guid-worker',
      url: 'https://task/guid-worker',
      created: true,
      recovered: false,
    }],
  });
  assert.equal(creates.length, 1);
  assert.deepEqual(harness.calls.map(([operation]) => operation), ['close']);
});

test('reconciliation combines the Feishu snapshot with the Core generic diff', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.query = () => [];
  const report = await runTaskV2Reconciliation({
    openCore: () => harness.core,
    gateway: { async findTasksByCoreTaskId() { return []; } },
    tasks: [harness.core.query()],
    reconcile({ expected, actual }) {
      assert.equal(expected.length, 1);
      assert.deepEqual(actual, []);
      return {
        consistent: false,
        missing: expected,
        unexpected: [],
        stateMismatches: [],
        duplicateKeys: [],
      };
    },
  });
  assert.equal(report.consistent, false);
  assert.deepEqual(report.missingLinks, [{ taskId: 'task-worker' }]);
  assert.deepEqual(harness.calls.map(([operation]) => operation), ['close']);
});

test('supervisor logs failures, continues, and stops cleanly', async () => {
  const controller = new AbortController();
  const logs = [];
  let cycles = 0;
  const result = await superviseTaskV2Projection({
    workerId: 'task-v2-worker',
    intervalMs: 250,
    signal: controller.signal,
    async runOnce() {
      cycles += 1;
      if (cycles === 1) throw new Error('temporary Feishu outage');
      controller.abort();
      return { projection: TASK_V2_PROJECTION, idle: true };
    },
    async sleepUntilNext() {},
    log(event) { logs.push(event); },
  });
  assert.deepEqual(result, { cycles: 2, stopReason: 'aborted' });
  assert.equal(logs[0].event, 'commitment_feishu_task_v2_projection_failed');
  assert.equal(logs[1].event, 'commitment_feishu_task_v2_projection');
});
