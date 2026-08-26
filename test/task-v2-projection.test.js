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
import {
  createTaskV2StatusEventHandler,
  createTaskV2StatusEventIngestor,
  createTaskV2StatusReconciler,
} from '../src/lib/task-v2-status-event.js';

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
      const tasks = [...taskMap.values()];
      const cursorIndex = query.cursor
        ? tasks.findIndex(task => (
          task.updatedAt === query.cursor.updatedAt && task.id === query.cursor.taskId
        ))
        : -1;
      return tasks.slice(cursorIndex + 1, cursorIndex + 1 + (query.limit ?? 50));
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

function mapCompletedExternalTask(externalEvent) {
  return {
    command: {
      type: 'SubmitForReview',
      taskId: externalEvent.taskId,
      actorId: externalEvent.actorId,
      idempotencyKey: `mapped:${externalEvent.eventId}`,
    },
    expectedVersion: externalEvent.expectedVersion,
  };
}

test('maps owner/acceptor followers and Agent or human assignees without changing Core roles', () => {
  const mapper = createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' });
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
  const crashSafeMapper = createTaskV2MemberMapper({
    appId: APP_ID,
    agentId: 'agent:yueran',
    requireGatewayAppAssignee: true,
  });
  assert.throws(
    () => crashSafeMapper.map(coreTask({ assigneeId: 'ou_executor' })),
    /requires the configured gateway Agent as assignee/,
  );
});

test('does not silently bind the universal gateway to a deployment-specific Agent', () => {
  const mapper = createTaskV2MemberMapper({ appId: APP_ID });
  assert.throws(
    () => mapper.map(coreTask()),
    /no Feishu App mapping: agent:yueran/,
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
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }),
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
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }),
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
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }),
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
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }),
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
    memberMapper: createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }),
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
  const mappedEvents = [];
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-1', idempotencyKey: 'link-status',
  });
  const handler = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '1787900000000' }; } },
    mapExternalTaskEvent(externalEvent) {
      mappedEvents.push(externalEvent);
      return {
        command: {
          type: 'SubmitForReview',
          taskId: externalEvent.taskId,
          actorId: externalEvent.actorId,
          idempotencyKey: `core-mapped:${externalEvent.eventId}`,
        },
        expectedVersion: externalEvent.expectedVersion,
      };
    },
  });
  const event = {
    header: { event_id: 'evt-complete-1', app_id: APP_ID },
    event: { task_guid: 'guid-1', event_types: ['task_completed_update'] },
  };
  const result = await handler.handle(event);
  assert.equal(result.status, 'submitted_for_review');
  assert.deepEqual(harness.commands.map(command => command.type), [
    'StartTask',
    'SubmitForReview',
  ]);
  assert.deepEqual(mappedEvents, [{
    backend: TASK_V2_LINK_BACKEND,
    eventId: 'evt-complete-1',
    eventType: 'completed',
    taskId: 'task-1',
    actorId: 'agent:yueran',
    expectedVersion: 2,
  }]);
  assert.equal(harness.commands[1].idempotencyKey, 'core-mapped:evt-complete-1');
  assert.equal(harness.tasks.get('task-1').state, 'review');
  assert.equal(harness.commands.some(command => command.type === 'AcceptTask'), false);
  assert.equal((await handler.handle(event)).status, 'already_in_review');
  assert.equal(harness.commands.length, 2);

  const uncompleted = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '0' }; } },
    mapExternalTaskEvent() { throw new Error('must not map an uncompleted Task'); },
  });
  assert.equal((await uncompleted.handle({
    header: { event_id: 'evt-uncomplete', app_id: APP_ID },
    event: { task_guid: 'guid-1', event_types: ['task_completed_update'] },
  })).status, 'ignored_uncompleted');

  assert.equal((await handler.handle({
    event_id: 'evt-legacy',
    task_id: 'guid-1',
    app_id: APP_ID,
  })).status, 'already_in_review');
});

test('native completion rejects an acceptance-shaped Core mapper result', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-1', idempotencyKey: 'link-invalid-mapper',
  });
  const handler = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '1787900000000' }; } },
    mapExternalTaskEvent(externalEvent) {
      return {
        command: {
          type: 'AcceptTask',
          taskId: externalEvent.taskId,
          actorId: 'ou_acceptor',
          idempotencyKey: 'must-not-run',
        },
        expectedVersion: externalEvent.expectedVersion,
      };
    },
  });

  await assert.rejects(
    handler.handle({
      header: { event_id: 'evt-invalid-mapper', app_id: APP_ID },
      event: { task_guid: 'guid-1', event_types: ['task_completed_update'] },
    }),
    error => error?.retryable === false && /only SubmitForReview/.test(error.message),
  );
  assert.deepEqual(harness.commands, []);
  assert.equal(harness.tasks.get('task-1').state, 'ready');
});

test('native completion rejects mapper identity or version drift before mutating Core', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-1', idempotencyKey: 'link-drifted-mapper',
  });
  const handler = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '1787900000000' }; } },
    mapExternalTaskEvent() {
      return {
        command: {
          type: 'SubmitForReview',
          taskId: 'task-other',
          actorId: 'ou_attacker',
          idempotencyKey: 'drifted-mapper',
        },
        expectedVersion: 999,
      };
    },
  });

  await assert.rejects(
    handler.handle({
      header: { event_id: 'evt-drifted-mapper', app_id: APP_ID },
      event: { task_guid: 'guid-1', event_types: ['task_completed_update'] },
    }),
    error => error?.retryable === false && /preserve task identity, actor, and version/.test(
      error.message,
    ),
  );
  assert.deepEqual(harness.commands, []);
  assert.equal(harness.tasks.get('task-1').state, 'ready');
});

test('native non-completion commits signal reconciliation without mutating Core', async () => {
  const harness = fakeCore();
  const handler = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { throw new Error('must not read completion state'); } },
    mapExternalTaskEvent() { throw new Error('must not map a non-completion event'); },
  });

  assert.deepEqual(await handler.handle({
    header: { event_id: 'evt-summary', app_id: APP_ID },
    event: {
      task_guid: 'guid-1',
      event_types: ['task_summary_update'],
    },
  }), {
    status: 'reconciliation_required',
    taskGuid: 'guid-1',
    eventTypes: ['task_summary_update'],
  });
  assert.deepEqual(harness.commands, []);
});

test('status reconciliation fails closed without one durable projection receipt', async () => {
  const reconciler = createTaskV2StatusReconciler({
    appId: APP_ID,
    core: {
      externalLinks: {
        query() { return { taskId: 'task-1', externalId: 'guid-1' }; },
      },
    },
    projection: { async publishBatch() { return []; } },
  });

  await assert.rejects(
    reconciler.handle({
      event_id: 'evt-summary',
      task_id: 'guid-1',
      app_id: APP_ID,
      event_types: ['task_summary_update'],
    }),
    /exactly one receipt/,
  );
});

test('mixed native commits submit only completion and preserve a reconciliation signal', async () => {
  const harness = fakeCore();
  harness.core.externalLinks.link({
    taskId: 'task-1', actorId: 'ou_owner', backend: TASK_V2_LINK_BACKEND,
    externalId: 'guid-1', idempotencyKey: 'link-mixed-status',
  });
  const handler = createTaskV2StatusEventHandler({
    core: harness.core,
    appId: APP_ID,
    gateway: { async getTask() { return { completedAt: '1787900000000' }; } },
    mapExternalTaskEvent: mapCompletedExternalTask,
  });

  const result = await handler.handle({
    header: { event_id: 'evt-complete-summary', app_id: APP_ID },
    event: {
      task_guid: 'guid-1',
      event_types: ['task_completed_update', 'task_summary_update'],
    },
  });

  assert.equal(result.status, 'submitted_for_review');
  assert.deepEqual(result.reconciliationEventTypes, ['task_summary_update']);
  assert.deepEqual(harness.commands.map(command => command.type), [
    'StartTask',
    'SubmitForReview',
  ]);
});

test('status event callback authenticates and durably enqueues without opening Core', () => {
  const events = [];
  const ingestor = createTaskV2StatusEventIngestor({
    appId: APP_ID,
    inbox: {
      enqueue(event) {
        events.push(event);
        return { created: true, event };
      },
    },
  });

  assert.deepEqual(ingestor.handle({
    header: { event_id: 'evt-queued', app_id: APP_ID },
    event: { task_id: 'guid-queued' },
  }), {
    status: 'queued',
    created: true,
    eventId: 'evt-queued',
    taskGuid: 'guid-queued',
  });
  assert.deepEqual(events, [{
    event_id: 'evt-queued', task_id: 'guid-queued', app_id: APP_ID,
  }]);
  assert.throws(
    () => ingestor.handle({ event_id: 'evt-other', task_id: 'guid-queued', app_id: 'cli_other' }),
    /another App/,
  );
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

test('reconciliation walks every bounded Core page instead of silently truncating at 100 tasks', async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => coreTask({
    id: `task-${String(index + 1).padStart(3, '0')}`,
    updatedAt: '2026-08-25T10:00:00.000Z',
  }));
  const harness = fakeCore(tasks);

  const snapshot = await collectTaskV2ReconciliationSnapshot({
    core: harness.core,
    gateway: { async findTasksByCoreTaskId() { return []; } },
  });

  assert.equal(snapshot.expected.length, 101);
  assert.equal(snapshot.missingLinks.length, 101);
  assert.equal(snapshot.expected.at(-1).key, 'task-101');
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
      async list(payload) {
        calls.push(['list', payload]);
        return { code: 0, data: { items: [sdkTask()] } };
      },
    } } },
  };
  const gateway = createSdkTaskV2Gateway({ client });
  const members = createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }).map(coreTask());
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
  assert.equal(calls.find(([name]) => name === 'list')[1].params.type, 'my_tasks');
});

test('SDK Adapter does not complete an already-completed native Task again on Core acceptance', async () => {
  const calls = [];
  const task = coreTask({
    state: 'done',
    version: 4,
    updatedAt: '2026-08-26T11:00:00.000Z',
  });
  const members = createTaskV2MemberMapper({ appId: APP_ID, agentId: 'agent:yueran' }).map(task);
  const current = sdkTask({
    summary: task.title,
    description: `${task.description}\n\nZylos Core Task: ${task.id}`,
    due: { timestamp: String(Date.parse(DUE_AT)), is_all_day: false },
    completed_at: '1787900000000',
    members,
    extra: JSON.stringify({
      schema: 'zylos.task-v2-projection/v1',
      coreTaskId: task.id,
      coreTaskVersion: 3,
    }),
  });
  const response = value => ({ code: 0, data: { task: value } });
  const client = {
    task: { v2: { task: {
      async create() { throw new Error('unexpected create'); },
      async get() { return response(current); },
      async patch(payload) {
        calls.push(payload);
        if (payload.data.update_fields.includes('completed_at')) {
          throw new Error('Feishu rejects completing an already-completed task');
        }
        return response({ ...current, extra: payload.data.task.extra });
      },
      async addMembers() { throw new Error('unexpected addMembers'); },
      async removeMembers() { throw new Error('unexpected removeMembers'); },
      async list() { throw new Error('unexpected list'); },
    } } },
  };

  const updated = await createSdkTaskV2Gateway({ client }).updateTask({
    taskGuid: current.guid,
    task,
    members,
    clientToken: 'zt2_accept',
  });

  assert.equal(updated.guid, current.guid);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].data.update_fields, ['extra']);
});

test('SDK Adapter lists every bot-visible Task page before deciding create-after-crash recovery is empty', async () => {
  const lists = [];
  const response = task => ({ code: 0, data: { task } });
  const client = {
    task: { v2: { task: {
      async create() { throw new Error('unexpected create'); },
      async patch() { throw new Error('unexpected patch'); },
      async addMembers() { throw new Error('unexpected addMembers'); },
      async removeMembers() { throw new Error('unexpected removeMembers'); },
      async list(payload) {
        lists.push(payload);
        if (!payload.params.page_token) {
          return {
            code: 0,
            data: {
              items: [sdkTask({
                guid: 'guid-other',
                extra: JSON.stringify({
                  schema: 'zylos.task-v2-projection/v1',
                  coreTaskId: 'task-other',
                  coreTaskVersion: 1,
                }),
              })],
              has_more: true,
              page_token: 'page-2',
            },
          };
        }
        return {
          code: 0,
          data: { items: [sdkTask({ guid: 'guid-target' })], has_more: false },
        };
      },
      async get({ path }) {
        const coreTaskId = path.task_guid === 'guid-target' ? 'task-1' : 'task-other';
        return response(sdkTask({
          guid: path.task_guid,
          extra: JSON.stringify({
            schema: 'zylos.task-v2-projection/v1',
            coreTaskId,
            coreTaskVersion: 1,
          }),
        }));
      },
    } } },
  };

  const found = await createSdkTaskV2Gateway({ client }).findTasksByCoreTaskId('task-1');

  assert.deepEqual(found.map(task => task.guid), ['guid-target']);
  assert.deepEqual(lists.map(call => call.params.page_token ?? null), [null, 'page-2']);
  assert.equal(lists.every(call => call.params.type === 'my_tasks'), true);
  assert.equal(lists.length, 2);
});
