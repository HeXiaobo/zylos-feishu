import assert from 'node:assert/strict';
import test from 'node:test';

import { createSdkNativeTaskGateReader } from '../src/lib/native-task-closure-gate-remote.js';

test('SDK gate reader performs only paginated Task and comment reads through its public Adapter', async () => {
  const calls = [];
  const reader = createSdkNativeTaskGateReader({
    client: {
      task: {
        v2: {
          task: {
            async get(request) {
              calls.push({ operation: 'task.get', request });
              return {
                code: 0,
                data: {
                  task: {
                    guid: 'task-guid-1',
                    summary: 'Closure canary',
                    extra: JSON.stringify({
                      schema: 'zylos.task-v2-projection/v1',
                      coreTaskId: 'core-task-1',
                    }),
                  },
                },
              };
            },
            async list(request) {
              calls.push({ operation: 'task.list', request });
              if (!request.params.page_token) {
                return {
                  code: 0,
                  data: {
                    items: [{ guid: 'task-guid-1', summary: 'Closure canary' }],
                    has_more: true,
                    page_token: 'page-2',
                  },
                };
              }
              return {
                code: 0,
                data: {
                  items: [{ guid: 'task-guid-2', summary: 'Closure canary' }],
                  has_more: false,
                },
              };
            },
          },
          comment: {
            async get(request) {
              calls.push({ operation: 'comment.get', request });
              return {
                code: 0,
                data: {
                  comment: {
                    id: 'comment-1',
                    content: 'Please verify the closure.',
                    creator: { id: 'ou_owner', type: 'user' },
                    created_at: '2026-08-26T10:00:00.000Z',
                    updated_at: '2026-08-26T10:00:00.000Z',
                    resource_type: 'task',
                    resource_id: 'task-guid-1',
                  },
                },
              };
            },
            async list() { throw new Error('gate must not list comments'); },
            async create() { throw new Error('gate must not write comments'); },
          },
        },
      },
    },
  });

  assert.deepEqual(await reader.getTask({ taskGuid: 'task-guid-1' }), {
    kind: 'found',
    task: {
      guid: 'task-guid-1',
      summary: 'Closure canary',
      coreTaskId: 'core-task-1',
    },
  });
  assert.deepEqual(
    (await reader.findTasksBySummary({ summary: 'Closure canary' })).map(({ guid }) => guid),
    ['task-guid-1', 'task-guid-2'],
  );
  const comment = await reader.getComment({ commentId: 'comment-1' });
  assert.equal(comment.kind, 'found');
  assert.equal(comment.comment.resourceId, 'task-guid-1');
  assert.deepEqual(calls.map(({ operation }) => operation), [
    'task.get',
    'task.list',
    'task.list',
    'comment.get',
  ]);
});
