import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeTaskCommentIntake } from '../src/lib/task-comment-intake.js';

test('ordinary Feishu startup does not load SQLite when Task comments are disabled', async () => {
  let loads = 0;
  const runtime = await initializeTaskCommentIntake({
    enabled: false,
    appId: 'cli_app',
    dbPath: '/unused/task-comments.db',
    onError() {},
    async loadModules() {
      loads += 1;
      throw new Error('must not load native dependency');
    },
  });

  assert.equal(loads, 0);
  assert.equal(runtime.store, null);
  assert.deepEqual(runtime.eventHandlers, {});
});

test('explicit Task comment intake opens the durable store and installs its event handler', async () => {
  const store = { enqueue() {}, close() {} };
  const handler = async () => ({ code: 0 });
  const runtime = await initializeTaskCommentIntake({
    enabled: true,
    appId: 'cli_app',
    dbPath: '/runtime/task-comments.db',
    onError() {},
    async loadModules() {
      return {
        openTaskCommentStore({ dbPath }) {
          assert.equal(dbPath, '/runtime/task-comments.db');
          return store;
        },
        createTaskCommentEventHandlers({ appId, store: supplied }) {
          assert.equal(appId, 'cli_app');
          assert.equal(supplied, store);
          return { 'task.task.comment.updated_v1': handler };
        },
      };
    },
  });

  assert.equal(runtime.store, store);
  assert.equal(runtime.eventHandlers['task.task.comment.updated_v1'], handler);
});
