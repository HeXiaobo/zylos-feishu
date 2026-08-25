import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFeishuNotificationAdapter,
  createRoutedNotificationSender,
  createSdkFeishuNotificationSender,
} from '../src/lib/task-notification-adapter.js';
import { openTaskCommentStore } from '../src/lib/task-comment-store.js';

function createHarness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-notifications-'));
  let now = '2026-08-25T10:00:00.000Z';
  const store = openTaskCommentStore({
    dbPath: path.join(directory, 'notifications.db'),
    clock: () => now,
  });
  return {
    store,
    clock: () => now,
    setNow(value) { now = value; },
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function decision(eventId, summaryKey) {
  return {
    eventId,
    taskId: 'core-task-1',
    kind: 'blocked',
    deliveries: [{
      recipientId: 'ou_owner',
      reason: 'blocked',
      urgency: 'normal',
      deliveryMode: 'coalesce',
      coalesceWindowMs: 30_000,
      dedupeKey: `${eventId}:ou_owner`,
      summaryKey,
    }],
  };
}

function immediateDecision(eventId) {
  return {
    eventId,
    taskId: 'core-task-1',
    kind: 'review',
    deliveries: [{
      recipientId: 'ou_acceptor',
      reason: 'review_required',
      urgency: 'high',
      deliveryMode: 'immediate',
      coalesceWindowMs: 0,
      dedupeKey: `${eventId}:ou_acceptor`,
    }],
  };
}

test('deduplicates and coalesces ordinary reminders into one rate-limited IM delivery', async () => {
  const harness = createHarness();
  try {
    const sends = [];
    const adapter = createFeishuNotificationAdapter({
      store: harness.store,
      sender: { async send(message) { sends.push(message); return { messageId: 'om_notice' }; } },
      workerId: 'notice-worker',
      clock: harness.clock,
      minRecipientIntervalMs: 1_000,
    });
    const first = adapter.enqueue({
      decision: decision('event-blocked-1'),
      summary: '客户任务被外部依赖阻断',
    });
    adapter.enqueue({
      decision: decision('event-blocked-2'),
      summary: '交付尝试失败，正在等待人工处理',
    });
    const replay = adapter.enqueue({
      decision: decision('event-blocked-1'),
      summary: '客户任务被外部依赖阻断',
    });

    assert.equal(first[0].created, true);
    assert.equal(replay[0].created, false);
    assert.equal((await adapter.flushOnce()).claimed, 0);
    harness.setNow('2026-08-25T10:00:30.000Z');
    const flushed = await adapter.flushOnce();
    assert.deepEqual(flushed, { claimed: 2, messagesSent: 1, deadLettered: 0 });
    assert.equal(sends.length, 1);
    assert.match(sends[0].text, /客户任务被外部依赖阻断/);
    assert.match(sends[0].text, /交付尝试失败/);
    assert.equal(
      harness.store.notifications.query({
        dedupeKey: 'event-blocked-1:ou_owner:feishu-im',
      }).status,
      'sent',
    );
  } finally {
    harness.cleanup();
  }
});

test('SDK notification sender uses a stable UUID and direct open_id text message', async () => {
  const calls = [];
  const sender = createSdkFeishuNotificationSender({
    client: {
      im: {
        message: {
          async create(payload) {
            calls.push(payload);
            return { code: 0, data: { message_id: 'om_notification_1' } };
          },
        },
      },
    },
  });
  const request = {
    recipientId: 'ou_acceptor',
    text: '任务已进入待验收',
    idempotencyKey: 'event-review-1:ou_acceptor:feishu-im',
  };
  assert.deepEqual(await sender.send(request), { messageId: 'om_notification_1' });
  await sender.send(request);

  assert.equal(calls[0].params.receive_id_type, 'open_id');
  assert.equal(calls[0].data.receive_id, 'ou_acceptor');
  assert.equal(calls[0].data.msg_type, 'text');
  assert.equal(calls[0].data.uuid, calls[1].data.uuid);
  assert.match(calls[0].data.uuid, /^ztn_[a-f0-9]{40}$/);
});

test('logical Agent recipients are routed to the Agent wake sender instead of Feishu open_id', async () => {
  const feishu = [];
  const agents = [];
  const sender = createRoutedNotificationSender({
    feishuSender: {
      async send(request) { feishu.push(request); return { messageId: 'om_human' }; },
    },
    agentSender: {
      async send(request) { agents.push(request); return { wakeId: 'wake-agent' }; },
    },
  });
  const common = { text: '任务阻塞，请处理', idempotencyKey: 'notification-1' };

  assert.deepEqual(
    await sender.send({ recipientId: 'agent:yueran', ...common }),
    { wakeId: 'wake-agent' },
  );
  assert.deepEqual(
    await sender.send({ recipientId: 'ou_owner', ...common }),
    { messageId: 'om_human' },
  );
  assert.deepEqual(agents, [{ agentId: 'agent:yueran', ...common }]);
  assert.deepEqual(feishu, [{ recipientId: 'ou_owner', ...common }]);
  await assert.rejects(
    () => sender.send({ recipientId: 'person-without-platform-mapping', ...common }),
    (error) => error?.retryable === false,
  );
});

test('immediate critical reminder retries durably and dead-letters at the attempt bound', async () => {
  const harness = createHarness();
  try {
    const adapter = createFeishuNotificationAdapter({
      store: harness.store,
      sender: { async send() { throw new Error('temporary IM failure'); } },
      workerId: 'notice-retry-worker',
      clock: harness.clock,
      retryAfterMs: 1_000,
      maxAttempts: 2,
    });
    adapter.enqueue({
      decision: immediateDecision('event-review-retry'),
      summary: '任务等待验收',
    });

    assert.deepEqual(await adapter.flushOnce(), {
      claimed: 1,
      messagesSent: 0,
      deadLettered: 0,
    });
    assert.equal(
      harness.store.notifications.query({
        dedupeKey: 'event-review-retry:ou_acceptor:feishu-im',
      }).status,
      'retry_wait',
    );
    harness.setNow('2026-08-25T10:00:01.000Z');
    assert.deepEqual(await adapter.flushOnce(), {
      claimed: 1,
      messagesSent: 0,
      deadLettered: 1,
    });
    assert.equal(
      harness.store.notifications.query({
        dedupeKey: 'event-review-retry:ou_acceptor:feishu-im',
      }).status,
      'dead_letter',
    );
  } finally {
    harness.cleanup();
  }
});

test('a large merged notification remains within the Feishu text bound', async () => {
  const harness = createHarness();
  try {
    const sends = [];
    const adapter = createFeishuNotificationAdapter({
      store: harness.store,
      sender: { async send(message) { sends.push(message); return { messageId: 'om_large' }; } },
      workerId: 'notice-large-worker',
      clock: harness.clock,
    });
    for (let index = 0; index < 6; index += 1) {
      adapter.enqueue({
        decision: decision(`event-large-${index}`),
        summary: `${index}:${'x'.repeat(3_997)}`,
      });
    }
    harness.setNow('2026-08-25T10:00:30.000Z');

    assert.equal((await adapter.flushOnce()).messagesSent, 1);
    assert.ok(Array.from(sends[0].text).length <= 20_000);
    assert.match(sends[0].text, /另有 2 条提醒已合并/);
  } finally {
    harness.cleanup();
  }
});
