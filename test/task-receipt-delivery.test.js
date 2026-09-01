import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFeishuFinalReplyPort } from '../src/lib/feishu-final-reply-port.js';
import { createTaskReceiptDelivery } from '../src/lib/task-receipt-delivery.js';
import { taskEffectPayloadHash } from '../src/lib/task-effect-settlement.js';

function effect() {
  return {
    schemaVersion: 1,
    type: 'TaskEffect',
    effectId: 'effect-task-receipt-1',
    eventId: 'task-effect-applied-1',
    requestId: 'req-task-receipt-1',
    traceId: 'trace:req-task-receipt-1',
    taskId: 'task-1',
    coreVersion: 2,
    task: { id: 'task-1', version: 2, title: 'Reply after projection' },
  };
}

function settlement(taskEffect, overrides = {}) {
  return {
    outcome: 'platform_accepted',
    effectId: taskEffect.effectId,
    payloadHash: taskEffectPayloadHash(taskEffect),
    externalTaskId: 'guid-task-1',
    externalVersion: taskEffect.coreVersion,
    attempt: 1,
    leaseEpoch: 1,
    workerId: 'worker-a',
    generation: 0,
    ...overrides,
  };
}

test('task receipt is an independent durable ReplyIntent bound to an applied TaskEffect', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-receipt-'));
  const outboxPath = path.join(directory, 'task-receipts.json');
  const attempts = [];
  let fail = true;
  try {
    let delivery = createTaskReceiptDelivery({
      outboxPath,
      clock: () => 1_788_000_000_000,
      resolveTarget: () => ({ kind: 'reply', id: 'om-source-1' }),
      async deliver(request) {
        attempts.push(request);
        if (fail) throw new Error('access_token=secret response body should not persist');
        return { success: true, messageId: 'om-task-receipt' };
      },
      async reconcile() { return { outcome: 'not_delivered' }; },
    });
    await assert.rejects(() => delivery.send({
      effect: effect(),
      settlement: settlement(effect()),
      route: { adapterId: 'feishu', targetRef: 'opaque:reply-1' },
    }));
    assert.equal(delivery.pending().length, 1);

    fail = false;
    delivery = createTaskReceiptDelivery({
      outboxPath,
      clock: () => 1_788_000_001_000,
      resolveTarget: () => ({ kind: 'reply', id: 'om-source-1' }),
      async deliver(request) {
        attempts.push(request);
        return { success: true, messageId: 'om-task-receipt' };
      },
      async reconcile() { return { outcome: 'not_delivered' }; },
    });
    assert.deepEqual(await delivery.retryPending(), { attempted: 1, delivered: 1, failed: 0 });
    assert.equal(attempts[0].deliveryUuid, attempts[1].deliveryUuid);
    assert.equal(attempts[0].intent.disposition, 'task_receipt');
    assert.equal(attempts[0].intent.cause.kind, 'task_effect');
    assert.equal(attempts[0].intent.cause.eventId, effect().eventId);
    assert.deepEqual(Object.keys(attempts[0].intent.cause).sort(), ['eventId', 'kind']);
    assert.equal(Object.hasOwn(attempts[0].intent, 'outcomeId'), false);
    assert.match(attempts[0].intent.route.targetRef, /^opaque:/);
    const finalReply = createFeishuFinalReplyPort({
      delivery: {
        send: async () => ({ outcome: 'platform_accepted', externalRef: 'om-task-receipt' }),
        reconcile: async () => ({ outcome: 'reconciled', externalRef: 'om-task-receipt' }),
      },
      presentation: { settlePresence() {} },
      clock: () => 1_788_000_002_000,
    });
    const intent = attempts[0].intent;
    const receipt = await finalReply.deliver({
      replayed: false,
      action: 'send',
      intent,
      deliveryId: `delivery:${intent.intentId}`,
      attemptId: `attempt:${intent.intentId}:1`,
      claimEpoch: 1,
      leaseOwner: 'core-task-receipt',
      leaseToken: 'lease-task-receipt-1',
      leaseExpiresAt: 1_788_000_032_000,
    });
    assert.equal(receipt.outcome, 'platform_accepted');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown task receipt delivery reconciles before any resend', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-receipt-unknown-'));
  let sends = 0;
  let reconciles = 0;
  try {
    const delivery = createTaskReceiptDelivery({
      outboxPath: path.join(directory, 'task-receipts.json'),
      clock: () => 1_788_000_000_000,
      resolveTarget: () => ({ kind: 'chat', id: 'oc-chat-1' }),
      async deliver() {
        sends += 1;
        return { outcome: 'unknown' };
      },
      async reconcile(intent) {
        reconciles += 1;
        assert.equal(intent.disposition, 'task_receipt');
        return { outcome: 'reconciled', messageId: 'om-reconciled' };
      },
    });
    const result = await delivery.send({
      effect: effect(),
      settlement: settlement(effect(), { outcome: 'reconciled' }),
      route: { adapterId: 'feishu', targetRef: 'opaque:chat-1' },
    });
    assert.equal(result.success, true);
    assert.equal(sends, 1);
    assert.equal(reconciles, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown or dead-letter TaskEffect states cannot manufacture a task receipt', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-receipt-invalid-'));
  try {
    const delivery = createTaskReceiptDelivery({
      outboxPath: path.join(directory, 'task-receipts.json'),
      clock: () => 1_788_000_000_000,
      resolveTarget: () => ({ kind: 'chat', id: 'oc-chat-1' }),
      deliver: async () => ({ success: true }),
      reconcile: async () => ({ outcome: 'not_delivered' }),
    });
    for (const outcome of ['unknown', 'dead_letter']) {
      assert.throws(() => delivery.prepare({
        effect: effect(),
        settlement: { outcome, effectId: effect().effectId },
        route: { adapterId: 'feishu', targetRef: 'opaque:chat-1' },
      }), /settled TaskEffect/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an incomplete TaskEffect settlement cannot manufacture a task receipt', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-receipt-spoofed-'));
  try {
    const delivery = createTaskReceiptDelivery({
      outboxPath: path.join(directory, 'task-receipts.json'),
      clock: () => 1_788_000_000_000,
      resolveTarget: () => ({ kind: 'chat', id: 'oc-chat-1' }),
      deliver: async () => ({ success: true }),
      reconcile: async () => ({ outcome: 'not_delivered' }),
    });

    assert.throws(() => delivery.prepare({
      effect: effect(),
      settlement: {
        outcome: 'platform_accepted',
        effectId: effect().effectId,
      },
      route: { adapterId: 'feishu', targetRef: 'opaque:chat-1' },
    }), /verified TaskEffect settlement/);
    assert.deepEqual(delivery.pending(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a settlement with mismatched effect content or lease fence cannot manufacture a receipt', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-receipt-conflict-'));
  try {
    const delivery = createTaskReceiptDelivery({
      outboxPath: path.join(directory, 'task-receipts.json'),
      clock: () => 1_788_000_000_000,
      resolveTarget: () => ({ kind: 'chat', id: 'oc-chat-1' }),
      deliver: async () => ({ success: true }),
      reconcile: async () => ({ outcome: 'not_delivered' }),
    });
    const taskEffect = effect();
    const request = overrides => ({
      effect: taskEffect,
      settlement: settlement(taskEffect, overrides),
      route: { adapterId: 'feishu', targetRef: 'opaque:chat-1' },
    });

    assert.throws(
      () => delivery.prepare(request({
        payloadHash: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      })),
      error => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    for (const invalidFence of [{ attempt: 0 }, { leaseEpoch: 0 }, { generation: -1 }]) {
      assert.throws(
        () => delivery.prepare(request(invalidFence)),
        /verified TaskEffect settlement/,
      );
    }
    assert.deepEqual(delivery.pending(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a whitespace-padded settlement hash cannot enter the durable receipt outbox', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-receipt-hash-whitespace-'));
  try {
    const delivery = createTaskReceiptDelivery({
      outboxPath: path.join(directory, 'task-receipts.json'),
      clock: () => 1_788_000_000_000,
      resolveTarget: () => ({ kind: 'chat', id: 'oc-chat-1' }),
      deliver: async () => ({ success: true }),
      reconcile: async () => ({ outcome: 'not_delivered' }),
    });
    const taskEffect = effect();
    assert.throws(
      () => delivery.prepare({
        effect: taskEffect,
        settlement: settlement(taskEffect, {
          payloadHash: ` ${taskEffectPayloadHash(taskEffect)}`,
        }),
        route: { adapterId: 'feishu', targetRef: 'opaque:chat-1' },
      }),
      /verified TaskEffect settlement/,
    );
    assert.deepEqual(delivery.pending(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
