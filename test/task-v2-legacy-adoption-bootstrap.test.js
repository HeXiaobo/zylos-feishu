import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSdkTaskV2LegacyAdoptionAdapter,
  createTaskV2LegacyAdoptionBootstrap,
  parseTaskV2LegacyAdoptionBootstrapManifest,
  TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_SCHEMA,
} from '../src/lib/task-v2-legacy-adoption-bootstrap.js';

const APP_ID = 'cli_ss_legacy';
const ENTRIES = [
  { taskGuid: 'guid-one', coreTaskId: 'ss-legacy:guid-one', coreTaskVersion: 1 },
  { taskGuid: 'guid-two', coreTaskId: 'ss-legacy:guid-two', coreTaskVersion: 1 },
];

function task(guid, overrides = {}) {
  return {
    guid,
    summary: `Task ${guid}`,
    description: '原始正文',
    due: { timestamp: '1788000000000', is_all_day: false },
    status: 'todo',
    creator: { id: APP_ID, type: 'app' },
    members: [{ id: APP_ID, type: 'app', role: 'assignee' }],
    extra: null,
    ...overrides,
  };
}

function manifest(entries = ENTRIES, overrides = {}) {
  return {
    schema: TASK_V2_LEGACY_ADOPTION_BOOTSTRAP_SCHEMA,
    appId: APP_ID,
    entries,
    ...overrides,
  };
}

function harness(initial = [task('guid-one'), task('guid-two')]) {
  const current = new Map(initial.map(value => [value.guid, structuredClone(value)]));
  const calls = [];
  const adapter = {
    async getTask(taskGuid) {
      calls.push({ operation: 'get', taskGuid });
      const value = current.get(taskGuid);
      if (!value) throw Object.assign(new Error('not found'), { code: 'TASK_NOT_FOUND' });
      return structuredClone(value);
    },
    async patchTask(request) {
      calls.push({ operation: 'patch', request });
      const value = current.get(request.taskGuid);
      if (request.updateFields.includes('description')) value.description = request.description;
      if (request.updateFields.includes('extra')) value.extra = request.extra;
      return structuredClone(value);
    },
  };
  return { adapter, calls, current };
}

test('manifest accepts only exact app id and task GUID/Core ID entries', () => {
  const parsed = parseTaskV2LegacyAdoptionBootstrapManifest(manifest());
  assert.equal(parsed.appId, APP_ID);
  assert.deepEqual(parsed.entries, ENTRIES);
  for (const value of [
    manifest([], {}),
    manifest(ENTRIES, { unexpected: true }),
    manifest([{ ...ENTRIES[0], unexpected: true }]),
    manifest([
      ENTRIES[0],
      { ...ENTRIES[1], taskGuid: ENTRIES[0].taskGuid },
    ]),
    manifest([
      ENTRIES[0],
      { ...ENTRIES[1], coreTaskId: ENTRIES[0].coreTaskId },
    ]),
    manifest(ENTRIES, { appId: 'not-an-app' }),
  ]) {
    assert.throws(
      () => parseTaskV2LegacyAdoptionBootstrapManifest(value),
      error => error.code === 'INVALID_MANIFEST',
    );
  }
});

test('default plan performs stable double reads and never patches', async () => {
  const h = harness();
  const bootstrap = createTaskV2LegacyAdoptionBootstrap({ adapter: h.adapter, appId: APP_ID });
  const report = await bootstrap.plan(manifest());

  assert.equal(report.mode, 'plan');
  assert.equal(report.status, 'PASS');
  assert.equal(report.writes, false);
  assert.equal(report.total, 2);
  assert.equal(report.succeeded, 2);
  assert.equal(report.failed, 0);
  assert.deepEqual(h.calls.map(call => call.operation), ['get', 'get', 'get', 'get']);
  assert.deepEqual(report.results.map(item => [item.status, item.changedFields]), [
    ['planned', ['description', 'extra']],
    ['planned', ['description', 'extra']],
  ]);
  assert.equal(Object.hasOwn(report.results[0].before, 'description'), false);
  assert.match(report.results[0].before.descriptionSha256, /^[0-9a-f]{64}$/);
});

test('plan detects a moving card and remains write-free', async () => {
  const h = harness();
  let reads = 0;
  const originalGet = h.adapter.getTask;
  h.adapter.getTask = async guid => {
    reads += 1;
    const value = await originalGet(guid);
    if (reads === 2) value.summary = 'concurrent change';
    return value;
  };
  const bootstrap = createTaskV2LegacyAdoptionBootstrap({ adapter: h.adapter, appId: APP_ID });
  const report = await bootstrap.plan(manifest([ENTRIES[0]]));

  assert.equal(report.status, 'HOLD');
  assert.equal(report.writes, false);
  assert.equal(report.results[0].error.code, 'REMOTE_SNAPSHOT_UNSTABLE');
  assert.equal(h.calls.some(call => call.operation === 'patch'), false);
});

test('commit requires a clean plan, then calls only adoption patch and stops on failure', async () => {
  const h = harness();
  let patches = 0;
  const originalPatch = h.adapter.patchTask;
  h.adapter.patchTask = async request => {
    patches += 1;
    if (patches === 2) throw Object.assign(new Error('remote rejected patch'), { code: 'REMOTE_REJECTED' });
    return originalPatch(request);
  };
  h.adapter.createTask = async () => { throw new Error('createTask must not be called'); };
  const bootstrap = createTaskV2LegacyAdoptionBootstrap({ adapter: h.adapter, appId: APP_ID });
  const report = await bootstrap.commit(manifest());

  assert.equal(report.mode, 'commit');
  assert.equal(report.commitAttempted, true);
  assert.equal(report.status, 'HOLD');
  assert.equal(report.writes, true);
  assert.equal(report.stopped, true);
  assert.equal(report.results[0].ok, true);
  assert.equal(report.results[0].status, 'adopted');
  assert.equal(report.results[1].ok, false);
  assert.equal(report.results[1].error.code, 'PATCH_FAILED');
  assert.equal(report.results[2], undefined);
  assert.equal(patches, 2);
  assert.equal(h.current.get('guid-one').description, '原始正文\n\nZylos Core Task: ss-legacy:guid-one');
  assert.equal(h.current.get('guid-two').extra, null);
});

test('commit preflight failure prevents every write and marks the report clearly', async () => {
  const h = harness([task('guid-one', { status: 'done' }), task('guid-two')]);
  const bootstrap = createTaskV2LegacyAdoptionBootstrap({ adapter: h.adapter, appId: APP_ID });
  const report = await bootstrap.commit(manifest());

  assert.equal(report.commitAttempted, false);
  assert.equal(report.writes, false);
  assert.equal(report.status, 'HOLD');
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].error.code, 'STATUS_NOT_TODO');
  assert.equal(h.calls.some(call => call.operation === 'patch'), false);
});

test('SDK adapter preserves raw marker fields and maps completed_at to status', async () => {
  const calls = [];
  let remote = {
    guid: 'guid-sdk',
    summary: 'SDK task',
    description: '原始正文',
    due: { timestamp: '1788000000000', is_all_day: false },
    completed_at: '0',
    creator: { id: APP_ID, type: 'app' },
    members: [{ id: APP_ID, type: 'app', role: 'assignee' }],
    extra: null,
  };
  const response = () => ({ code: 0, data: { task: structuredClone(remote) } });
  const client = {
    task: { v2: { task: {
      async get(payload) { calls.push(['get', payload]); return response(); },
      async patch(payload) {
        calls.push(['patch', payload]);
        remote = { ...remote, ...payload.data.task };
        return response();
      },
    } } },
  };
  const adapter = createSdkTaskV2LegacyAdoptionAdapter({ client });
  const before = await adapter.getTask('guid-sdk');
  assert.equal(before.status, 'todo');
  assert.equal(before.extra, null);
  await adapter.patchTask({
    taskGuid: 'guid-sdk',
    updateFields: ['description', 'extra'],
    description: '原始正文\n\nZylos Core Task: ss-legacy:guid-sdk',
    extra: '{"schema":"zylos.task-v2-projection/v1","coreTaskId":"ss-legacy:guid-sdk","coreTaskVersion":1}',
  });
  assert.deepEqual(calls.map(([operation]) => operation), ['get', 'patch']);
  assert.deepEqual(calls[1][1].data.update_fields, ['description', 'extra']);
  assert.equal(calls[1][1].data.task.description.includes('Zylos Core Task:'), true);
});

test('conservation gate is optional and called only after a complete commit', async () => {
  const h = harness([task('guid-one', {
    description: '原始正文\n\nZylos Core Task: ss-legacy:guid-one',
    extra: JSON.stringify({
      schema: 'zylos.task-v2-projection/v1',
      coreTaskId: 'ss-legacy:guid-one',
      coreTaskVersion: 1,
    }),
  }), task('guid-two', {
    description: '原始正文\n\nZylos Core Task: ss-legacy:guid-two',
    extra: JSON.stringify({
      schema: 'zylos.task-v2-projection/v1',
      coreTaskId: 'ss-legacy:guid-two',
      coreTaskVersion: 1,
    }),
  })]);
  const bootstrap = createTaskV2LegacyAdoptionBootstrap({ adapter: h.adapter, appId: APP_ID });
  let called = false;
  const report = await bootstrap.commit(manifest(), {
    conservationGate: async ({ manifest: committed }) => {
      called = true;
      assert.equal(committed.appId, APP_ID);
      return { passed: true, failureCodes: [] };
    },
  });
  assert.equal(report.status, 'PASS');
  assert.equal(report.writes, false);
  assert.equal(called, true);
  assert.deepEqual(h.calls.map(call => call.operation), [
    'get', 'get', 'get', 'get', 'get', 'get', 'get', 'get',
  ]);
});
