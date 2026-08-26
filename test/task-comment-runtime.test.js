import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTaskCommentEventHandlers } from '../src/lib/task-comment-event.js';
import { createTaskCommentReconciler } from '../src/lib/task-comment-reconciliation.js';
import {
  createTaskCommentReplyAdapter,
  createTaskCommentWorker,
} from '../src/lib/task-comment-runtime.js';
import { openTaskCommentStore } from '../src/lib/task-comment-store.js';

const APP_ID = 'cli_task_gateway';

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-comments-'));
  let now = '2026-08-25T10:00:00.000Z';
  const store = openTaskCommentStore({
    dbPath: path.join(directory, 'task-comments.db'),
    clock: () => now,
  });
  return {
    store,
    setNow(value) {
      now = value;
    },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function event(overrides = {}) {
  return {
    event_id: 'evt-comment-1',
    event_type: 'task.task.comment.updated_v1',
    app_id: APP_ID,
    create_time: '1787652000000',
    task_id: 'task-guid-1',
    comment_id: 'comment-1',
    parent_id: '',
    obj_type: 1,
    ...overrides,
  };
}

function foundComment(overrides = {}) {
  return {
    id: 'comment-1',
    content: 'Please verify the customer renewal date.',
    creator: { id: 'ou_requester', type: 'user' },
    replyToCommentId: null,
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    resourceType: 'task',
    resourceId: 'task-guid-1',
    ...overrides,
  };
}

function enqueueHandler(store) {
  return createTaskCommentEventHandlers({
    appId: APP_ID,
    store,
    onError() {},
  })['task.task.comment.updated_v1'];
}

test('EventDispatcher handler durably accepts before ACK and applies envelope plus business idempotency', async () => {
  const harness = createHarness();
  try {
    const handler = enqueueHandler(harness.store);
    const first = await handler(event());
    const retriedEnvelope = await handler(event());
    const duplicatedBusinessEvent = await handler(event({ event_id: 'evt-comment-redelivery' }));

    assert.equal(first.receipt.accepted, true);
    assert.equal(retriedEnvelope.receipt.duplicate, 'event');
    assert.equal(duplicatedBusinessEvent.receipt.duplicate, 'business');
    assert.deepEqual(harness.store.claim({
      appId: 'another_app',
      workerId: 'wrong-app-worker',
    }), []);
    assert.equal(
      harness.store.queryInbox({ appId: APP_ID, eventId: 'evt-comment-1' }).status,
      'pending',
    );
    assert.equal(
      harness.store.queryInbox({ appId: APP_ID, eventId: 'evt-comment-redelivery' }).status,
      'suppressed',
    );
    await assert.rejects(
      () => handler(event({ comment_id: 'different-comment' })),
      (error) => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      () => handler(event({ event_id: 'evt-other-app', app_id: 'another_app' })),
      /different app/,
    );
  } finally {
    harness.cleanup();
  }
});

test('worker reads Task v2 content, maps through the fake F3 seam, records Core once, and wakes once', async () => {
  const harness = createHarness();
  try {
    await enqueueHandler(harness.store)(event({
      parent_id: 'comment-parent',
    }));
    const mappingCalls = [];
    const commands = [];
    const wakes = [];
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return {
            kind: 'found',
            comment: foundComment({ replyToCommentId: 'comment-parent' }),
          };
        },
      },
      taskMapping: {
        async resolve(input) {
          mappingCalls.push(input);
          return {
            taskId: 'core-task-1',
            wakeTarget: { agentId: 'agent:yueran', sessionId: 'session-1' },
          };
        },
      },
      conversation: {
        async record(command) {
          commands.push(command);
          return { event: { id: 'core-comment-event-1' }, comment: {} };
        },
      },
      async wakeAgent(wake) {
        wakes.push(wake);
      },
      workerId: 'worker-1',
    });

    assert.deepEqual(await worker.processOnce(), {
      claimed: 1,
      processed: 1,
      deadLettered: 0,
      results: [{
        eventId: 'evt-comment-1',
        outcome: 'recorded',
        command: commands[0],
        result: { event: { id: 'core-comment-event-1' }, comment: {} },
      }],
    });
    assert.deepEqual(mappingCalls, [{ appId: APP_ID, taskGuid: 'task-guid-1' }]);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, 'AddComment');
    assert.equal(commands[0].taskId, 'core-task-1');
    assert.equal(commands[0].actorId, 'ou_requester');
    assert.match(commands[0].commentId, /^external-comment:/);
    assert.match(commands[0].replyToCommentId, /^external-comment:/);
    assert.equal(wakes.length, 1);
    assert.deepEqual(wakes[0].target, {
      agentId: 'agent:yueran',
      sessionId: 'session-1',
    });
    assert.deepEqual(wakes[0].replyContext, {
      channel: 'feishu-task-v2',
      appId: APP_ID,
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-1',
    });
    assert.equal((await worker.processOnce()).claimed, 0);
    assert.equal(
      harness.store.queryInbox({ appId: APP_ID, eventId: 'evt-comment-1' }).status,
      'processed',
    );
  } finally {
    harness.cleanup();
  }
});

test('worker records comments for a human-owned task without attempting an Agent wake', async () => {
  const harness = createHarness();
  try {
    await enqueueHandler(harness.store)(event({ event_id: 'evt-human-task' }));
    let records = 0;
    let wakes = 0;
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return { kind: 'found', comment: foundComment() };
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-human', wakeTarget: null };
        },
      },
      conversation: {
        async record() {
          records += 1;
          return { event: { id: 'core-human-comment-1' } };
        },
      },
      async wakeAgent() { wakes += 1; },
      workerId: 'worker-human-task',
    });

    assert.equal((await worker.processOnce()).processed, 1);
    assert.equal(records, 1);
    assert.equal(wakes, 0);
  } finally {
    harness.cleanup();
  }
});

test('worker maps an edited Task v2 comment to a Core revision command', async () => {
  const harness = createHarness();
  try {
    await enqueueHandler(harness.store)(event({
      event_id: 'evt-comment-revision',
      create_time: '1787652060000',
    }));
    const commands = [];
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return {
            kind: 'found',
            comment: foundComment({
              content: 'Edited requirement',
              updatedAt: '2026-08-25T10:01:00.000Z',
            }),
          };
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-1', wakeTarget: { sessionId: 'session-1' } };
        },
      },
      conversation: {
        async record(command) {
          commands.push(command);
          return { event: { id: 'core-comment-revision-1' } };
        },
      },
      async wakeAgent() {},
      workerId: 'worker-revision',
    });

    assert.equal((await worker.processOnce()).processed, 1);
    assert.equal(commands[0].type, 'ReviseComment');
    assert.equal(commands[0].body, 'Edited requirement');
    assert.equal(commands[0].occurredAt, '2026-08-25T10:01:00.000Z');
  } finally {
    harness.cleanup();
  }
});

test('missing deleted comment produces a Core tombstone instead of losing the event', async () => {
  const harness = createHarness();
  try {
    await enqueueHandler(harness.store)(event());
    const commands = [];
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: { async getComment() { return { kind: 'missing', commentId: 'comment-1' }; } },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-1', wakeTarget: { sessionId: 'session-1' } };
        },
      },
      conversation: {
        async record(command) {
          commands.push(command);
          return { event: { id: 'tombstone-event-1' } };
        },
      },
      async wakeAgent() {},
      workerId: 'worker-delete',
    });
    const result = await worker.processOnce();

    assert.equal(result.results[0].outcome, 'tombstone_recorded');
    assert.equal(commands[0].type, 'DeleteComment');
    assert.equal(Object.hasOwn(commands[0], 'body'), false);
    assert.match(commands[0].actorId, /^external:/);
  } finally {
    harness.cleanup();
  }
});

test('comment read failures retry with a durable lease and reach dead-letter at the bound', async () => {
  const harness = createHarness();
  try {
    await enqueueHandler(harness.store)(event());
    let reads = 0;
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          reads += 1;
          throw new Error('temporary Task v2 read failure');
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-1', wakeTarget: { sessionId: 'session-1' } };
        },
      },
      conversation: { async record() { throw new Error('must not reach Core'); } },
      async wakeAgent() {},
      workerId: 'worker-retry',
      retryAfterMs: 1_000,
      maxAttempts: 2,
    });

    const first = await worker.processOnce();
    assert.equal(first.results[0].outcome, 'retry_wait');
    harness.setNow('2026-08-25T10:00:02.000Z');
    const second = await worker.processOnce();
    assert.equal(second.results[0].outcome, 'dead_letter');
    assert.equal(reads, 2);
    assert.equal(
      harness.store.queryInbox({ appId: APP_ID, eventId: 'evt-comment-1' }).status,
      'dead_letter',
    );
  } finally {
    harness.cleanup();
  }
});

test('outbound reply ledger prevents duplicate replies and suppresses the exact returned comment echo', async () => {
  const harness = createHarness();
  try {
    let sends = 0;
    const replyAdapter = createTaskCommentReplyAdapter({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async reply(request) {
          sends += 1;
          assert.equal(request.replyToCommentId, 'comment-human');
          return foundComment({
            id: 'comment-agent',
            content: request.content,
            creator: { id: APP_ID, type: 'app' },
            replyToCommentId: 'comment-human',
          });
        },
      },
    });
    const request = {
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-human',
      content: 'The renewal date is September 30.',
      idempotencyKey: 'agent-reply-1',
    };
    assert.deepEqual(await replyAdapter.reply(request), {
      created: true,
      commentId: 'comment-agent',
    });
    assert.deepEqual(await replyAdapter.reply(request), {
      created: false,
      commentId: 'comment-agent',
    });
    assert.equal(sends, 1);

    await enqueueHandler(harness.store)(event({
      event_id: 'evt-agent-echo',
      comment_id: 'comment-agent',
    }));
    let coreCalls = 0;
    let wakes = 0;
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return {
            kind: 'found',
            comment: foundComment({
              id: 'comment-agent',
              creator: { id: APP_ID, type: 'app' },
            }),
          };
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-1', wakeTarget: { sessionId: 'session-1' } };
        },
      },
      conversation: { async record() { coreCalls += 1; } },
      async wakeAgent() { wakes += 1; },
      workerId: 'worker-echo',
    });
    const result = await worker.processOnce();
    assert.equal(result.results[0].outcome, 'echo_suppressed');
    assert.equal(coreCalls, 0);
    assert.equal(wakes, 0);
  } finally {
    harness.cleanup();
  }
});

test('worker adopts a matching echo while outbound delivery is still pending', async () => {
  const harness = createHarness();
  try {
    harness.store.beginOutbound({
      appId: APP_ID,
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-human',
      content: 'Answer racing with the event stream.',
      idempotencyKey: 'agent-reply-racing-1',
    });
    await enqueueHandler(harness.store)(event({
      event_id: 'evt-agent-racing-echo',
      comment_id: 'comment-agent-racing',
    }));
    let coreCalls = 0;
    let wakes = 0;
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return {
            kind: 'found',
            comment: foundComment({
              id: 'comment-agent-racing',
              content: 'Answer racing with the event stream.',
              creator: { id: APP_ID, type: 'app' },
              replyToCommentId: 'comment-human',
            }),
          };
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-1', wakeTarget: { agentId: 'agent:yueran' } };
        },
      },
      conversation: { async record() { coreCalls += 1; } },
      async wakeAgent() { wakes += 1; },
      workerId: 'worker-racing-echo',
    });

    const result = await worker.processOnce();
    assert.equal(result.results[0].outcome, 'echo_suppressed');
    assert.equal(coreCalls, 0);
    assert.equal(wakes, 0);
    const delivery = harness.store.queryOutbound({
      appId: APP_ID,
      idempotencyKey: 'agent-reply-racing-1',
    });
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.commentId, 'comment-agent-racing');
    assert.equal(delivery.lastError, null);
    assert.equal(harness.store.finishOutbound({
      appId: APP_ID,
      idempotencyKey: 'agent-reply-racing-1',
      commentId: 'comment-agent-racing',
    }).status, 'sent');
  } finally {
    harness.cleanup();
  }
});

test('worker never adopts a human same-content comment as an outbound Agent echo', async () => {
  const harness = createHarness();
  try {
    harness.store.beginOutbound({
      appId: APP_ID,
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-human',
      content: 'A shared answer.',
      idempotencyKey: 'agent-reply-human-spoof-1',
    });
    await enqueueHandler(harness.store)(event({
      event_id: 'evt-human-same-content',
      comment_id: 'comment-human-same-content',
    }));
    let coreCalls = 0;
    let wakes = 0;
    const worker = createTaskCommentWorker({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async getComment() {
          return {
            kind: 'found',
            comment: foundComment({
              id: 'comment-human-same-content',
              content: 'A shared answer.',
              creator: { id: 'ou_attacker', type: 'user' },
              replyToCommentId: 'comment-human',
            }),
          };
        },
      },
      taskMapping: {
        async resolve() {
          return { taskId: 'core-task-1', wakeTarget: { agentId: 'agent:yueran' } };
        },
      },
      conversation: {
        async record() {
          coreCalls += 1;
          return { event: { id: 'core-human-same-content-event' } };
        },
      },
      async wakeAgent() { wakes += 1; },
      workerId: 'worker-human-same-content',
    });

    const result = await worker.processOnce();
    assert.equal(result.results[0].outcome, 'recorded');
    assert.equal(coreCalls, 1);
    assert.equal(wakes, 1);
    assert.equal(harness.store.queryOutbound({
      appId: APP_ID,
      idempotencyKey: 'agent-reply-human-spoof-1',
    }).status, 'pending');
  } finally {
    harness.cleanup();
  }
});

test('ambiguous outbound failure is dead-lettered and automatic replay cannot duplicate the reply', async () => {
  const harness = createHarness();
  try {
    let sends = 0;
    const adapter = createTaskCommentReplyAdapter({
      appId: APP_ID,
      store: harness.store,
      commentApi: {
        async reply() {
          sends += 1;
          throw new Error('connection closed after request write');
        },
      },
    });
    const request = {
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-human',
      content: 'A possibly delivered answer',
      idempotencyKey: 'ambiguous-reply-1',
    };
    await assert.rejects(() => adapter.reply(request), /connection closed/);
    await assert.rejects(
      () => adapter.reply(request),
      (error) => error?.code === 'OUTBOUND_DELIVERY_UNCERTAIN',
    );
    assert.equal(sends, 1);
    assert.equal(
      harness.store.queryOutbound({
        appId: APP_ID,
        idempotencyKey: 'ambiguous-reply-1',
      }).status,
      'dead_letter',
    );
    assert.equal(harness.store.adoptOutboundComment({
      appId: APP_ID,
      taskGuid: 'task-guid-1',
      replyToCommentId: 'comment-human',
      content: 'A possibly delivered answer',
      commentId: 'comment-found-by-event',
    }).status, 'sent');
    assert.deepEqual(await adapter.reply(request), {
      created: false,
      commentId: 'comment-found-by-event',
    });
    assert.equal(sends, 1);
  } finally {
    harness.cleanup();
  }
});

test('reconciliation covers long-connection gaps, non-App tasks, completion grace, and missing deletions', async () => {
  const harness = createHarness();
  try {
    harness.store.recordObserved({
      appId: APP_ID,
      taskGuid: 'task-guid-app',
      commentId: 'comment-deleted-during-gap',
      updatedAt: '2026-08-25T09:00:00.000Z',
    });
    const listed = [];
    const reconciler = createTaskCommentReconciler({
      appId: APP_ID,
      store: harness.store,
      clock: () => '2026-08-25T10:00:00.000Z',
      commentApi: {
        async listComments({ taskGuid }) {
          listed.push(taskGuid);
          return [foundComment({
            id: `comment-${taskGuid}`,
            resourceId: taskGuid,
          })];
        },
      },
      taskMapping: {
        async list() {
          return [
            {
              taskId: 'core-app',
              taskGuid: 'task-guid-app',
              state: 'in_progress',
              updatedAt: '2026-08-25T09:00:00.000Z',
              eventCoverage: 'app',
            },
            {
              taskId: 'core-non-app',
              taskGuid: 'task-guid-non-app',
              state: 'review',
              updatedAt: '2026-08-25T09:00:00.000Z',
              eventCoverage: 'poll',
            },
            {
              taskId: 'core-old-done',
              taskGuid: 'task-guid-old-done',
              state: 'done',
              updatedAt: '2026-08-21T09:00:00.000Z',
              eventCoverage: 'app',
            },
          ];
        },
      },
    });
    const result = await reconciler.runOnce();

    assert.deepEqual(listed, ['task-guid-app', 'task-guid-non-app']);
    assert.equal(result.reconciled, 2);
    assert.equal(result.skippedGrace, 1);
    assert.equal(result.enqueued, 3, 'two visible comments plus one missing-comment tombstone');
    assert.equal((await reconciler.runOnce()).skippedInterval, 2);
  } finally {
    harness.cleanup();
  }
});

test('reconciliation isolates a poisoned mapping and continues with the remaining tasks', async () => {
  const harness = createHarness();
  try {
    const listed = [];
    const reconciler = createTaskCommentReconciler({
      appId: APP_ID,
      store: harness.store,
      clock: () => '2026-08-25T10:00:00.000Z',
      commentApi: {
        async listComments({ taskGuid }) {
          listed.push(taskGuid);
          if (taskGuid === 'task-guid-poison') throw new Error('forbidden task');
          return [foundComment({ id: 'comment-healthy', resourceId: taskGuid })];
        },
      },
      taskMapping: {
        async list() {
          return [
            {
              taskId: 'core-poison', taskGuid: 'task-guid-poison', state: 'in_progress',
              updatedAt: '2026-08-25T09:00:00.000Z', eventCoverage: 'app',
            },
            {
              taskId: 'core-healthy', taskGuid: 'task-guid-healthy', state: 'review',
              updatedAt: '2026-08-25T09:00:00.000Z', eventCoverage: 'app',
            },
          ];
        },
      },
    });

    const result = await reconciler.runOnce();
    assert.deepEqual(listed, ['task-guid-poison', 'task-guid-healthy']);
    assert.equal(result.considered, 2);
    assert.equal(result.reconciled, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failures, [{
      taskGuid: 'task-guid-poison',
      error: 'forbidden task',
    }]);
  } finally {
    harness.cleanup();
  }
});
