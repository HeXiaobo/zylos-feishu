import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInMemoryCoreMessageIntake } from '../src/lib/core-message-intake-port.js';
import {
  createFeishuReplyComposition,
  openFeishuReplyComposition,
  replyRefactorEnabled,
  resolveFeishuRouteTarget,
} from '../src/lib/feishu-reply-composition.js';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function event({
  eventId = 'evt-1',
  messageId = 'om-1',
  chatId = 'oc-1',
  text = 'hello',
} = {}) {
  return {
    event_id: eventId,
    create_time: '1788220800000',
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: 'ou-1' }, tenant_key: 'tenant-1' },
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function replyIntent(requestId, targetRef, text = 'final answer') {
  const payload = { format: 'text', text };
  const intentId = `reply:${requestId}:route-a`;
  return {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId,
    requestId,
    traceId: `trace:${requestId}`,
    cause: { kind: 'run_terminal', eventId: `event:${requestId}:completed` },
    route: { adapterId: 'feishu', targetRef },
    disposition: 'send',
    payload,
    contentHash: `sha256:${createHash('sha256')
      .update(JSON.stringify(canonicalize(payload)))
      .digest('hex')}`,
    idempotencyKey: intentId,
  };
}

function deliveryClaim(intent, action = 'send', epoch = 1) {
  return {
    replayed: false,
    action,
    intent,
    deliveryId: `delivery:${intent.intentId}`,
    attemptId: `attempt:${intent.intentId}:${epoch}`,
    claimEpoch: epoch,
    leaseOwner: 'core-delivery-a',
    leaseToken: `lease:${epoch}`,
    leaseExpiresAt: 1_788_220_830_000 + epoch,
  };
}

function deliverySettlement(intent, basis = 'platform_accepted') {
  return {
    schemaVersion: 1,
    type: 'DeliverySettlement',
    settlementId: `settlement:${intent.intentId}:accepted`,
    intentId: intent.intentId,
    deliveryId: `delivery:${intent.intentId}`,
    requestId: intent.requestId,
    traceId: intent.traceId,
    adapterId: 'feishu',
    state: 'accepted',
    basis,
    presented: true,
  };
}

function createReactionPort(calls) {
  return {
    async add(effect) {
      calls.push({ kind: 'add', effect: structuredClone(effect) });
      return { outcome: 'platform_accepted', reactionId: `reaction:${effect.requestId}` };
    },
    async remove(effect) {
      calls.push({ kind: 'remove', effect: structuredClone(effect) });
      return { outcome: 'platform_accepted' };
    },
    async reconcile(effect) {
      calls.push({ kind: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'unknown' };
    },
  };
}

function createCardPort(calls, { fail = false } = {}) {
  return {
    async apply(operation) {
      calls.push({ kind: 'apply', operation: structuredClone(operation) });
      if (fail) throw new Error('CardKit unavailable');
      return {
        outcome: 'platform_accepted',
        cardId: operation.cardId || `card:${operation.requestId}`,
      };
    },
    async reconcile(operation) {
      calls.push({ kind: 'reconcile', operation: structuredClone(operation) });
      return fail
        ? { outcome: 'unknown' }
        : { outcome: 'reconciled', cardId: operation.cardId || `card:${operation.requestId}` };
    },
  };
}

test('feature flag preserves the complete legacy rollback path', async () => {
  assert.equal(replyRefactorEnabled({ C4_REPLY_REFACTOR_V1: 'enabled' }), true);
  assert.equal(replyRefactorEnabled({ C4_REPLY_REFACTOR_V1: '0' }), false);
  const calls = [];
  const legacy = {
    async acceptMessage(input) { calls.push(['accept', input]); return { legacy: true }; },
    async recover() { calls.push(['recover']); return { legacy: true }; },
    async close() { calls.push(['close']); },
  };
  const composition = createFeishuReplyComposition({ enabled: false, legacy });

  assert.equal(composition.enabled, false);
  assert.deepEqual(await composition.acceptMessage({ old: 'event' }), { legacy: true });
  assert.deepEqual(await composition.recover(), { legacy: true });
  await composition.close();
  assert.deepEqual(calls.map(([name]) => name), ['accept', 'recover', 'close']);
});

test('opaque Feishu route facts resolve without shifting DM or topic replies', () => {
  const encode = (prefix, route) => `${prefix}:v1:${Buffer
    .from(JSON.stringify(route))
    .toString('base64url')}`;
  assert.deepEqual(resolveFeishuRouteTarget(encode('feishu-route', {
    chatType: 'p2p', chatId: 'oc-dm', messageId: 'om-dm', rootId: null, parentId: null,
  })), { chatId: 'oc-dm', chatType: 'p2p', replyToMessageId: null });
  assert.deepEqual(resolveFeishuRouteTarget(encode('feishu-source', {
    chatType: 'topic_group', chatId: 'oc-topic', messageId: 'om-topic',
    rootId: 'om-root', parentId: 'om-parent',
  })), { chatId: 'oc-topic', chatType: 'group', replyToMessageId: 'om-parent' });
});

test('durable lanes accept concurrently and restart reuses one reply handle and presence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-composition-restart-'));
  const dbPath = path.join(directory, 'feishu.db');
  const reactions = [];
  const cards = [];
  const durableCore = createInMemoryCoreMessageIntake();
  const slow = deferred();
  const coreIntake = {
    async accept(message, acceptance) {
      if (message.source.messageId === 'om-slow') await slow.promise;
      return durableCore.accept(message, acceptance);
    },
  };
  let first;
  let reopened;
  try {
    first = openFeishuReplyComposition({
      inboundDbPath: dbPath,
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      coreIntake,
      reactionPort: createReactionPort(reactions),
      cardPort: createCardPort(cards),
      delivery: {
        send: async () => ({ outcome: 'platform_accepted', externalRef: 'om-final' }),
        reconcile: async () => ({ outcome: 'reconciled', externalRef: 'om-final' }),
      },
      workerId: 'composition-a',
      clock: () => 1_788_220_800_000,
      pollIntervalMs: 1,
      concurrency: 2,
    });

    const pendingSlow = first.acceptMessage(event({
      eventId: 'evt-slow', messageId: 'om-slow', chatId: 'oc-slow',
    }));
    const fast = await first.acceptMessage(event({
      eventId: 'evt-fast', messageId: 'om-fast', chatId: 'oc-fast',
    }));
    assert.equal(fast.receipt.type, 'MessageAccepted');
    assert.equal(fast.presentation.created, true);
    slow.resolve();
    const slowResult = await pendingSlow;
    assert.notEqual(fast.receipt.requestId, slowResult.receipt.requestId);

    await first.maintain();
    assert.equal(reactions.filter(call => call.kind === 'add').length, 2);
    const fastSnapshot = first.inspect(fast.receipt.requestId);
    assert.equal(fastSnapshot.presence.status, 'active');
    await first.close();
    first = null;

    reopened = openFeishuReplyComposition({
      inboundDbPath: dbPath,
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      coreIntake: createInMemoryCoreMessageIntake(),
      reactionPort: createReactionPort(reactions),
      cardPort: createCardPort(cards),
      delivery: {
        send: async () => ({ outcome: 'platform_accepted', externalRef: 'om-final' }),
        reconcile: async () => ({ outcome: 'reconciled', externalRef: 'om-final' }),
      },
      workerId: 'composition-b',
      clock: () => 1_788_220_801_000,
      pollIntervalMs: 1,
      concurrency: 2,
    });
    await reopened.recover();
    const duplicate = await reopened.acceptMessage(event({
      eventId: 'evt-fast-copy', messageId: 'om-fast', chatId: 'oc-fast',
    }));
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.receipt.requestId, fast.receipt.requestId);
    assert.equal(duplicate.presentation.created, false);
    assert.equal(reactions.filter(call => call.kind === 'add').length, 2);
  } finally {
    slow.resolve();
    await first?.close();
    await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('two messages in one chat keep independent reactions until each reply settles', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-composition-one-to-many-'));
  const reactions = [];
  let composition;
  try {
    composition = openFeishuReplyComposition({
      inboundDbPath: path.join(directory, 'inbound.db'),
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      coreIntake: createInMemoryCoreMessageIntake(),
      reactionPort: createReactionPort(reactions),
      cardPort: createCardPort([]),
      delivery: {
        send: async ({ intent }) => ({
          outcome: 'platform_accepted',
          externalRef: `reply:${intent.requestId}`,
        }),
        reconcile: async () => ({ outcome: 'unknown', externalRef: null }),
      },
      workerId: 'composition-one-to-many',
      clock: () => 1_788_220_800_000,
      pollIntervalMs: 1,
      concurrency: 2,
    });

    const first = await composition.acceptMessage(event({
      eventId: 'evt-shared-first',
      messageId: 'om-shared-first',
      chatId: 'oc-shared',
      text: '事实看到了吗',
    }));
    const second = await composition.acceptMessage(event({
      eventId: 'evt-shared-second',
      messageId: 'om-shared-second',
      chatId: 'oc-shared',
      text: '实时看到了吗',
    }));
    await composition.maintain();

    const addedMessageIds = reactions
      .filter(call => call.kind === 'add')
      .map(call => call.effect.sourceMessageId)
      .sort();
    assert.deepEqual(addedMessageIds, ['om-shared-first', 'om-shared-second']);
    assert.equal(composition.inspect(first.receipt.requestId).presence.status, 'active');
    assert.equal(composition.inspect(second.receipt.requestId).presence.status, 'active');

    const firstTarget = composition.inspect(first.receipt.requestId).handle.route.targetRef;
    const firstIntent = replyIntent(first.receipt.requestId, firstTarget, '第一条回答');
    await composition.deliverFinal(deliveryClaim(firstIntent));
    composition.settleFinal(deliverySettlement(firstIntent));
    await composition.maintain();

    assert.equal(composition.inspect(first.receipt.requestId).presence.status, 'finished');
    assert.equal(composition.inspect(second.receipt.requestId).presence.status, 'active');
    assert.deepEqual(
      reactions.filter(call => call.kind === 'remove').map(call => call.effect.sourceMessageId),
      ['om-shared-first'],
    );

    const secondTarget = composition.inspect(second.receipt.requestId).handle.route.targetRef;
    const secondIntent = replyIntent(second.receipt.requestId, secondTarget, '第二条回答');
    await composition.deliverFinal(deliveryClaim(secondIntent));
    composition.settleFinal(deliverySettlement(secondIntent));
    await composition.maintain();
    assert.equal(composition.inspect(second.receipt.requestId).presence.status, 'finished');
  } finally {
    await composition?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('card progress never settles presence, final delivery survives projection failure, and unknown reconciles first', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-composition-terminal-'));
  const reactions = [];
  const cards = [];
  const deliveryCalls = [];
  let composition;
  try {
    composition = openFeishuReplyComposition({
      inboundDbPath: path.join(directory, 'inbound.db'),
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      coreIntake: createInMemoryCoreMessageIntake(),
      reactionPort: createReactionPort(reactions),
      cardPort: createCardPort(cards, { fail: true }),
      delivery: {
        async send() {
          deliveryCalls.push('send');
          return { outcome: 'unknown', externalRef: null };
        },
        async reconcile() {
          deliveryCalls.push('reconcile');
          return { outcome: 'reconciled', externalRef: 'om-reconciled' };
        },
      },
      workerId: 'composition-terminal',
      clock: () => 1_788_220_800_000,
      pollIntervalMs: 1,
    });
    const accepted = await composition.acceptMessage(event());
    const requestId = accepted.receipt.requestId;
    await composition.maintain();

    composition.recordProgress({
      schemaVersion: 1,
      type: 'RunQueued',
      eventId: `event:${requestId}:queued`,
      idempotencyKey: `run:${requestId}:queued`,
      requestId,
      turnId: `turn:${requestId}:1`,
      generation: 1,
      sequence: 1,
      traceId: `trace:${requestId}`,
      causationId: `cause:${requestId}`,
      producer: 'core:runtime-lane',
      payload: { priority: 2 },
    });
    await composition.maintain();
    assert.equal(composition.inspect(requestId).presence.status, 'active');
    assert.equal(reactions.some(call => call.kind === 'remove'), false);

    const targetRef = composition.inspect(requestId).handle.route.targetRef;
    const intent = replyIntent(requestId, targetRef);
    const unknown = await composition.deliverFinal(deliveryClaim(intent));
    assert.equal(unknown.outcome, 'unknown');
    assert.equal(composition.inspect(requestId).presence.status, 'active');
    const reconciled = await composition.deliverFinal(deliveryClaim(intent, 'reconcile', 2));
    assert.equal(reconciled.outcome, 'reconciled');
    assert.deepEqual(deliveryCalls, ['send', 'reconcile']);
    assert.equal(composition.inspect(requestId).presence.status, 'active');

    composition.settleFinal(deliverySettlement(intent, 'reconciled'));
    await composition.maintain();
    assert.equal(composition.inspect(requestId).presence.status, 'finished');
    assert.equal(reactions.filter(call => call.kind === 'remove').length, 1);

    const blank = replyIntent(requestId, targetRef, ' \u200b ');
    await assert.rejects(
      composition.deliverFinal(deliveryClaim(blank, 'send', 3)),
      error => error?.code === 'MISSING_OUTPUT',
    );
  } finally {
    await composition?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('TaskEffect and NativeTask backflow stay on independent composition ports', async () => {
  const calls = [];
  const composition = createFeishuReplyComposition({
    enabled: true,
    accountRef: 'cli_app_a',
    gateway: {
      accept: async () => ({ status: 'ignored', reason: 'test' }),
      recover: async () => ({ claimed: 0 }),
      close: async () => {},
    },
    presentation: {
      accept: async () => ({}),
      recordProgress: () => ({}),
      observeDeliveryReceipt: () => ({}),
      reconcile: async () => ({}),
      inspect: () => ({}),
      close: () => {},
    },
    finalReply: {
      deliver: async value => value,
      settle: value => value,
      suppress: value => value,
    },
    taskEffects: {
      async run() { calls.push('task-effect'); return { acknowledged: 1 }; },
      async recover() { calls.push('task-effect-recover'); },
    },
    nativeTasks: {
      ingest(value) { calls.push(`native-ingest:${value.eventId}`); return { status: 'queued' }; },
      async drain() { calls.push('native-drain'); return { applied: 1 }; },
      async recover() { calls.push('native-recover'); },
    },
  });
  assert.deepEqual(await composition.runTaskEffects(), { acknowledged: 1 });
  assert.deepEqual(composition.ingestNativeTask({ eventId: 'native-1' }), { status: 'queued' });
  assert.deepEqual(await composition.drainNativeTasks(), { applied: 1 });
  await composition.recover();
  assert.deepEqual(calls, [
    'task-effect',
    'native-ingest:native-1',
    'native-drain',
    'task-effect-recover',
    'native-recover',
  ]);
  await composition.close();
});
