import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createFeishuFinalReplyPort } from '../src/lib/feishu-final-reply-port.js';
import { assertDeliveryReceipt } from './helpers/assistant-reply-contract.js';

function contentHash(payload) {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function replyIntent({ text = '最终答案', suffix = 'answer' } = {}) {
  const payload = { format: 'text', text };
  return {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId: `reply:req-final:${suffix}`,
    requestId: 'req-final',
    traceId: 'trace-final',
    cause: { kind: 'run_terminal', eventId: 'evt-final' },
    route: { adapterId: 'feishu', targetRef: 'opaque:route-final' },
    disposition: 'send',
    payload,
    contentHash: contentHash(payload),
    idempotencyKey: `reply:req-final:${suffix}`,
  };
}

function deliveryClaim({ action = 'send', intent = replyIntent(), attemptId = 'attempt:final:1' } = {}) {
  return {
    replayed: false,
    action,
    intent,
    deliveryId: `delivery:${intent.intentId}`,
    attemptId,
    claimEpoch: 1,
    leaseOwner: 'feishu-worker-a',
    leaseToken: 'lease-final-1',
    leaseExpiresAt: 1_788_000_030,
  };
}

function silentOutcome() {
  return {
    schemaVersion: 1,
    type: 'ReplyOutcome',
    outcomeId: 'outcome:req-final',
    requestId: 'req-final',
    turnId: 'turn:req-final:1',
    traceId: 'trace-final',
    kind: 'silent',
    explicit: true,
    reason: 'no_user_visible_reply',
  };
}

test('rejects a blank visible answer before any Feishu delivery attempt', async () => {
  let deliveryCalls = 0;
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send() {
        deliveryCalls += 1;
        return { outcome: 'platform_accepted', externalRef: 'om-never' };
      },
      async reconcile() {
        throw new Error('not reached');
      },
    },
    presentation: { settlePresence() {} },
  });

  await assert.rejects(
    port.deliver(deliveryClaim({ intent: replyIntent({ text: ' \n\t', suffix: 'blank' }) })),
    error => error?.code === 'MISSING_OUTPUT',
  );
  assert.equal(deliveryCalls, 0);
});

test('explicit silent suppresses delivery and finishes presence through the frozen outcome', async () => {
  const calls = [];
  const outcome = silentOutcome();
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send() {
        calls.push('send');
      },
      async reconcile() {
        calls.push('reconcile');
      },
    },
    presentation: {
      settlePresence(input) {
        calls.push(structuredClone(input));
        return { status: 'finished', finishReason: 'explicit_silent' };
      },
    },
  });

  const result = await port.suppress(outcome);
  assert.deepEqual(calls, [{ requestId: 'req-final', signal: outcome }]);
  assert.equal(result.finishReason, 'explicit_silent');
});

test('maps a send claim to one exact platform-accepted DeliveryReceipt', async () => {
  const claim = deliveryClaim();
  const calls = [];
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send(input) {
        calls.push(structuredClone(input));
        return { outcome: 'platform_accepted', externalRef: 'om-final-1' };
      },
      async reconcile() {
        throw new Error('not reached');
      },
    },
    presentation: { settlePresence() {} },
    clock: () => Date.parse('2026-09-01T08:00:00.000Z'),
  });

  const receipt = await port.deliver(claim);
  assertDeliveryReceipt(receipt);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:attempt:final:1:platform_accepted',
    intentId: claim.intent.intentId,
    deliveryId: claim.deliveryId,
    requestId: claim.intent.requestId,
    attemptId: claim.attemptId,
    traceId: claim.intent.traceId,
    adapterId: 'feishu',
    outcome: 'platform_accepted',
    externalRef: 'om-final-1',
    observedAt: '2026-09-01T08:00:00.000Z',
  });
  assert.deepEqual(calls, [claim]);
});

test('maps an unknown send and a reconciled claim without ever retrying send', async () => {
  const intent = replyIntent({ suffix: 'unknown' });
  const sendClaim = deliveryClaim({ intent, attemptId: 'attempt:unknown:1' });
  const reconcileClaim = deliveryClaim({
    action: 'reconcile',
    intent,
    attemptId: sendClaim.attemptId,
  });
  const calls = [];
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send(input) {
        calls.push(`send:${input.attemptId}`);
        return { outcome: 'unknown', externalRef: null };
      },
      async reconcile(input) {
        calls.push(`reconcile:${input.attemptId}`);
        return { outcome: 'reconciled', externalRef: 'om-reconciled-1' };
      },
    },
    presentation: { settlePresence() {} },
    clock: () => Date.parse('2026-09-01T08:01:00.000Z'),
  });

  assert.deepEqual(await port.deliver(sendClaim), {
    schemaVersion: 1,
    type: 'DeliveryReceipt',
    receiptId: 'receipt:attempt:unknown:1:unknown',
    intentId: intent.intentId,
    deliveryId: sendClaim.deliveryId,
    requestId: intent.requestId,
    attemptId: sendClaim.attemptId,
    traceId: intent.traceId,
    adapterId: 'feishu',
    outcome: 'unknown',
    externalRef: null,
    observedAt: '2026-09-01T08:01:00.000Z',
    nextAction: 'reconcile_before_retry',
  });
  const reconciled = await port.deliver(reconcileClaim);
  assertDeliveryReceipt(reconciled);
  assert.equal(reconciled.outcome, 'reconciled');
  assert.equal(reconciled.externalRef, 'om-reconciled-1');
  assert.equal(reconciled.attemptId, sendClaim.attemptId);
  assert.deepEqual(calls, ['send:attempt:unknown:1', 'reconcile:attempt:unknown:1']);
});

test('maps an explicit delivery rejection without changing the final intent identity', async () => {
  const claim = deliveryClaim({
    intent: replyIntent({ suffix: 'rejected' }),
    attemptId: 'attempt:rejected:1',
  });
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send() {
        return {
          outcome: 'rejected',
          externalRef: null,
          errorCode: 'FEISHU_CARD_REJECTED',
          retryable: true,
        };
      },
      async reconcile() {
        throw new Error('not reached');
      },
    },
    presentation: { settlePresence() {} },
    clock: () => Date.parse('2026-09-01T08:02:00.000Z'),
  });

  const receipt = await port.deliver(claim);
  assertDeliveryReceipt(receipt);
  assert.equal(receipt.intentId, claim.intent.intentId);
  assert.equal(receipt.deliveryId, claim.deliveryId);
  assert.equal(receipt.attemptId, claim.attemptId);
  assert.equal(receipt.outcome, 'rejected');
  assert.equal(receipt.externalRef, null);
  assert.equal(receipt.errorCode, 'FEISHU_CARD_REJECTED');
  assert.equal(receipt.retryable, true);
});

test('only a frozen accepted or unpresentable DeliverySettlement can finish presence', async () => {
  const calls = [];
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send() { throw new Error('not reached'); },
      async reconcile() { throw new Error('not reached'); },
    },
    presentation: {
      settlePresence(input) {
        calls.push(structuredClone(input));
        return { status: 'finished' };
      },
    },
  });
  const settlement = {
    schemaVersion: 1,
    type: 'DeliverySettlement',
    settlementId: 'settlement:delivery:reply:req-final:answer:accepted',
    intentId: 'reply:req-final:answer',
    deliveryId: 'delivery:reply:req-final:answer',
    requestId: 'req-final',
    traceId: 'trace-final',
    adapterId: 'feishu',
    state: 'accepted',
    basis: 'platform_accepted',
    presented: true,
  };

  await port.settle(settlement);
  assert.deepEqual(calls, [{ requestId: 'req-final', signal: settlement }]);
  assert.throws(
    () => port.settle({ ...settlement, state: 'accepted', basis: 'retry_exhausted', presented: false }),
    error => error?.code === 'UNAUTHORIZED_PRESENCE_SETTLEMENT',
  );
  assert.throws(
    () => port.settle({ ...settlement, adapterId: 'hxa-connect' }),
    error => error?.code === 'IDENTITY_CONFLICT',
  );
  assert.equal(calls.length, 1);
});

test('projection and presence failures cannot block creation of the final delivery receipt', async () => {
  const claim = deliveryClaim({ intent: replyIntent({ suffix: 'projection-isolated' }) });
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send() {
        return { outcome: 'platform_accepted', externalRef: 'om-isolated' };
      },
      async reconcile() { throw new Error('not reached'); },
    },
    presentation: {
      settlePresence() {
        throw new Error('CardKit and presence projection are unavailable');
      },
    },
    clock: () => Date.parse('2026-09-01T08:03:00.000Z'),
  });

  const receipt = await port.deliver(claim);
  assert.equal(receipt.outcome, 'platform_accepted');
  assert.equal(receipt.externalRef, 'om-isolated');
});

test('replaying the same leased claim returns the identical receipt without a duplicate attempt', async () => {
  let attempts = 0;
  let now = Date.parse('2026-09-01T08:04:00.000Z');
  const claim = deliveryClaim({ intent: replyIntent({ suffix: 'claim-replay' }) });
  const port = createFeishuFinalReplyPort({
    delivery: {
      async send() {
        attempts += 1;
        return { outcome: 'unknown', externalRef: null };
      },
      async reconcile() { throw new Error('not reached'); },
    },
    presentation: { settlePresence() {} },
    clock: () => now,
  });

  const first = await port.deliver(claim);
  now += 60_000;
  const replay = await port.deliver({ ...claim, replayed: true });
  assert.strictEqual(replay, first);
  assert.equal(replay.observedAt, '2026-09-01T08:04:00.000Z');
  assert.equal(attempts, 1);
});
