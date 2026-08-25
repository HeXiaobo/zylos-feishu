import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createC4TaskCommentWake,
  createCoreFirstTaskCommentReply,
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

const REAL_CORE_MODULE = process.env.COMMITMENT_CORE_CONTRACT_MODULE
  ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../zylos-core-worktrees/integration/skills/commitment-core/scripts/core.js',
  );

test('task comment reply endpoint round-trips opaque Task v2 identities', () => {
  const endpoint = createTaskCommentReplyEndpoint({
    appId: 'cli_app/客户',
    taskGuid: 'task-guid/客户 1',
    replyToCommentId: 'comment:parent/1',
  });
  assert.match(
    endpoint,
    /^task-comment\|app:[A-Za-z0-9_-]+\|task:[A-Za-z0-9_-]+\|comment:[A-Za-z0-9_-]+$/,
  );
  assert.deepEqual(parseTaskCommentReplyEndpoint(endpoint), {
    appId: 'cli_app/客户',
    taskGuid: 'task-guid/客户 1',
    replyToCommentId: 'comment:parent/1',
  });
  assert.deepEqual(parseTaskCommentReplyEndpoint(endpoint, { appId: 'cli_app/客户' }), {
    appId: 'cli_app/客户',
    taskGuid: 'task-guid/客户 1',
    replyToCommentId: 'comment:parent/1',
  });
  assert.throws(
    () => parseTaskCommentReplyEndpoint(endpoint, { appId: 'another_app' }),
    /belongs to another Feishu app/,
  );
  assert.equal(parseTaskCommentReplyEndpoint('oc_regular_chat'), null);
  assert.equal(
    taskCommentReplyIdempotencyKey({
      appId: 'cli_app/客户',
      taskGuid: 'task-guid/客户 1',
      replyToCommentId: 'comment:parent/1',
      content: '已核对，续费日期为 9 月 30 日。',
    }),
    taskCommentReplyIdempotencyKey({
      appId: 'cli_app/客户',
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
      query({ taskId }) {
        return taskId === undefined ? [...tasks.values()] : tasks.get(taskId) ?? null;
      },
      externalLinks: {
        query({ taskId, externalId, limit }) {
          if (externalId !== undefined) {
            assert.equal(limit, undefined);
            return links.find(link => link.externalId === externalId) ?? null;
          }
          if (taskId !== undefined) return links.filter(link => link.taskId === taskId);
          assert.ok(limit <= 100);
          return links;
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

test('Task v2 mapping honors the real Commitment Core ExternalLink query contract', async (context) => {
  if (!existsSync(REAL_CORE_MODULE)) {
    context.skip(`real Core contract module is unavailable: ${REAL_CORE_MODULE}`);
    return;
  }
  const { openCommitmentCore } = await import(pathToFileURL(REAL_CORE_MODULE).href);
  const core = openCommitmentCore({
    dbPath: ':memory:',
    clock: () => '2026-08-25T10:00:00.000Z',
    idGenerator: () => 'core-real-contract',
    eventIdGenerator: () => 'event-real-contract',
    externalLinkIdGenerator: () => 'link-real-contract',
  });
  try {
    core.ingest({
      idempotencyKey: 'source:real-contract',
      source: { channel: 'test', externalId: 'source-real-contract', senderId: 'ou_owner' },
      task: {
        title: 'Real Core contract',
        ownerId: 'ou_owner',
        acceptorId: 'ou_owner',
        assigneeId: 'agent:yueran',
      },
    });
    core.externalLinks.link({
      taskId: 'core-real-contract',
      actorId: 'ou_owner',
      backend: 'feishu-task-v2',
      externalId: 'task-guid-real-contract',
      idempotencyKey: 'link:real-contract',
    });

    assert.deepEqual(
      await createCoreTaskV2CommentMapping({ core }).resolve({
        appId: 'cli_app',
        taskGuid: 'task-guid-real-contract',
      }),
      {
        taskId: 'core-real-contract',
        wakeTarget: { agentId: 'agent:yueran' },
      },
    );
  } finally {
    core.close();
  }
});

test('Task v2 mapping advances across bounded Core pages instead of repeating the first links', async () => {
  const tasks = [
    { id: 'core-1', state: 'ready', assigneeId: null, updatedAt: '2026-08-25T10:03:00.000Z' },
    { id: 'core-2', state: 'ready', assigneeId: null, updatedAt: '2026-08-25T10:02:00.000Z' },
    { id: 'core-3', state: 'ready', assigneeId: null, updatedAt: '2026-08-25T10:01:00.000Z' },
  ];
  const links = new Map(tasks.map(task => [task.id, {
    taskId: task.id,
    backend: 'feishu-task-v2',
    externalId: `guid-${task.id}`,
  }]));
  const mapping = createCoreTaskV2CommentMapping({
    core: {
      query({ taskId, cursor }) {
        if (taskId) return tasks.find(task => task.id === taskId) ?? null;
        const start = cursor ? tasks.findIndex(task => task.id === cursor.taskId) + 1 : 0;
        return tasks.slice(start);
      },
      externalLinks: {
        query({ taskId }) {
          return taskId && links.has(taskId) ? [links.get(taskId)] : [];
        },
      },
    },
  });

  assert.deepEqual((await mapping.list({ limit: 2 })).map(item => item.taskId), [
    'core-1',
    'core-2',
  ]);
  assert.deepEqual((await mapping.list({ limit: 2 })).map(item => item.taskId), ['core-3']);
  assert.deepEqual((await mapping.list({ limit: 2 })).map(item => item.taskId), [
    'core-1',
    'core-2',
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
    appId: 'cli_app',
    taskGuid: 'task-guid-1',
    replyToCommentId: 'comment-1',
  });
  assert.match(enqueued[0].content, /请核对续费日期/);
  assert.match(enqueued[0].content, /agent:yueran/);
});

test('outbound Task reply records an Agent comment in Core before projecting by event ID', async () => {
  const order = [];
  const commands = [];
  const replies = [];
  const currentComments = new Map();
  const outbound = createCoreFirstTaskCommentReply({
    appId: 'cli_app',
    clock: () => '2026-08-25T10:05:00.000Z',
    taskMapping: {
      async resolve() {
        return { taskId: 'core-task-1', wakeTarget: { agentId: 'agent:yueran' } };
      },
    },
    conversation: {
      query({ taskId, commentId }) {
        return currentComments.get(`${taskId}:${commentId}`) ?? null;
      },
      record(command) {
        order.push('core');
        commands.push(command);
        const comment = {
          actorId: command.actorId,
          body: command.body,
          replyToCommentId: command.replyToCommentId,
          lastEventId: 'core-agent-comment-event-1',
        };
        const result = {
          event: { id: 'core-agent-comment-event-1' },
          comment,
        };
        currentComments.set(`${command.taskId}:${command.commentId}`, comment);
        return result;
      },
    },
    replyAdapter: {
      async reply(request) {
        order.push('feishu');
        replies.push(request);
        return { created: true, commentId: 'comment-agent-1' };
      },
    },
  });

  const request = {
    taskGuid: 'task-guid-1',
    replyToCommentId: 'comment-human-1',
    content: '续费日期已经核对完成。',
  };
  const first = await outbound.reply(request);
  const replay = await outbound.reply(request);

  assert.deepEqual(order, ['core', 'feishu', 'feishu']);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'AddComment');
  assert.equal(commands[0].taskId, 'core-task-1');
  assert.equal(commands[0].actorId, 'agent:yueran');
  assert.match(commands[0].commentId, /^agent-comment:/);
  assert.match(commands[0].replyToCommentId, /^external-comment:/);
  assert.equal(commands[0].body, request.content);
  assert.equal(commands[0].occurredAt, '2026-08-25T10:05:00.000Z');
  assert.deepEqual(replies.map(({ idempotencyKey }) => idempotencyKey), [
    'task-comment-core-event:core-agent-comment-event-1',
    'task-comment-core-event:core-agent-comment-event-1',
  ]);
  assert.equal(first.coreEventId, 'core-agent-comment-event-1');
  assert.equal(replay.coreEventId, 'core-agent-comment-event-1');
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

test('production cycle still flushes notifications when reconciliation fails unexpectedly', async () => {
  const order = [];
  const result = await runTaskCommentCycle({
    worker: { async processOnce() { order.push('comments'); return { processed: 1 }; } },
    reconciler: {
      async runOnce() {
        order.push('reconcile');
        throw new Error('reconciliation infrastructure failed');
      },
    },
    notifications: {
      async flushOnce() {
        order.push('notifications');
        return { messagesSent: 2 };
      },
    },
  });

  assert.deepEqual(order, ['comments', 'reconcile', 'notifications']);
  assert.deepEqual(result, {
    comments: { processed: 1 },
    reconciliation: { failed: true, error: 'reconciliation infrastructure failed' },
    notifications: { messagesSent: 2 },
  });
});

test('production assembly opens every required seam and an idle one-shot cycle is healthy', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-comment-production-'));
  let coreClosed = 0;
  let queueClosed = 0;
  const core = {
    query({ taskId } = {}) { return taskId === undefined ? [] : null; },
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
        failed: 0,
        failures: [],
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
