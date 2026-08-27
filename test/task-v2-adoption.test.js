import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTaskV2LegacyAdoption,
  TaskV2AdoptionError,
  TASK_V2_ADOPTION_MARKER_SCHEMA,
} from '../src/lib/task-v2-legacy-adoption.js';

const APP_ID = 'cli_ss_legacy';
const TASK_GUID = '30190971-f8a7-4fe0-8351-418529bce8ad';
const CORE_TASK_ID = 'core-imported-1';

function remoteTask(overrides = {}) {
  return {
    guid: TASK_GUID,
    summary: 'legacy task',
    description: '原始正文',
    due: { timestamp: '1788000000000', is_all_day: false },
    status: 'todo',
    creator: { id: APP_ID, type: 'app' },
    members: [
      { id: APP_ID, type: 'app', role: 'assignee' },
      { id: 'ou_owner', type: 'user', role: 'follower' },
    ],
    extra: null,
    ...overrides,
  };
}

function harness(initial = remoteTask()) {
  let current = structuredClone(initial);
  const calls = [];
  const adapter = {
    async getTask(taskGuid) {
      calls.push({ operation: 'get', taskGuid });
      return structuredClone(current);
    },
    async patchTask(request) {
      calls.push({ operation: 'patch', request });
      current = {
        ...current,
        ...(Object.hasOwn(request, 'description') ? { description: request.description } : {}),
        ...(Object.hasOwn(request, 'extra') ? { extra: request.extra } : {}),
      };
      return structuredClone(current);
    },
  };
  return {
    adapter,
    calls,
    current: () => structuredClone(current),
    setCurrent(next) {
      current = structuredClone(next);
    },
  };
}

test('adopts a verified legacy Task by appending one canonical marker only', async () => {
  const h = harness();
  const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });

  const result = await adoption.adoptTaskMarker({
    taskGuid: TASK_GUID,
    coreTaskId: CORE_TASK_ID,
    coreTaskVersion: 1,
  });

  const marker = JSON.stringify({
    schema: TASK_V2_ADOPTION_MARKER_SCHEMA,
    coreTaskId: CORE_TASK_ID,
    coreTaskVersion: 1,
  });
  assert.deepEqual(result, {
    status: 'adopted',
    taskGuid: TASK_GUID,
    coreTaskId: CORE_TASK_ID,
    changedFields: ['description', 'extra'],
    recovered: false,
  });
  assert.deepEqual(h.calls.map(call => call.operation), ['get', 'patch', 'get']);
  assert.deepEqual(h.calls[1].request, {
    taskGuid: TASK_GUID,
    updateFields: ['description', 'extra'],
    description: `原始正文\n\nZylos Core Task: ${CORE_TASK_ID}`,
    extra: marker,
  });
  assert.deepEqual(h.current(), {
    ...remoteTask(),
    description: `原始正文\n\nZylos Core Task: ${CORE_TASK_ID}`,
    extra: marker,
  });
});

test('holds before patch when the GUID, creator, App assignee, or status is not exact', async () => {
  const cases = [
    ['GUID_MISMATCH', { guid: 'another-guid' }],
    ['CREATOR_MISMATCH', { creator: { id: 'ou_human', type: 'user' } }],
    ['ASSIGNEE_MISMATCH', {
      members: [{ id: 'ou_owner', type: 'user', role: 'follower' }],
    }],
    ['STATUS_NOT_TODO', { status: 'done' }],
  ];
  for (const [code, overrides] of cases) {
    const h = harness(remoteTask(overrides));
    const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });
    await assert.rejects(
      adoption.adoptTaskMarker({ taskGuid: TASK_GUID, coreTaskId: CORE_TASK_ID }),
      error => error instanceof TaskV2AdoptionError && error.code === code && error.hold === true,
    );
    assert.deepEqual(h.calls.map(call => call.operation), ['get']);
  }
});

test('holds unknown extra and conflicting or duplicate description markers without patching', async () => {
  const cases = [
    ['unknown extra', { extra: 'legacy metadata' }, 'EXTRA_MARKER_CONFLICT'],
    ['conflicting extra', {
      extra: JSON.stringify({
        schema: TASK_V2_ADOPTION_MARKER_SCHEMA,
        coreTaskId: 'core-other',
        coreTaskVersion: 1,
      }),
    }, 'EXTRA_MARKER_CONFLICT'],
    ['conflicting description marker', {
      description: '原始正文\n\nZylos Core Task: core-other',
    }, 'DESCRIPTION_MARKER_CONFLICT'],
    ['duplicate description marker', {
      description: '原始正文\n\nZylos Core Task: core-imported-1\n\nZylos Core Task: core-imported-1',
    }, 'DESCRIPTION_MARKER_CONFLICT'],
  ];
  for (const [, overrides, code] of cases) {
    const h = harness(remoteTask(overrides));
    const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });
    await assert.rejects(
      adoption.adoptTaskMarker({ taskGuid: TASK_GUID, coreTaskId: CORE_TASK_ID }),
      error => error instanceof TaskV2AdoptionError && error.code === code && error.hold === true,
    );
    assert.deepEqual(h.calls.map(call => call.operation), ['get']);
  }
});

test('returns NOOP for a correct marker and patches only the missing half of a partial marker', async () => {
  const marker = JSON.stringify({
    schema: TASK_V2_ADOPTION_MARKER_SCHEMA,
    coreTaskId: CORE_TASK_ID,
    coreTaskVersion: 1,
  });
  const description = `原始正文\n\nZylos Core Task: ${CORE_TASK_ID}`;
  const correct = harness(remoteTask({ description, extra: marker }));
  const adoption = createTaskV2LegacyAdoption({ adapter: correct.adapter, appId: APP_ID });
  assert.deepEqual(
    await adoption.adoptTaskMarker({ taskGuid: TASK_GUID, coreTaskId: CORE_TASK_ID }),
    {
      status: 'noop',
      taskGuid: TASK_GUID,
      coreTaskId: CORE_TASK_ID,
      changedFields: [],
      recovered: false,
    },
  );
  assert.deepEqual(correct.calls.map(call => call.operation), ['get']);

  const missingExtra = harness(remoteTask({ description, extra: null }));
  const missingExtraAdoption = createTaskV2LegacyAdoption({
    adapter: missingExtra.adapter,
    appId: APP_ID,
  });
  await missingExtraAdoption.adoptTaskMarker({
    taskGuid: TASK_GUID,
    coreTaskId: CORE_TASK_ID,
  });
  assert.deepEqual(missingExtra.calls[1].request, {
    taskGuid: TASK_GUID,
    updateFields: ['extra'],
    extra: marker,
  });
  assert.equal(missingExtra.current().description, description);

  const missingDescription = harness(remoteTask({ description: '原始正文', extra: marker }));
  const missingDescriptionAdoption = createTaskV2LegacyAdoption({
    adapter: missingDescription.adapter,
    appId: APP_ID,
  });
  await missingDescriptionAdoption.adoptTaskMarker({
    taskGuid: TASK_GUID,
    coreTaskId: CORE_TASK_ID,
  });
  assert.deepEqual(missingDescription.calls[1].request, {
    taskGuid: TASK_GUID,
    updateFields: ['description'],
    description,
  });
  assert.equal(missingDescription.current().extra, marker);
});

test('post-get proves summary, due, members, status, and original description were preserved', async () => {
  for (const field of ['summary', 'due', 'members', 'status', 'description']) {
    const h = harness();
    const originalPatch = h.adapter.patchTask;
    h.adapter.patchTask = async (request) => {
      await originalPatch(request);
      const changed = h.current();
      if (field === 'summary') changed.summary = 'changed by another writer';
      if (field === 'due') changed.due = { timestamp: '1789000000000', is_all_day: false };
      if (field === 'members') changed.members = [{ id: APP_ID, type: 'app', role: 'assignee' }];
      if (field === 'status') changed.status = 'done';
      if (field === 'description') changed.description = 'concurrent replacement';
      h.setCurrent(changed);
    };
    const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });
    await assert.rejects(
      adoption.adoptTaskMarker({ taskGuid: TASK_GUID, coreTaskId: CORE_TASK_ID }),
      error => error instanceof TaskV2AdoptionError
        && error.code === 'POSTCHECK_MISMATCH'
        && error.hold === true
        && error.message.includes(field),
    );
    assert.deepEqual(h.calls.map(call => call.operation), ['get', 'patch', 'get']);
  }
});

test('a timed-out patch is resolved by one readback and never calls createTask', async () => {
  const h = harness();
  h.adapter.createTask = async () => {
    throw new Error('createTask must not be called');
  };
  const originalPatch = h.adapter.patchTask;
  h.adapter.patchTask = async (request) => {
    await originalPatch(request);
    const error = new Error('request timed out after 30s');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });

  const result = await adoption.adoptTaskMarker({
    taskGuid: TASK_GUID,
    coreTaskId: CORE_TASK_ID,
  });

  assert.equal(result.status, 'adopted');
  assert.equal(result.recovered, true);
  assert.deepEqual(h.calls.map(call => call.operation), ['get', 'patch', 'get']);
});

test('a timed-out patch with an unconfirmed readback becomes a HOLD', async () => {
  const h = harness();
  h.adapter.patchTask = async () => {
    h.calls.push({ operation: 'patch' });
    const error = new Error('socket timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });

  await assert.rejects(
    adoption.adoptTaskMarker({ taskGuid: TASK_GUID, coreTaskId: CORE_TASK_ID }),
    error => error instanceof TaskV2AdoptionError
      && error.code === 'POSTCHECK_MISMATCH'
      && error.hold === true,
  );
  assert.deepEqual(h.calls.map(call => call.operation), ['get', 'patch', 'get']);
});

test('a timed-out patch whose readback fails remains a HOLD without retrying the patch', async () => {
  const h = harness();
  let reads = 0;
  h.adapter.getTask = async (taskGuid) => {
    h.calls.push({ operation: 'get', taskGuid });
    reads += 1;
    if (reads === 2) throw new Error('readback unavailable');
    return h.current();
  };
  h.adapter.patchTask = async () => {
    h.calls.push({ operation: 'patch' });
    const error = new Error('timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };
  const adoption = createTaskV2LegacyAdoption({ adapter: h.adapter, appId: APP_ID });

  await assert.rejects(
    adoption.adoptTaskMarker({ taskGuid: TASK_GUID, coreTaskId: CORE_TASK_ID }),
    error => error instanceof TaskV2AdoptionError
      && error.code === 'PATCH_TIMEOUT_READBACK_FAILED'
      && error.hold === true,
  );
  assert.deepEqual(h.calls.map(call => call.operation), ['get', 'patch', 'get']);
});
