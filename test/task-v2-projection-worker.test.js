import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskV2MemberMapper } from '../src/lib/task-v2-member-mapper.js';
import { TASK_V2_PROJECTION } from '../src/lib/task-v2-projection.js';
import {
  createTaskV2ProjectionRuntime,
  initializeTaskV2Projection,
  loadCommitmentProjectionDependencies,
  resolveTaskV2Url,
  runTaskV2Reconciliation,
  runTaskV2ProjectionOnce,
  superviseTaskV2Projection,
} from '../src/lib/task-v2-projection-worker.js';

test('production dependency loader requires the Core external Task mapper', async () => {
  const imported = [];
  const openCommitmentCore = () => {};
  const processProjectionBatch = async () => {};
  const reconcileProjection = () => {};
  const mapExternalTaskEvent = event => event;
  const modules = new Map([
    ['core.js', { openCommitmentCore }],
    ['projection-worker.js', { processProjectionBatch }],
    ['reconcile-projection.js', { reconcileProjection }],
    ['external-task-adapter.js', { mapExternalTaskEvent }],
  ]);

  const dependencies = await loadCommitmentProjectionDependencies({
    env: { ZYLOS_DIR: '/runtime/zylos' },
    async importModule(specifier) {
      imported.push(specifier);
      const name = [...modules.keys()].find(candidate => specifier.endsWith(candidate));
      return modules.get(name);
    },
  });

  assert.equal(dependencies.mapExternalTaskEvent, mapExternalTaskEvent);
  assert.deepEqual(imported.map(specifier => specifier.split('/').at(-1)), [
    'core.js',
    'projection-worker.js',
    'reconcile-projection.js',
    'external-task-adapter.js',
  ]);
});

test('production dependency loader fails closed when Core lacks the external Task mapper', async () => {
  const modules = [
    { openCommitmentCore() {} },
    { processProjectionBatch() {} },
    { reconcileProjection() {} },
    {},
  ];

  await assert.rejects(
    loadCommitmentProjectionDependencies({
      env: { ZYLOS_DIR: '/runtime/zylos' },
      async importModule() { return modules.shift(); },
    }),
    /installed Commitment Core has no mapExternalTaskEvent/,
  );
});

function fakeCore() {
  const calls = [];
  const task = {
    id: 'task-worker', title: 'Worker task', description: null, state: 'ready',
    ownerId: 'ou_owner', acceptorId: 'ou_owner', assigneeId: 'agent:yueran',
    dueAt: null, version: 1, createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
  };
  const core = {
    outbox: {
      register(request) {
        calls.push(['register', request]);
        return { created: true, registration: request };
      },
    },
    query(query = {}) {
      return query.taskId ? { ...task } : [{ ...task }];
    },
    externalLinks: {
      query(query) { return query?.externalId ? null : []; },
      link() { return { created: true }; },
    },
    command(command, expectedVersion) {
      assert.equal(expectedVersion, task.version);
      calls.push(['command', command]);
      if (command.type === 'StartTask') task.state = 'in_progress';
      else if (command.type === 'SubmitForReview') task.state = 'review';
      else throw new Error(`unexpected Core command: ${command.type}`);
      task.version += 1;
      return { task: { ...task } };
    },
    close() { calls.push(['close']); },
  };
  return { core, calls };
}

test('production runtime shares one App identity and an injectable durable status inbox', () => {
  const statusInbox = { pending() {}, ack() {}, fail() {} };
  const taskApi = {
    async create() {}, async patch() {}, async get() {},
    async addMembers() {}, async removeMembers() {}, async list() {},
  };
  const runtime = createTaskV2ProjectionRuntime({
    env: { FEISHU_APP_ID: 'cli_gateway', ZYLOS_AGENT_ID: 'agent:mylos' },
    client: { task: { v2: { task: taskApi } } },
    statusInbox,
  });

  assert.equal(runtime.appId, 'cli_gateway');
  assert.equal(runtime.statusInbox, statusInbox);
  assert.deepEqual(runtime.memberMapper.map({
    ownerId: 'ou_owner', acceptorId: 'ou_owner', assigneeId: 'agent:mylos',
  }), [
    { id: 'ou_owner', type: 'user', role: 'follower' },
    { id: 'cli_gateway', type: 'app', role: 'assignee' },
  ]);
});

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
    memberMapper: createTaskV2MemberMapper({ appId: 'cli_yueran', agentId: 'agent:yueran' }),
    openCore: () => harness.core,
    async processBatch(options) {
      assert.equal(options.projection, TASK_V2_PROJECTION);
      const receipt = await options.adapter.publishDelivery({
        delivery: {
          projection: TASK_V2_PROJECTION,
          event: { taskId: 'task-worker' },
        },
      });
      return { projection: options.projection, published: receipt ? 1 : 0 };
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

test('one worker cycle drains the durable reverse-status inbox after outbound settlement', async () => {
  const harness = fakeCore();
  const event = { event_id: 'evt-unlinked', task_id: 'guid-unlinked', app_id: 'cli_yueran' };
  const acknowledgements = [];
  const result = await runTaskV2ProjectionOnce({
    workerId: 'task-v2-worker',
    operationId: 'cycle-with-inbox',
    appId: 'cli_yueran',
    statusInbox: {
      pending() { return [event]; },
      ack(request) {
        acknowledgements.push(request);
        return { status: 'acknowledged' };
      },
      fail() { throw new Error('unexpected fail'); },
    },
    gateway: {
      async findTasksByCoreTaskId() { return []; },
      async createTask() { throw new Error('unexpected create'); },
      async updateTask() { throw new Error('unexpected update'); },
      async getTask() { throw new Error('unlinked event must not read Feishu'); },
    },
    memberMapper: createTaskV2MemberMapper({ appId: 'cli_yueran', agentId: 'agent:yueran' }),
    mapExternalTaskEvent() { throw new Error('unlinked event must not be mapped'); },
    openCore: () => harness.core,
    async processBatch() {
      return { projection: TASK_V2_PROJECTION, idle: true };
    },
  });

  assert.deepEqual(result.statusInbox, {
    claimed: 1, acknowledged: 1, retryWaiting: 0, deadLettered: 0,
  });
  assert.equal(acknowledgements[0].eventId, event.event_id);
  assert.equal(acknowledgements[0].result.status, 'unlinked');
});

test('reconciliation combines the Feishu snapshot with the Core generic diff', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.query = () => [];
  const report = await runTaskV2Reconciliation({
    openCore: () => harness.core,
    gateway: { async findTasksByCoreTaskId() { return []; } },
    tasks: [harness.core.query({ taskId: 'task-worker' })],
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

test('explicit reconciliation repair converts linked native completion only to Core review', async () => {
  const harness = fakeCore();
  const mappedEvents = [];
  harness.core.externalLinks.query = query => (
    query.externalId
      ? { taskId: 'task-worker', externalId: 'guid-worker' }
      : [{ taskId: 'task-worker', externalId: 'guid-worker' }]
  );
  const gateway = {
    async findTasksByCoreTaskId() {
      return [{ guid: 'guid-worker', url: 'https://task/guid-worker', completedAt: '1787900000000' }];
    },
    async getTask() { return { completedAt: '1787900000000' }; },
  };

  const report = await runTaskV2Reconciliation({
    openCore: () => harness.core,
    gateway,
    appId: 'cli_yueran',
    repairStatus: true,
    mapExternalTaskEvent(externalEvent) {
      mappedEvents.push(externalEvent);
      return {
        command: {
          type: 'SubmitForReview',
          taskId: externalEvent.taskId,
          actorId: externalEvent.actorId,
          idempotencyKey: `mapped:${externalEvent.eventId}`,
        },
        expectedVersion: externalEvent.expectedVersion,
      };
    },
    reconcile: () => ({
      consistent: false, missing: [], unexpected: [], stateMismatches: [], duplicateKeys: [],
    }),
  });

  assert.equal(report.repairs[0].status, 'submitted_for_review');
  assert.equal(harness.core.query({ taskId: 'task-worker' }).state, 'review');
  assert.deepEqual(
    harness.calls.filter(([operation]) => operation === 'command').map(([, command]) => command.type),
    ['StartTask', 'SubmitForReview'],
  );
  assert.equal(mappedEvents.length, 1);
  assert.equal(mappedEvents[0].eventType, 'completed');
});

test('URL resolver exposes the linked native Task URL through a stable user-facing command seam', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.query = () => [{ externalId: 'guid-worker' }];

  const result = await resolveTaskV2Url({
    taskId: 'task-worker',
    openCore: () => harness.core,
    gateway: {
      async getTask(taskGuid) {
        assert.equal(taskGuid, 'guid-worker');
        return { guid: taskGuid, url: 'https://applink.feishu.cn/task/guid-worker' };
      },
    },
  });

  assert.deepEqual(result, {
    status: 'linked',
    taskId: 'task-worker',
    taskGuid: 'guid-worker',
    url: 'https://applink.feishu.cn/task/guid-worker',
  });
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
