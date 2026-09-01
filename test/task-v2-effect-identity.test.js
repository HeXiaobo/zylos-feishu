import assert from 'node:assert/strict';
import test from 'node:test';

import { createSdkTaskV2Gateway } from '../src/lib/task-v2-sdk-adapter.js';

function nativeTask(extra, version = 3) {
  return {
    guid: 'guid-effect-1',
    url: 'https://example.invalid/guid-effect-1',
    summary: 'Effect identity',
    description: 'Effect identity\n\nZylos Core Task: task-1',
    completed_at: '0',
    members: [],
    reminders: [],
    extra,
    coreTaskVersion: version,
  };
}

test('Task v2 SDK marker persists exact effect identity for crash reconciliation', async () => {
  let persisted;
  const taskApi = {
    async create({ data }) {
      persisted = data;
      return { code: 0, data: { task: nativeTask(data.extra) } };
    },
    async patch() { throw new Error('not used'); },
    async get() { return { code: 0, data: { task: nativeTask(persisted.extra) } }; },
    async addMembers() { throw new Error('not used'); },
    async removeMembers() { throw new Error('not used'); },
    async addReminders() { throw new Error('not used'); },
    async removeReminders() { throw new Error('not used'); },
    async list() { return { code: 0, data: { items: [], has_more: false } }; },
  };
  const gateway = createSdkTaskV2Gateway({ client: { task: { v2: { task: taskApi } } } });
  const identity = {
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    effectId: 'effect-task-1-v3',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    coreTaskId: 'task-1',
    coreTaskVersion: 3,
  };
  const result = await gateway.createTask({
    task: {
      id: 'task-1', version: 3, title: 'Effect identity', state: 'in_progress',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    members: [],
    clientToken: 'zte_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    effectIdentity: identity,
  });
  assert.deepEqual(JSON.parse(persisted.extra), {
    schema: 'zylos.task-v2-projection/v1',
    coreTaskId: 'task-1',
    coreTaskVersion: 3,
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    effectId: 'effect-task-1-v3',
    payloadHash: identity.payloadHash,
  });
  assert.equal(result.effectId, identity.effectId);
  assert.equal(result.payloadHash, identity.payloadHash);
  assert.equal(result.tenantRef, identity.tenantRef);
  assert.equal(result.accountRef, identity.accountRef);
  await assert.rejects(
    () => gateway.updateTask({
      taskGuid: 'guid-effect-1',
      task: {
        id: 'task-1', version: 4, title: 'Legacy writer must stop', state: 'in_progress',
        updatedAt: '2026-09-01T00:01:00.000Z',
      },
      members: [],
      clientToken: 'zt2_legacy_writer_without_effect_identity',
    }),
    error => error?.retryable === false && /effect identity/i.test(error.message),
  );
});
