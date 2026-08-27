import assert from 'node:assert/strict';
import test from 'node:test';

import { createSdkNativeTaskConservationReader } from '../src/lib/native-task-conservation-remote.js';

const APP_ID = 'cli_a9f4963828b89bdf';

test('captures every open and completed App-assigned Task page without marker filtering', async () => {
  const calls = [];
  const client = {
    task: { v2: { task: {
      async list(payload) {
        calls.push(payload.params);
        if (payload.params.completed) {
          return {
            code: 0,
            data: { has_more: false, items: [{ guid: 'done-unmarked' }] },
          };
        }
        if (!payload.params.page_token) {
          return {
            code: 0,
            data: {
              has_more: true,
              page_token: 'next',
              items: [{ guid: 'open-unmarked' }],
            },
          };
        }
        return {
          code: 0,
          data: { has_more: false, items: [{ guid: 'open-marked' }] },
        };
      },
    } } },
  };

  const inventory = await createSdkNativeTaskConservationReader({
    client,
    appId: APP_ID,
  }).capture();

  assert.deepEqual(inventory, {
    identity: { kind: 'app', appId: APP_ID },
    tasks: [
      { guid: 'open-unmarked' },
      { guid: 'open-marked' },
      { guid: 'done-unmarked' },
    ],
  });
  assert.deepEqual(calls.map(call => [call.completed, call.page_token ?? null]), [
    [false, null],
    [false, 'next'],
    [true, null],
  ]);
  assert.equal(calls.every(call => call.type === 'my_tasks'), true);
});

test('fails closed on repeated page tokens, malformed pages and aborts', async () => {
  const repeatedTokenClient = {
    task: { v2: { task: {
      async list() {
        return { code: 0, data: { has_more: true, page_token: 'same', items: [] } };
      },
    } } },
  };
  await assert.rejects(
    createSdkNativeTaskConservationReader({
      client: repeatedTokenClient, appId: APP_ID,
    }).capture(),
    /repeated a page token/,
  );

  const malformedClient = {
    task: { v2: { task: {
      async list() { return { code: 0, data: { has_more: false, items: null } }; },
    } } },
  };
  await assert.rejects(
    createSdkNativeTaskConservationReader({
      client: malformedClient, appId: APP_ID,
    }).capture(),
    /items must be an array/,
  );

  const controller = new AbortController();
  controller.abort(new Error('timeout'));
  await assert.rejects(
    createSdkNativeTaskConservationReader({
      client: repeatedTokenClient, appId: APP_ID,
    }).capture({ signal: controller.signal }),
    error => error.name === 'AbortError',
  );
});
