import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskV2MemberMapper } from '../src/lib/task-v2-member-mapper.js';
import {
  createTaskV2Projection,
  TASK_V2_LINK_BACKEND,
  TASK_V2_PROJECTION,
} from '../src/lib/task-v2-projection.js';
import { collectTaskV2ReconciliationSnapshot } from '../src/lib/task-v2-reconciliation-snapshot.js';
import { createSdkTaskV2Gateway } from '../src/lib/task-v2-sdk-adapter.js';
import { createTaskV2StatusEventHandler } from '../src/lib/task-v2-status-event.js';

const APP_ID = 'cli_zylos_yueran';
const DUE_AT = '2026-08-28T10:00:00.000Z';

function coreTask(overrides = {}) {
  return {
    id: 'task-1',
    title: '跟进客户方案',
    description: '提交修订后的方案',
    state: 'ready',
    ownerId: 'ou_owner',
    acceptorId: 'ou_acceptor',
    assigneeId: 'agent:yueran',
    dueAt: DUE_AT,
    version: 1,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

function fakeCore(tasks = [coreTask()]) {
  const taskMap = new Map(tasks.map(task => [task.id, { ...task }]));
  const links = [];
  const receipts = new Map();
  const commands = [];
  const core = {
    query(query) {
      if (query.taskId) return taskMap.get(query.taskId) ?? null;
      return [...taskMap.values()].slice(0, query.limit ?? 50);
    },
    externalLinks: {
      query(query) {
        if (query.taskId) {
          return links.filter(link => (
            link.taskId === query.taskId && (!query.backend || link.backend === query.backend)
          ));
        }
        if (query.externalId) {
          return links.find(link => (
            link.backend === query.backend && link.externalId === query.externalId
          )) ?? null;
        }
        return links.filter(link => link.backend === query.backend);
      },
      link(request) {
        if (receipts.has(request.idempotencyKey)) return receipts.get(request.idempotencyKey);
        const byTask = links.find(link => (
          link.taskId === request.taskId && link.backend === request.backend
        ));
        const byExternal = links.find(link => (
          link.backend === request.backend && link.externalId === request.externalId
        ));
        if (
          (byTask && byTask.externalId !== request.externalId)
          || (byExternal && byExternal.taskId !== request.taskId)
        ) {
          const error = new Error('external link conflict');
          error.code = 'EXTERNAL_LINK_CONFLICT';
          throw error;
        }
        const link = byTask ?? byExternal ?? {
          id: `link-${links.length + 1}`,
          taskId: request.taskId,
          backend: request.backend,
          externalId: request.externalId,
          actorId: request.actorId,
        };
        if (!byTask && !byExternal) links.push(link);
        const result = { created: !byTask && !byExternal, link };
        receipts.set(request.idempotencyKey, result);
        return result;
      },
    },
    command(command, expectedVersion) {
      const task = taskMap.get(command.taskId);
      assert.equal(expectedVersion, task.version);
      commands.push(command);
      if (command.type === 'StartTask') task.state = 'in_progress';
      else if (command.type === 'SubmitForReview') task.state = 'review';
      else if (command.type === 'AcceptTask') task.state = 'done';
      else throw new Error(`unsupported fake command: ${command.type}`);
      task.version += 1;
      return { task: { ...task } };
    },
  };
  return { core, tasks: taskMap, links, commands };
}

function delivery(taskId = 'task-1', version = 1) {
  return {
    projection: TASK_V2_PROJECTION,
    eventId: `event-${taskId}-${version}`,
    event: { taskId },
  };
}

test('maps owner/acceptor followers and Agent or human assignees without changing Core roles', () => {
  const mapper = createTaskV2MemberMapper({ appId: APP_ID });
  assert.deepEqual(mapper.map(coreTask()), [
    { id: 'ou_owner', type: 'user', role: 'follower' },
    { id: 'ou_acceptor', type: 'user', role: 'follower' },
    { id: APP_ID, type: 'app', role: 'assignee' },
  ]);
  assert.deepEqual(mapper.map(coreTask({
    acceptorId: 'ou_owner',
    assigneeId: 'ou_executor',
  })), [
    { id: 'ou_owner', type: 'user', role: 'follower' },
    { id: 'ou_executor', type: 'user', role: 'assignee' },
  ]);
  assert.throws(
    () => mapper.map(coreTask({ assigneeId: 'agent:unmapped' })),
    /no Feishu App mapping/,
  );
});

test('creates one native Task, returns its URL, preserves the Card link, and updates by GUID', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: 'feishu',
    externalId: 'om_card_1', idempotencyKey: 'card-link',
  });
  const calls = [];
  const gateway = {
    async findTasksByCoreTaskId() { return []; },
    async createTask(request) {
      calls.push({ operation: 'create', request });
      return { guid: 'guid-1', url: 'https://applink.feishu.cn/task/guid-1' };
    },
    async updateTask(request) {
      calls.push({ operation: 'update', request });
      return { guid: request.taskGuid, url: 'https://applink.feishu.cn/task/guid-1' };
    },
  };
  const projection = createTaskV2Projection({
    core: harness.core,
    gateway,
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID }),
  });

  assert.deepEqual(await projection.publishBatch({ deliveries: [delivery()] }), [{
    taskId: 'task-1',
    taskGuid: 'guid-1',
    url: 'https://applink.feishu.cn/task/guid-1',
    created: true,
    recovered: false,
  }]);
  assert.deepEqual(harness.links.map(link => [link.backend, link.externalId]), [
    ['feishu', 'om_card_1'],
    [TASK_V2_LINK_BACKEND, 'guid-1'],
  ]);
  assert.equal(calls[0].request.task.dueAt, DUE_AT);
  assert.equal(calls[0].request.members[0].role, 'follower');
  assert.match(calls[0].request.clientToken, /^zt2_[a-f0-9]{40}$/);

  harness.tasks.set('task-1', coreTask({ state: 'review', version: 3 }));
  await projection.publishBatch({ deliveries: [delivery('task-1', 3)] });
  assert.deepEqual(calls.map(call => call.operation), ['create', 'update']);
  assert.equal(calls[1].request.taskGuid, 'guid-1');
});

test('recovers a remote create after the short client_token window and rejects duplicate GUIDs', async () => {
  const recoveredHarness = fakeCore();
  const recovered = createTaskV2Projection({
    core: recoveredHarness.core,
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID }),
    gateway: {
      async findTasksByCoreTaskId() {
        return [{ guid: 'guid-orphan', url: 'https://task/guid-orphan' }];
      },
      async createTask() { throw new Error('must not create'); },
      async updateTask({ taskGuid }) {
        return { guid: taskGuid, url: 'https://task/guid-orphan' };
      },
    },
  });
  const [receipt] = await recovered.publishBatch({ deliveries: [delivery()] });
  assert.equal(receipt.recovered, true);
  assert.equal(recoveredHarness.links[0].externalId, 'guid-orphan');

  const duplicate = createTaskV2Projection({
    core: fakeCore().core,
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID }),
    gateway: {
      async findTasksByCoreTaskId() {
        return [
          { guid: 'guid-a', url: 'https://task/guid-a' },
          { guid: 'guid-b', url: 'https://task/guid-b' },
        ];
      },
      async createTask() { throw new Error('must not create'); },
      async updateTask() { throw new Error('must not update'); },
    },
  });
  await assert.rejects(
    duplicate.publishBatch({ deliveries: [delivery()] }),
    error => error?.retryable === false && /duplicate Task v2 GUIDs/.test(error.message),
  );
});

test('platform failure leaves Core intact for retry and a GUID conflict is permanently dead-letterable', async () => {
  const retryHarness = fakeCore();
  const outage = new Error('Feishu unavailable');
  outage.retryable = true;
  const projection = createTaskV2Projection({
    core: retryHarness.core,
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID }),
    gateway: {
      async findTasksByCoreTaskId() { return []; },
      async createTask() { throw outage; },
      async updateTask() { throw new Error('must not update'); },
    },
  });
  await assert.rejects(projection.publishBatch({ deliveries: [delivery()] }), outage);
  assert.equal(retryHarness.tasks.get('task-1').state, 'ready');
  assert.equal(retryHarness.links.length, 0);

  const conflictHarness = fakeCore([coreTask(), coreTask({ id: 'task-2' })]);
  conflictHarness.core.externalLinks.link({
    taskId: 'task-2', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-shared', idempotencyKey: 'preexisting-guid',
  });
  const conflict = createTaskV2Projection({
    core: conflictHarness.core,
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID }),
    gateway: {
      async findTasksByCoreTaskId() { return []; },
      async createTask() { return { guid: 'guid-shared', url: 'https://task/guid-shared' }; },
      async updateTask() { throw new Error('must not update'); },
    },
  });
  await assert.rejects(
    conflict.publishBatch({ deliveries: [delivery()] }),
    error => error?.retryable === false && /cannot be linked/.test(error.message),
  );
});

test('native completion submits for review exactly once and never accepts for the Acceptor', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-1', idempotencyKey: 'link-status',
  });
  const handler = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '1787900000000' }; } },
  });
  const event = { event_id: 'evt-complete-1', task_id: 'guid-1', app_id: APP_ID };
  const result = await handler.handle(event);
  assert.equal(result.status, 'submitted_for_review');
  assert.deepEqual(harness.commands.map(command => command.type), [
    'StartTask',
    'SubmitForReview',
  ]);
  assert.equal(harness.tasks.get('task-1').state, 'review');
  assert.equal(harness.commands.some(command => command.type === 'AcceptTask'), false);
  assert.equal((await handler.handle(event)).status, 'already_in_review');
  assert.equal(harness.commands.length, 2);

  const uncompleted = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '0' }; } },
  });
  assert.equal((await uncompleted.handle({ ...event, event_id: 'evt-uncomplete' })).status, 'ignored_uncompleted');

  assert.equal((await handler.handle({
    header: { event_id: 'evt-envelope', app_id: APP_ID },
    event: { task_id: 'guid-1' },
  })).status, 'already_in_review');
});

test('reconciliation snapshots expose missing links, state drift, and duplicate native GUIDs', async () => {
  const harness = fakeCore([
    coreTask({ id: 'task-1', state: 'review' }),
    coreTask({ id: 'task-2', state: 'ready' }),
  ]);
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-linked', idempotencyKey: 'link-reconcile',
  });
  const snapshot = await collectTaskV2ReconciliationSnapshot({
    core: harness.core,
    gateway: {
      async findTasksByCoreTaskId(taskId) {
        if (taskId === 'task-1') {
          return [
            { guid: 'guid-linked', url: 'https://task/guid-linked', completedAt: '0' },
            { guid: 'guid-duplicate', url: 'https://task/guid-duplicate', completedAt: '0' },
          ];
        }
        return [];
      },
    },
  });
  assert.deepEqual(snapshot.expected, [
    { key: 'task-1', state: 'completed' },
    { key: 'task-2', state: 'open' },
  ]);
  assert.equal(snapshot.actual.filter(record => record.key === 'task-1').length, 2);
  assert.deepEqual(snapshot.missingLinks, [{ taskId: 'task-2' }]);
  assert.deepEqual(snapshot.linkMismatches, []);
});

function sdkTask(overrides = {}) {
  return {
    guid: 'guid-sdk',
    url: 'https://applink.feishu.cn/task/guid-sdk',
    summary: '跟进客户方案',
    description: '提交方案',
    members: [],
    completed_at: '0',
    extra: JSON.stringify({
      schema: 'zylos.task-v2-projection/v1',
      coreTaskId: 'task-1',
      coreTaskVersion: 1,
    }),
    ...overrides,
  };
}

test('SDK Adapter uses tenant Task v2 create/patch/member calls with client_token and no network', async () => {
  const calls = [];
  const response = task => ({ code: 0, data: { task } });
  const client = {
    task: { v2: { task: {
      async create(payload) {
        calls.push(['create', payload]);
        return response(sdkTask({ members: payload.data.members, due: payload.data.due }));
      },
      async get(payload) {
        calls.push(['get', payload]);
        return response(sdkTask({
          members: [{ id: 'ou_old', type: 'user', role: 'follower' }],
        }));
      },
      async patch(payload) {
        calls.push(['patch', payload]);
        return response(sdkTask({ completed_at: payload.data.task.completed_at }));
      },
      async addMembers(payload) {
        calls.push(['addMembers', payload]);
        return response(sdkTask({ members: payload.data.members }));
      },
      async removeMembers(payload) {
        calls.push(['removeMembers', payload]);
        return response(sdkTask());
      },
      async search(payload) {
        calls.push(['search', payload]);
        return { code: 0, data: { items: [{ id: 'guid-sdk' }] } };
      },
    } } },
  };
  const gateway = createSdkTaskV2Gateway({ client });
  const members = createTaskV2MemberMapper({ appId: APP_ID }).map(coreTask());
  const created = await gateway.createTask({
    task: coreTask(), members, clientToken: 'zt2_create',
  });
  assert.equal(created.url, 'https://applink.feishu.cn/task/guid-sdk');
  const createCall = calls.find(([name]) => name === 'create')[1];
  assert.equal(createCall.data.client_token, 'zt2_create');
  assert.equal(createCall.data.due.timestamp, String(Date.parse(DUE_AT)));
  assert.deepEqual(createCall.data.members, members);
  assert.match(createCall.data.description, /Zylos Core Task: task-1/);

  await gateway.updateTask({
    taskGuid: 'guid-sdk',
    task: coreTask({ state: 'review', version: 4, updatedAt: '2026-08-26T10:00:00.000Z' }),
    members,
    clientToken: 'zt2_update',
  });
  assert.deepEqual(calls.filter(([name]) => (
    ['patch', 'addMembers', 'removeMembers'].includes(name)
  )).map(([name]) => name), ['patch', 'addMembers', 'removeMembers']);
  assert.equal(
    calls.find(([name]) => name === 'patch')[1].data.task.completed_at,
    String(Date.parse('2026-08-26T10:00:00.000Z')),
  );
  assert.equal(calls.find(([name]) => name === 'addMembers')[1].data.client_token, 'zt2_update:add');

  const found = await gateway.findTasksByCoreTaskId('task-1');
  assert.equal(found.length, 1);
  assert.equal(found[0].guid, 'guid-sdk');
});
