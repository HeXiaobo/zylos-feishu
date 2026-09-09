import assert from 'node:assert/strict';
import os from 'node:os';

import test from 'node:test';

import {
  createNativeTaskCanarySender,
  normalizeNativeTaskCanarySenderReceipt,
  NATIVE_TASK_CANARY_SENDER_SCHEMA,
} from '../src/lib/native-task-canary-sender.js';

const APP_ID = 'cli_task_gateway';
const TASK_GUID = 'task-guid-1';
const COMMENT_ID = 'comment-human-1';
const HOSTNAME = os.hostname();

function clockFrom(values) {
  let index = 0;
  return () => values[index++];
}

function receipt(overrides = {}) {
  return {
    schema: NATIVE_TASK_CANARY_SENDER_SCHEMA,
    hostname: HOSTNAME,
    appId: APP_ID,
    taskGuid: TASK_GUID,
    commentId: COMMENT_ID,
    requestStartedAt: '2026-08-26T10:00:00.000Z',
    requestFinishedAt: '2026-08-26T10:00:00.050Z',
    dryRun: {
      ok: true,
      identity: 'user',
      context: { appId: APP_ID, userOpenId: 'ou_user-1' },
      request: {
        method: 'POST',
        url: '/open-apis/task/v2/comments',
        resourceType: 'task',
        taskGuid: TASK_GUID,
      },
    },
    response: {
      ok: true,
      identity: 'user',
      data: { id: COMMENT_ID },
    },
    responseBinding: {
      appId: APP_ID,
      taskGuid: TASK_GUID,
      commentId: COMMENT_ID,
    },
    ...overrides,
  };
}

test('sender captures local request bounds around the exact platform response binding', async () => {
  const calls = [];
  const sender = createNativeTaskCanarySender({
    appId: APP_ID,
    clock: clockFrom([
      '2026-08-26T10:00:00.000Z',
      '2026-08-26T10:00:00.050Z',
    ]),
    async dryRun() {
      return receipt().dryRun;
    },
    async sendComment(input) {
      calls.push(input);
      return { ok: true, identity: 'user', data: { id: COMMENT_ID } };
    },
  });

  const result = await sender.send({ taskGuid: TASK_GUID, content: 'Please close this canary.' });

  assert.deepEqual(calls, [{ taskGuid: TASK_GUID, content: 'Please close this canary.' }]);
  assert.deepEqual(result, receipt());
});

test('sender rejects a platform response that is bound to another Task or App', async () => {
  const sender = createNativeTaskCanarySender({
    appId: APP_ID,
    clock: clockFrom([
      '2026-08-26T10:00:00.000Z',
      '2026-08-26T10:00:00.050Z',
    ]),
    async dryRun() {
      return receipt().dryRun;
    },
    async sendComment() {
      return { ok: true, identity: 'bot', data: { id: COMMENT_ID } };
    },
  });

  await assert.rejects(
    sender.send({ taskGuid: TASK_GUID, content: 'Please close this canary.' }),
    /response.identity must be user/,
  );
});

test('sender rejects a local clock that moves backwards across the request', async () => {
  const sender = createNativeTaskCanarySender({
    appId: APP_ID,
    clock: clockFrom([
      '2026-08-26T10:00:00.050Z',
      '2026-08-26T10:00:00.000Z',
    ]),
    async dryRun() {
      return receipt().dryRun;
    },
    async sendComment() {
      return { ok: true, identity: 'user', data: { id: COMMENT_ID } };
    },
  });

  await assert.rejects(
    sender.send({ taskGuid: TASK_GUID, content: 'Please close this canary.' }),
    /requestFinishedAt precedes requestStartedAt/,
  );
});

test('receipt validation rejects free timing fields and mismatched response identity', () => {
  assert.throws(
    () => normalizeNativeTaskCanarySenderReceipt({
      ...receipt(),
      requestStartedAt: '2026-08-26T10:00:00.000Z',
      unexpectedTimestamp: '2026-08-26T10:00:00.000Z',
    }, { appId: APP_ID, taskGuid: TASK_GUID, commentId: COMMENT_ID }),
    /contains unsupported field: unexpectedTimestamp/,
  );
  assert.throws(
    () => normalizeNativeTaskCanarySenderReceipt({
      ...receipt(),
      responseBinding: { ...receipt().responseBinding, taskGuid: 'task-guid-other' },
    }, { appId: APP_ID, taskGuid: TASK_GUID, commentId: COMMENT_ID }),
    /response taskGuid does not match the requested Task/,
  );
  assert.throws(
    () => normalizeNativeTaskCanarySenderReceipt({
      ...receipt(),
      hostname: 'another-host',
    }, { appId: APP_ID, taskGuid: TASK_GUID, commentId: COMMENT_ID }),
    /hostname does not match the gate host/,
  );
});
