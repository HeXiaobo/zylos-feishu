import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createC4TaskCommentWake,
  createCoreTaskV2CommentMapping,
  createTaskCommentReplyEndpoint,
  parseTaskCommentReplyEndpoint,
  taskCommentReplyIdempotencyKey,
} from '../src/lib/task-comment-production.js';
import {
  createC4AgentNotificationSender,
  createTaskCommentProductionRuntime,
  runTaskCommentCycle,
} from '../src/lib/task-comment-worker.js';

test('task comment reply endpoint round-trips opaque Task v2 identities', () => {
  const endpoint = createTaskCommentReplyEndpoint({
    taskGuid: 'task-guid/客户 1',
    replyToCommentId: 'comment:parent/1',
  });
  assert.match(endpoint, /^task-comment\|task:[A-Za-z0-9_-]+\|comment:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseTaskCommentReplyEndpoint(endpoint), {
    taskGuid: 'task-guid/客户 1',
    replyToCommentId: 'comment:parent/1',
  });
  assert.equal(parseTaskCommentReplyEndpoint('oc_regular_chat'), null);
  assert.equal(
    taskCommentReplyIdempotencyKey({
      taskGuid: 'task-guid/客户 1',
      replyToCommentId: 'comment:parent/1',
      content: '已核对，续费日期为 9 月 30 日。',
    }),
    taskCommentReplyIdempotencyKey({
      taskGuid: 'task-guid/客户 1',
      replyToCommentId: 'comment:parent/1',
      content: '已核对，续费日期为 9 月 30 日。',
    }),
  );
});

test('Task v2 mapping resolves the Core task and wakes only a logical Agent assignee', async () => {
  const tasks = new Map([
    ['core-agent', {
      id: 'core-agent', state: 'in_progress', assigneeId: 'agent:yueran',
      updatedAt: '2026-08-25T10:00:00.000Z',
    }],
    ['core-human', {
      id: 'core-human', state: 'review', assigneeId: 'ou_executor',
      updatedAt: '2026-08-25T10:01:00.000Z',
    }],
  ]);
  const links = [
    { taskId: 'core-agent', backend: 'feishu-task-v2', externalId: 'task-guid-agent' },
    { taskId: 'core-human', backend: 'feishu-task-v2', externalId: 'task-guid-human' },
  ];
  const mapping = createCoreTaskV2CommentMapping({
    core: {
      query({ taskId }) { return tasks.get(taskId) ?? null; },
      externalLinks: {
        query({ externalId, limit }) {
          assert.ok(limit <= 100);
          return links.filter(link => externalId === undefined || link.externalId === externalId);
        },
      },
    },
  });

  assert.deepEqual(await mapping.resolve({ taskGuid: 'task-guid-agent' }), {
    taskId: 'core-agent',
    wakeTarget: { agentId: 'agent:yueran' },
  });
  assert.deepEqual(await mapping.resolve({ taskGuid: 'task-guid-human' }), {
    taskId: 'core-human',
    wakeTarget: null,
  });
  assert.deepEqual(await mapping.list({ limit: 10 }), [
    {
      taskId: 'core-agent', taskGuid: 'task-guid-agent', state: 'in_progress',
      updatedAt: '2026-08-25T10:00:00.000Z', eventCoverage: 'app',
    },
    {
      taskId: 'core-human', taskGuid: 'task-guid-human', state: 'review',
      updatedAt: '2026-08-25T10:01:00.000Z', eventCoverage: 'app',
    },
  ]);
});

test('C4 wake uses the durable key and exact Task comment reply endpoint', async () => {
  const enqueued = [];
  const wake = createC4TaskCommentWake({
    queue: {
      enqueue(request) {
        enqueued.push(request);
        return { created: true, conversation: { id: 17 } };
      },
    },
  });

  assert.deepEqual(await wake({
    taskId: 'core-task-1',
    target: { agentId: 'agent:yueran' },
    commentEventId: 'core-comment-event-1',
    commentId: 'external-comment-1',
    actorId: 'ou_owner',
    body: '请核对续费日期',
    occurredAt: '2026-08-25T10:00:00.000Z',
    replyContext: {
      channel: 'feishu-task-v2',
      appId: 'cli_app',
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-1',
    },
    idempotencyKey: 'feishu-comment-effect:1:wake',
  }), { created: true, conversation: { id: 17 } });
  assert.equal(enqueued[0].idempotencyKey, 'feishu-comment-effect:1:wake');
  assert.equal(enqueued[0].channel, 'feishu');
  assert.deepEqual(parseTaskCommentReplyEndpoint(enqueued[0].endpointId), {
    taskGuid: 'task-guid-1',
    replyToCommentId: 'comment-1',
  });
  assert.match(enqueued[0].content, /请核对续费日期/);
  assert.match(enqueued[0].content, /agent:yueran/);
});

test('Agent notifications enter C4 as idempotent no-reply system messages', async () => {
  const enqueued = [];
  const sender = createC4AgentNotificationSender({
    queue: {
      enqueue(request) {
        enqueued.push(request);
        return { created: true, conversation: { id: 18 } };
      },
    },
  });

  assert.deepEqual(await sender.send({
    agentId: 'agent:yueran',
    text: '任务已阻塞，需要处理',
    idempotencyKey: 'notification:event-1:agent:yueran',
  }), { created: true, conversation: { id: 18 } });
  assert.equal(enqueued[0].channel, 'system');
  assert.equal(enqueued[0].endpointId, null);
  assert.match(enqueued[0].content, /agent:yueran/);
});

test('production cycle drains comments, reconciles gaps, then flushes notifications', async () => {
  const order = [];
  const result = await runTaskCommentCycle({
    worker: { async processOnce() { order.push('comments'); return { processed: 2 }; } },
    reconciler: { async runOnce() { order.push('reconcile'); return { reconciled: 1 }; } },
    notifications: { async flushOnce() { order.push('notifications'); return { messagesSent: 1 }; } },
  });
  assert.deepEqual(order, ['comments', 'reconcile', 'notifications']);
  assert.deepEqual(result, {
    comments: { processed: 2 },
    reconciliation: { reconciled: 1 },
    notifications: { messagesSent: 1 },
  });
});

test('production assembly opens every required seam and an idle one-shot cycle is healthy', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-comment-production-'));
  let coreClosed = 0;
  let queueClosed = 0;
  const core = {
    query() { return null; },
    externalLinks: { query() { return []; } },
    close() { coreClosed += 1; },
  };
  const queue = {
    enqueue() { throw new Error('idle cycle must not enqueue'); },
    close() { queueClosed += 1; },
  };
  const runtime = createTaskCommentProductionRuntime({
    env: { FEISHU_APP_ID: 'cli_app' },
    dbPath: path.join(directory, 'task-comments.db'),
    client: {
      task: {
        v2: {
          comment: {
            async get() { throw new Error('idle cycle must not read'); },
            async list() { throw new Error('no mappings means no reconciliation reads'); },
            async create() { throw new Error('idle cycle must not reply'); },
          },
        },
      },
      im: { message: { async create() { throw new Error('idle cycle must not notify'); } } },
    },
    dependencies: {
      openCore() { return core; },
      openInboundQueue() { return queue; },
      createCoordinator() { return { async record() { throw new Error('idle'); } }; },
    },
  });
  try {
    assert.deepEqual(await runTaskCommentCycle(runtime), {
      comments: { claimed: 0, processed: 0, deadLettered: 0, results: [] },
      reconciliation: {
        considered: 0,
        reconciled: 0,
        skippedInterval: 0,
        skippedGrace: 0,
        enqueued: 0,
        businessDuplicates: 0,
      },
      notifications: { claimed: 0, messagesSent: 0, deadLettered: 0 },
    });
  } finally {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(coreClosed, 1);
  assert.equal(queueClosed, 1);
});
