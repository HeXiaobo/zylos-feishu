import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  createTaskCommentReplyProduction,
} from '../src/lib/task-comment-reply-production.js';
import { createTaskCommentEventHandlers } from '../src/lib/task-comment-event.js';
import { createTaskCommentWorker } from '../src/lib/task-comment-runtime.js';
import { openTaskCommentStore } from '../src/lib/task-comment-store.js';

const APP_ID = 'cli_app';
const TASK_ID = 'core-task-1';
const TASK_GUID = 'task-guid-1';
const EVENT_ID = 'core-agent-comment-event-1';
const RECIPIENT_ID = 'ou_owner';
const REAL_CORE_MODULE = process.env.COMMITMENT_CORE_CONTRACT_MODULE ?? '';

function createCoreMapping() {
  const comments = new Map();
  return {
    query({ taskId }) {
      if (taskId !== TASK_ID) return null;
      return {
        id: TASK_ID,
        state: 'ready',
        assigneeId: 'agent:yueran',
        updatedAt: '2026-08-26T02:09:00.000Z',
      };
    },
    externalLinks: {
      query({ taskId, externalId }) {
        const link = {
          taskId: TASK_ID,
          backend: 'feishu-task-v2',
          externalId: TASK_GUID,
        };
        if (externalId === TASK_GUID) return link;
        if (taskId === TASK_ID) return [link];
        return externalId === undefined ? [] : null;
      },
    },
    conversation: {
      query({ taskId, commentId }) {
        return comments.get(`${taskId}:${commentId}`) ?? null;
      },
      remember({ taskId, commentId }, comment) {
        comments.set(`${taskId}:${commentId}`, comment);
      },
    },
  };
}

function createClient(createComment) {
  return {
    task: {
      v2: {
        comment: {
          async get() { throw new Error('not used'); },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
          create: createComment,
        },
      },
    },
    im: {
      message: {
        async create() {
          return { code: 0, data: { message_id: 'om_notification-1' } };
        },
      },
    },
  };
}

// This fake deliberately exposes only `record`, matching the real Core
// coordinator. It persists the Core receipt and decision before publishing so
// a failed notification enqueue is replayed on the next identical call.
function createRecordOnlyCoordinatorHarness(expectedCore) {
  const receipts = new Map();
  const stats = { recordCalls: 0, coreEvents: 0, decisions: 0 };
  return {
    stats,
    createCoordinator({ core, publishNotification }) {
      assert.equal(core, expectedCore);
      return {
        async record(command) {
          stats.recordCalls += 1;
          let persisted = receipts.get(command.idempotencyKey);
          if (!persisted) {
            stats.coreEvents += 1;
            stats.decisions += 1;
            persisted = {
              result: {
                event: { id: EVENT_ID },
                comment: {
                  actorId: command.actorId,
                  body: command.body,
                  replyToCommentId: command.replyToCommentId,
                  lastEventId: EVENT_ID,
                  occurredAt: command.occurredAt,
                },
              },
              publication: {
                decision: {
                  eventId: EVENT_ID,
                  taskId: command.taskId,
                  kind: 'action_required',
                  deliveries: [{
                    recipientId: RECIPIENT_ID,
                    reason: 'direct_reply',
                    urgency: 'high',
                    deliveryMode: 'immediate',
                    coalesceWindowMs: 0,
                    dedupeKey: `${EVENT_ID}:${RECIPIENT_ID}`,
                  }],
                },
                summary: command.body,
              },
            };
            receipts.set(command.idempotencyKey, persisted);
            expectedCore.conversation.remember(command, persisted.result.comment);
          }
          await publishNotification(persisted.publication);
          return persisted.result;
        },
      };
    },
  };
}

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-reply-production-'));
  const store = openTaskCommentStore({
    dbPath: path.join(directory, 'task-comments.db'),
    clock: () => '2026-08-26T02:09:32.000Z',
  });
  return {
    directory,
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function replyRequest() {
  return {
    taskGuid: TASK_GUID,
    replyToCommentId: 'human-comment-1',
    content: 'ACK-production',
  };
}

function notificationKey() {
  return `${EVENT_ID}:${RECIPIENT_ID}:feishu-im`;
}

function logicalExternalCommentId(commentId) {
  return `external-comment:${createHash('sha256')
    .update(JSON.stringify([APP_ID, commentId]))
    .digest('base64url')}`;
}

test('production assembly honors the real record-only Core coordinator contract', async (context) => {
  if (!REAL_CORE_MODULE || !existsSync(REAL_CORE_MODULE)) {
    context.skip('real Core contract module is unavailable');
    return;
  }
  const coordinatorPath = path.join(path.dirname(REAL_CORE_MODULE), 'task-comment-coordinator.js');
  if (!existsSync(coordinatorPath)) {
    context.skip('real Core comment coordinator module is unavailable');
    return;
  }
  const [{ openCommitmentCore }, { createTaskCommentCoordinator }] = await Promise.all([
    import(pathToFileURL(REAL_CORE_MODULE).href),
    import(pathToFileURL(coordinatorPath).href),
  ]);
  const harness = createHarness();
  let conversationEventIndex = 0;
  let now = '2026-08-26T02:09:32.000Z';
  const coreDbPath = path.join(harness.directory, 'commitments.db');
  const openCore = () => openCommitmentCore({
    dbPath: coreDbPath,
    clock: () => now,
    idGenerator: () => TASK_ID,
    eventIdGenerator: () => 'task-created-real-contract',
    externalLinkIdGenerator: () => 'link-real-contract',
    conversationEventIdGenerator: () => `conversation-real-contract-${conversationEventIndex++}`,
  });
  let core = openCore();
  let sends = 0;
  const client = createClient(async ({ data }) => {
    sends += 1;
    return {
      code: 0,
      data: {
        comment: {
          id: sends === 1
            ? 'feishu-agent-comment-real-contract'
            : 'feishu-native-reminder-real-contract',
          content: data.content,
          creator: { id: APP_ID, type: 'app' },
          reply_to_comment_id: data.reply_to_comment_id,
          created_at: '1787710172000',
          updated_at: '1787710172000',
          resource_type: 'task',
          resource_id: data.resource_id,
        },
      },
    };
  });

  try {
    core.ingest({
      idempotencyKey: 'source:reply-real-contract',
      source: { channel: 'test', externalId: 'reply-real-contract', senderId: RECIPIENT_ID },
      task: {
        title: 'Real reply coordinator contract',
        ownerId: RECIPIENT_ID,
        acceptorId: RECIPIENT_ID,
        assigneeId: 'agent:yueran',
      },
    });
    core.externalLinks.link({
      taskId: TASK_ID,
      actorId: RECIPIENT_ID,
      backend: 'feishu-task-v2',
      externalId: TASK_GUID,
      idempotencyKey: 'link:reply-real-contract',
    });
    core.conversation.record({
      type: 'AddComment',
      taskId: TASK_ID,
      commentId: logicalExternalCommentId(replyRequest().replyToCommentId),
      actorId: RECIPIENT_ID,
      body: 'Please acknowledge.',
      occurredAt: '2026-08-26T02:09:31.000Z',
      idempotencyKey: 'comment:reply-real-contract:human',
    });
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => now,
      createCoordinator: createTaskCommentCoordinator,
    });

    const first = await reply.reply(replyRequest());
    core.close();
    core = null;
    now = '2026-08-26T02:09:33.000Z';
    core = openCore();
    const replayAfterRestart = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => now,
      createCoordinator: createTaskCommentCoordinator,
    });
    const duplicate = await replayAfterRestart.reply(replyRequest());
    assert.equal(first.coreEventId, 'conversation-real-contract-1');
    assert.equal(duplicate.coreEventId, first.coreEventId);
    assert.equal(sends, 2);
    assert.deepEqual(core.notifications.query({ eventId: first.coreEventId }).deliveries, [{
      recipientId: RECIPIENT_ID,
      reason: 'action_required',
      urgency: 'high',
      deliveryMode: 'immediate',
      coalesceWindowMs: 0,
      dedupeKey: `${first.coreEventId}:${RECIPIENT_ID}`,
    }]);
    assert.equal(harness.store.notifications.query({
      dedupeKey: `${first.coreEventId}:${RECIPIENT_ID}:feishu-im`,
    }), null);
  } finally {
    core?.close();
    harness.cleanup();
  }
});

test('a human reply projects one deterministic native self-reply without an ordinary IM reminder', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  const commentCreates = [];
  const imCreates = [];
  const client = {
    task: {
      v2: {
        comment: {
          async get() { throw new Error('not used'); },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
          async create({ data }) {
            commentCreates.push(data);
            const id = commentCreates.length === 1
              ? 'feishu-agent-comment-1'
              : 'feishu-native-reminder-1';
            return {
              code: 0,
              data: {
                comment: {
                  id,
                  content: data.content,
                  creator: { id: APP_ID, type: 'app' },
                  reply_to_comment_id: data.reply_to_comment_id,
                  created_at: '1787710172000',
                  updated_at: '1787710172000',
                  resource_type: 'task',
                  resource_id: data.resource_id,
                },
              },
            };
          },
        },
      },
    },
    im: {
      message: {
        async create(payload) {
          imCreates.push(payload);
          return { code: 0, data: { message_id: 'om_notification-1' } };
        },
      },
    },
  };

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => '2026-08-26T02:09:32.000Z',
      createCoordinator: coordinator.createCoordinator,
    });

    const result = await reply.reply(replyRequest());

    assert.equal(result.projection.commentId, 'feishu-agent-comment-1');
    assert.deepEqual(commentCreates.map(({ content, reply_to_comment_id }) => ({
      content,
      reply_to_comment_id,
    })), [
      {
        content: replyRequest().content,
        reply_to_comment_id: replyRequest().replyToCommentId,
      },
      {
        content: '请查看上方 BOT 回复。',
        reply_to_comment_id: 'feishu-agent-comment-1',
      },
    ]);
    assert.equal(imCreates.length, 0);
    assert.equal(harness.store.notifications.query({ dedupeKey: notificationKey() }), null);
    assert.equal(
      harness.store.isOutboundComment({
        appId: APP_ID,
        commentId: 'feishu-native-reminder-1',
      }),
      true,
    );
  } finally {
    harness.cleanup();
  }
});

test('a deterministic primary rejection preserves the reply failure without native or IM fallback', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  let commentCreates = 0;
  let imCreates = 0;
  const client = {
    task: {
      v2: {
        comment: {
          async get() { throw new Error('not used'); },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
          async create() {
            commentCreates += 1;
            return { code: 400, msg: 'primary reply rejected' };
          },
        },
      },
    },
    im: {
      message: {
        async create() {
          imCreates += 1;
          return { code: 0, data: { message_id: 'om_should-not-send' } };
        },
      },
    },
  };

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => '2026-08-26T02:09:32.000Z',
      createCoordinator: coordinator.createCoordinator,
    });

    await assert.rejects(() => reply.reply(replyRequest()), /primary reply rejected/);
    assert.equal(commentCreates, 1);
    assert.equal(imCreates, 0);
    assert.equal(harness.store.notifications.query({ dedupeKey: notificationKey() }), null);
  } finally {
    harness.cleanup();
  }
});

test('the native self-reply echo is recorded and suppressed by the comment worker', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  let creates = 0;
  const client = {
    task: {
      v2: {
        comment: {
          async get() { throw new Error('not used'); },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
          async create({ data }) {
            creates += 1;
            const id = creates === 1
              ? 'feishu-agent-comment-echo'
              : 'feishu-native-reminder-echo';
            return {
              code: 0,
              data: {
                comment: {
                  id,
                  content: data.content,
                  creator: { id: APP_ID, type: 'app' },
                  reply_to_comment_id: data.reply_to_comment_id,
                  created_at: '1787710172000',
                  updated_at: '1787710172000',
                  resource_type: 'task',
                  resource_id: data.resource_id,
                },
              },
            };
          },
        },
      },
    },
    im: { message: { async create() { throw new Error('ordinary IM must not run'); } } },
  };

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => '2026-08-26T02:09:32.000Z',
      createCoordinator: coordinator.createCoordinator,
    });
    await reply.reply(replyRequest());

    assert.equal(
      harness.store.isOutboundComment({
        appId: APP_ID,
        commentId: 'feishu-native-reminder-echo',
      }),
      true,
    );
    const handler = createTaskCommentEventHandlers({
      appId: APP_ID,
      store: harness.store,
      onError(error) { throw error; },
    })['task.task.comment.updated_v1'];
    await handler({
      event_id: 'native-reminder-echo-event',
      event_type: 'task.task.comment.updated_v1',
      app_id: APP_ID,
      create_time: '1787710172000',
      task_id: TASK_GUID,
      comment_id: 'feishu-native-reminder-echo',
      parent_id: 'feishu-agent-comment-echo',
      obj_type: 1,
    });

    let coreCalls = 0;
    let wakeCalls = 0;
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return {
            kind: 'found',
            comment: {
              id: 'feishu-native-reminder-echo',
              content: '请查看上方 BOT 回复。',
              creator: { id: APP_ID, type: 'app' },
              replyToCommentId: 'feishu-agent-comment-echo',
              createdAt: '2026-08-26T02:09:32.000Z',
              updatedAt: '2026-08-26T02:09:32.000Z',
              resourceType: 'task',
              resourceId: TASK_GUID,
            },
          };
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: TASK_ID, wakeTarget: { agentId: 'agent:yueran' } };
        },
      },
      conversation: {
        async record() {
          coreCalls += 1;
          return { event: { id: 'should-not-be-created' } };
        },
      },
      async wakeAgent() { wakeCalls += 1; },
      workerId: 'native-reminder-echo-worker',
    });

    const result = await worker.processOnce();
    assert.equal(result.results[0].outcome, 'echo_suppressed');
    assert.equal(coreCalls, 0);
    assert.equal(wakeCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test('replaying the same human reply reuses both outbound comment receipts', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  const commentCreates = [];
  const client = {
    task: {
      v2: {
        comment: {
          async get() { throw new Error('not used'); },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
          async create({ data }) {
            commentCreates.push(data);
            const id = commentCreates.length === 1
              ? 'feishu-agent-comment-replay'
              : 'feishu-native-reminder-replay';
            return {
              code: 0,
              data: {
                comment: {
                  id,
                  content: data.content,
                  creator: { id: APP_ID, type: 'app' },
                  reply_to_comment_id: data.reply_to_comment_id,
                  created_at: '1787710172000',
                  updated_at: '1787710172000',
                  resource_type: 'task',
                  resource_id: data.resource_id,
                },
              },
            };
          },
        },
      },
    },
    im: { message: { async create() { throw new Error('ordinary IM must not run'); } } },
  };

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => '2026-08-26T02:09:32.000Z',
      createCoordinator: coordinator.createCoordinator,
    });

    const first = await reply.reply(replyRequest());
    const replay = await reply.reply(replyRequest());

    assert.equal(commentCreates.length, 2);
    assert.equal(first.projection.nativeNotification.created, true);
    assert.equal(replay.projection.nativeNotification.created, false);
    assert.equal(replay.projection.nativeNotification.commentId, 'feishu-native-reminder-replay');
    assert.equal(harness.store.notifications.query({ dedupeKey: notificationKey() }), null);
  } finally {
    harness.cleanup();
  }
});

test('a deterministic native rejection queues one idempotent ordinary IM fallback', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  const commentCreates = [];
  let fallbackEnqueues = 0;
  const store = {
    ...harness.store,
    notifications: {
      ...harness.store.notifications,
      enqueue(request) {
        fallbackEnqueues += 1;
        return harness.store.notifications.enqueue(request);
      },
    },
  };
  const client = {
    task: {
      v2: {
        comment: {
          async get() { throw new Error('not used'); },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
          async create({ data }) {
            commentCreates.push(data);
            if (commentCreates.length === 2) {
              return { code: 400, msg: 'native notification rejected' };
            }
            return {
              code: 0,
              data: {
                comment: {
                  id: 'feishu-agent-comment-fallback',
                  content: data.content,
                  creator: { id: APP_ID, type: 'app' },
                  reply_to_comment_id: data.reply_to_comment_id,
                  created_at: '1787710172000',
                  updated_at: '1787710172000',
                  resource_type: 'task',
                  resource_id: data.resource_id,
                },
              },
            };
          },
        },
      },
    },
    im: { message: { async create() { throw new Error('flush is not part of this call'); } } },
  };

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store,
      client,
      clock: () => '2026-08-26T02:09:32.000Z',
      createCoordinator: coordinator.createCoordinator,
    });

    const first = await reply.reply(replyRequest());
    const replay = await reply.reply(replyRequest());

    assert.equal(commentCreates.length, 2);
    assert.equal(first.projection.commentId, 'feishu-agent-comment-fallback');
    assert.equal(first.projection.notificationChannel, 'feishu-im');
    assert.equal(first.projection.fallback.queued, true);
    assert.equal(replay.projection.notificationChannel, 'feishu-im');
    assert.equal(replay.projection.fallback.existing, true);
    assert.equal(fallbackEnqueues, 1);
    assert.equal(
      harness.store.notifications.query({ dedupeKey: notificationKey() }).status,
      'pending',
    );
  } finally {
    harness.cleanup();
  }
});

test('a fallback ledger failure does not turn an uncertain native delivery into a duplicate IM', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  let fallbackEnqueues = 0;
  const store = {
    ...harness.store,
    notifications: {
      ...harness.store.notifications,
      enqueue(request) {
        fallbackEnqueues += 1;
        throw new Error('simulated notification ledger failure');
      },
    },
  };
  const creates = [];
  const client = createClient(async ({ data }) => {
    creates.push(data);
    if (creates.length === 2) return { code: 400, msg: 'native notification rejected' };
    return {
      code: 0,
      data: {
        comment: {
          id: 'feishu-agent-comment-1',
          content: data.content,
          creator: { id: APP_ID, type: 'app' },
          reply_to_comment_id: data.reply_to_comment_id,
          created_at: '1787710172000',
          updated_at: '1787710172000',
          resource_type: 'task',
          resource_id: data.resource_id,
        },
      },
    };
  });

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store,
      client,
      clock: () => '2026-08-26T02:09:32.000Z',
      createCoordinator: coordinator.createCoordinator,
    });

    await assert.rejects(() => reply.reply(replyRequest()), /notification ledger failure/);
    assert.equal(creates.length, 2);
    assert.equal(harness.store.notifications.query({ dedupeKey: notificationKey() }), null);

    await assert.rejects(
      () => reply.reply(replyRequest()),
      (error) => error?.code === 'OUTBOUND_DELIVERY_UNCERTAIN',
    );
    assert.equal(creates.length, 2);
    assert.equal(fallbackEnqueues, 1);
  } finally {
    harness.cleanup();
  }
});

test('ambiguous Feishu failure blocks blind replay until the exact event echo is adopted', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  let now = '2026-08-26T02:09:32.000Z';
  const remoteComments = [];
  let allowNativeReminder = false;
  const client = createClient(async ({ data }) => {
    remoteComments.push({
      id: allowNativeReminder
        ? 'feishu-native-reminder-after-adoption'
        : 'feishu-agent-comment-ambiguous',
      taskGuid: data.resource_id,
      replyToCommentId: data.reply_to_comment_id,
      content: data.content,
    });
    if (!allowNativeReminder) {
      throw new Error('connection closed after Feishu accepted the comment');
    }
    return {
      code: 0,
      data: {
        comment: {
          id: 'feishu-native-reminder-after-adoption',
          content: data.content,
          creator: { id: APP_ID, type: 'app' },
          reply_to_comment_id: data.reply_to_comment_id,
          created_at: '1787710172000',
          updated_at: '1787710172000',
          resource_type: 'task',
          resource_id: data.resource_id,
        },
      },
    };
  });

  try {
    const reply = createTaskCommentReplyProduction({
      appId: APP_ID,
      core,
      store: harness.store,
      client,
      clock: () => now,
      createCoordinator: coordinator.createCoordinator,
    });

    await assert.rejects(() => reply.reply(replyRequest()), /connection closed/);
    now = '2026-08-26T02:09:33.000Z';
    await assert.rejects(
      () => reply.reply(replyRequest()),
      (error) => error?.code === 'OUTBOUND_DELIVERY_UNCERTAIN',
    );
    assert.equal(remoteComments.length, 1);

    const adopted = harness.store.adoptOutboundComment({
      appId: APP_ID,
      taskGuid: TASK_GUID,
      replyToCommentId: replyRequest().replyToCommentId,
      content: replyRequest().content,
      commentId: remoteComments[0].id,
    });
    assert.equal(adopted.status, 'sent');
    assert.equal(adopted.commentId, remoteComments[0].id);

    allowNativeReminder = true;
    now = '2026-08-26T02:09:34.000Z';
    const recovered = await reply.reply(replyRequest());
    assert.deepEqual(recovered, {
      coreEventId: EVENT_ID,
      projection: {
        created: false,
        commentId: remoteComments[0].id,
        nativeNotification: {
          created: true,
          commentId: 'feishu-native-reminder-after-adoption',
        },
        notificationChannel: 'native-task-comment',
      },
    });
    assert.deepEqual(coordinator.stats, { recordCalls: 3, coreEvents: 1, decisions: 1 });
    assert.equal(remoteComments.length, 2);
    assert.deepEqual(remoteComments[0], {
      id: 'feishu-agent-comment-ambiguous',
      taskGuid: TASK_GUID,
      replyToCommentId: replyRequest().replyToCommentId,
      content: replyRequest().content,
    });
    assert.deepEqual(remoteComments[1], {
      id: 'feishu-native-reminder-after-adoption',
      taskGuid: TASK_GUID,
      replyToCommentId: 'feishu-agent-comment-ambiguous',
      content: '请查看上方 BOT 回复。',
    });
    assert.equal(harness.store.notifications.query({ dedupeKey: notificationKey() }), null);
  } finally {
    harness.cleanup();
  }
});
