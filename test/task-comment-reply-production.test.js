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
          id: 'feishu-agent-comment-real-contract',
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
    assert.equal(sends, 1);
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
    }).status, 'pending');
  } finally {
    core?.close();
    harness.cleanup();
  }
});

test('notification enqueue failure replays the persisted decision before one exact Feishu reply', async () => {
  const harness = createHarness();
  const core = createCoreMapping();
  const coordinator = createRecordOnlyCoordinatorHarness(core);
  let now = '2026-08-26T02:09:32.000Z';
  const enqueueCreated = [];
  let failFirstEnqueue = true;
  const store = {
    ...harness.store,
    notifications: {
      ...harness.store.notifications,
      enqueue(request) {
        if (failFirstEnqueue) {
          failFirstEnqueue = false;
          throw new Error('simulated notification ledger failure');
        }
        const result = harness.store.notifications.enqueue(request);
        enqueueCreated.push(result.created);
        return result;
      },
    },
  };
  const creates = [];
  const client = createClient(async ({ data }) => {
    creates.push(data);
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
      clock: () => now,
      createCoordinator: coordinator.createCoordinator,
    });

    await assert.rejects(() => reply.reply(replyRequest()), /notification ledger failure/);
    assert.equal(creates.length, 0);
    assert.equal(harness.store.notifications.query({ dedupeKey: notificationKey() }), null);

    now = '2026-08-26T02:09:33.000Z';
    const recovered = await reply.reply(replyRequest());
    now = '2026-08-26T02:09:34.000Z';
    const duplicate = await reply.reply(replyRequest());

    assert.equal(recovered.coreEventId, EVENT_ID);
    assert.equal(recovered.projection.commentId, 'feishu-agent-comment-1');
    assert.deepEqual(duplicate, {
      coreEventId: EVENT_ID,
      projection: { created: false, commentId: 'feishu-agent-comment-1' },
    });
    assert.deepEqual(coordinator.stats, { recordCalls: 3, coreEvents: 1, decisions: 1 });
    assert.deepEqual(enqueueCreated, [true, false]);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].content, replyRequest().content);
    assert.equal(creates[0].reply_to_comment_id, replyRequest().replyToCommentId);
    assert.equal(creates[0].resource_id, TASK_GUID);
    assert.equal(
      harness.store.notifications.query({ dedupeKey: notificationKey() }).status,
      'pending',
    );
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
  const client = createClient(async ({ data }) => {
    remoteComments.push({
      id: 'feishu-agent-comment-ambiguous',
      taskGuid: data.resource_id,
      replyToCommentId: data.reply_to_comment_id,
      content: data.content,
    });
    throw new Error('connection closed after Feishu accepted the comment');
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

    now = '2026-08-26T02:09:34.000Z';
    const recovered = await reply.reply(replyRequest());
    assert.deepEqual(recovered, {
      coreEventId: EVENT_ID,
      projection: { created: false, commentId: remoteComments[0].id },
    });
    assert.deepEqual(coordinator.stats, { recordCalls: 3, coreEvents: 1, decisions: 1 });
    assert.equal(remoteComments.length, 1);
    assert.deepEqual(remoteComments[0], {
      id: 'feishu-agent-comment-ambiguous',
      taskGuid: TASK_GUID,
      replyToCommentId: replyRequest().replyToCommentId,
      content: replyRequest().content,
    });
    assert.equal(
      harness.store.notifications.query({ dedupeKey: notificationKey() }).status,
      'pending',
    );
  } finally {
    harness.cleanup();
  }
});
