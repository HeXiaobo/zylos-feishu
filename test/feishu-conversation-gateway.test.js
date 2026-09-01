import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInMemoryCoreMessageIntake } from '../src/lib/core-message-intake-port.js';
import { createFeishuConversationGateway } from '../src/lib/feishu-conversation-gateway.js';
import { normalizeFeishuInboundMessage } from '../src/lib/feishu-inbound-normalizer.js';
import { openInboundEventInbox } from '../src/lib/inbound-event-inbox.js';
import { normalizeInboundMessageEvent } from '../src/lib/inbound-message-event.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function assertPending(promise) {
  const outcome = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(outcome, 'pending');
}

function event({ eventId, messageId = 'om-1', chatId = 'oc-1', text = 'hello' }) {
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

test('WebSocket and Webhook copies return one request and one downstream accepted effect', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-dedupe-'));
  const core = createInMemoryCoreMessageIntake();
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake: core,
    workerId: 'gateway-test',
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  try {
    const [websocket, webhook] = await Promise.all([
      gateway.accept(event({ eventId: 'evt-ws' })),
      gateway.accept(event({ eventId: 'evt-webhook' })),
    ]);

    assert.deepEqual(new Set([websocket.status, webhook.status]), new Set(['accepted', 'duplicate']));
    assert.deepEqual(websocket.receipt, webhook.receipt);
    assert.equal(websocket.receipt.laneSequence, 1);
    assert.equal(core.acceptedEffects().length, 1);
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a slow Core accept in one lane does not block another lane', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-cross-lane-'));
  const durableCore = createInMemoryCoreMessageIntake();
  let releaseSlowAccept;
  const slowAccept = new Promise((resolve) => { releaseSlowAccept = resolve; });
  const coreIntake = {
    async accept(message, acceptance) {
      if (message.source.messageId === 'om-slow') await slowAccept;
      return durableCore.accept(message, acceptance);
    },
  };
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake,
    workerId: 'gateway-cross-lane',
    concurrency: 2,
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  try {
    const first = gateway.accept(event({
      eventId: 'evt-slow',
      messageId: 'om-slow',
      chatId: 'oc-slow',
    }));
    const second = gateway.accept(event({
      eventId: 'evt-fast',
      messageId: 'om-fast',
      chatId: 'oc-fast',
    }));
    const fastReceipt = await Promise.race([
      second,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('other Conversation Lane was blocked')),
        500,
      )),
    ]);

    assert.equal(fastReceipt.receipt.laneSequence, 1);
    assert.match(fastReceipt.receipt.conversationLaneKey, /oc-fast/);
    assert.equal(durableCore.acceptedEffects().length, 1);
    releaseSlowAccept();
    await first;
  } finally {
    releaseSlowAccept();
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('message two is durably accepted while message one Runtime completion is still pending', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-runtime-pending-'));
  const durableCore = createInMemoryCoreMessageIntake();
  let finishRuntime;
  let runtimeFinished = false;
  const runtimeCompletion = new Promise((resolve) => { finishRuntime = resolve; });
  runtimeCompletion.then(() => { runtimeFinished = true; });
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake: durableCore,
    workerId: 'gateway-runtime-pending',
    concurrency: 2,
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  try {
    const first = await gateway.accept(event({
      eventId: 'evt-runtime-1',
      messageId: 'om-runtime-1',
      chatId: 'oc-runtime-1',
    }));
    assert.equal(first.receipt.type, 'MessageAccepted');
    const second = await gateway.accept(event({
      eventId: 'evt-runtime-2',
      messageId: 'om-runtime-2',
      chatId: 'oc-runtime-2',
    }));

    assert.equal(second.receipt.type, 'MessageAccepted');
    assert.equal(runtimeFinished, false);
    assert.equal(durableCore.acceptedEffects().length, 2);
  } finally {
    finishRuntime();
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('same-lane messages reach Core in laneSequence order', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-same-lane-'));
  const durableCore = createInMemoryCoreMessageIntake();
  const started = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const coreIntake = {
    async accept(message, acceptance) {
      started.push({ messageId: message.source.messageId, laneSequence: acceptance.laneSequence });
      if (message.source.messageId === 'om-1') await firstGate;
      return durableCore.accept(message, acceptance);
    },
  };
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake,
    workerId: 'gateway-same-lane',
    concurrency: 2,
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  try {
    const first = gateway.accept(event({ eventId: 'evt-1', messageId: 'om-1' }));
    const second = gateway.accept(event({ eventId: 'evt-2', messageId: 'om-2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(started, [{ messageId: 'om-1', laneSequence: 1 }]);
    releaseFirst();
    const receipts = await Promise.all([first, second]);
    assert.deepEqual(started, [
      { messageId: 'om-1', laneSequence: 1 },
      { messageId: 'om-2', laneSequence: 2 },
    ]);
    assert.deepEqual(receipts.map((result) => result.receipt.laneSequence), [1, 2]);
  } finally {
    releaseFirst();
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('authorization happens before durable receipt and payload drift fails closed', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-auth-'));
  const core = createInMemoryCoreMessageIntake();
  let allowed = false;
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_app_a',
    authorize: async () => allowed,
    coreIntake: core,
    workerId: 'gateway-auth',
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  try {
    assert.deepEqual(await gateway.accept(event({ eventId: 'evt-auth' })), {
      status: 'ignored',
      reason: 'unauthorized',
    });
    assert.deepEqual(await gateway.recover(), {
      claimed: 0,
      committed: 0,
      failed: 0,
      deadLettered: 0,
    });
    allowed = true;
    await gateway.accept(event({ eventId: 'evt-auth' }));
    await assert.rejects(
      gateway.accept(event({ eventId: 'evt-auth-replay', text: 'changed' })),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(core.acceptedEffects().length, 1);
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('p2p, group chat, reply-tree root fallback, and topic thread produce durable lane receipts', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-lane-vectors-'));
  const core = createInMemoryCoreMessageIntake();
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake: core,
    workerId: 'gateway-lane-vectors',
    concurrency: 4,
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  const vector = (eventId, messageId, message) => ({
    ...event({ eventId, messageId, chatId: message.chat_id }),
    message: {
      ...event({ eventId, messageId, chatId: message.chat_id }).message,
      ...message,
    },
  });
  try {
    const results = await Promise.all([
      gateway.accept(vector('evt-p2p', 'om-p2p', {
        chat_id: 'oc-p2p', chat_type: 'p2p',
      })),
      gateway.accept(vector('evt-group', 'om-group', {
        chat_id: 'oc-group', chat_type: 'group',
      })),
      gateway.accept(vector('evt-reply-1', 'om-reply-1', {
        chat_id: 'oc-group', chat_type: 'group', root_id: 'om-root', parent_id: 'om-parent-1',
      })),
      gateway.accept(vector('evt-reply-2', 'om-reply-2', {
        chat_id: 'oc-group', chat_type: 'group', root_id: 'om-root', parent_id: 'om-parent-2',
      })),
      gateway.accept(vector('evt-topic', 'om-topic', {
        chat_id: 'oc-topic', chat_type: 'topic_group', thread_id: 'omt-thread', root_id: 'om-topic-root',
      })),
    ]);

    assert.deepEqual(results.map((result) => ({
      lane: result.receipt.conversationLaneKey,
      sequence: result.receipt.laneSequence,
    })), [
      { lane: 'feishu:cli_app_a:p2p:oc-p2p:chat', sequence: 1 },
      { lane: 'feishu:cli_app_a:group:oc-group:chat', sequence: 1 },
      { lane: 'feishu:cli_app_a:group:oc-group:reply:om-root', sequence: 1 },
      { lane: 'feishu:cli_app_a:group:oc-group:reply:om-root', sequence: 2 },
      { lane: 'feishu:cli_app_a:topic_group:oc-topic:thread:omt-thread', sequence: 1 },
    ]);
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('close drains an accept registered before authorization and rejects later operations', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-close-auth-'));
  const dbPath = path.join(directory, 'inbound.db');
  const raw = event({ eventId: 'evt-close-auth', messageId: 'om-close-auth' });
  const authorizationEntered = deferred();
  const releaseAuthorization = deferred();
  const core = createInMemoryCoreMessageIntake();
  const gateway = createFeishuConversationGateway({
    dbPath,
    accountRef: 'cli_app_a',
    authorize: async () => {
      authorizationEntered.resolve();
      await releaseAuthorization.promise;
      return true;
    },
    coreIntake: core,
    workerId: 'gateway-close-auth',
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  let accepted;
  let closing;
  try {
    accepted = gateway.accept(raw);
    await authorizationEntered.promise;
    closing = gateway.close();
    assert.strictEqual(gateway.close(), closing);
    await assertPending(closing);
    await assert.rejects(
      gateway.accept(event({ eventId: 'evt-after-close', messageId: 'om-after-close' })),
      (error) => error.code === 'GATEWAY_DRAINING',
    );
    await assert.rejects(
      gateway.recover(),
      (error) => error.code === 'GATEWAY_DRAINING',
    );

    releaseAuthorization.resolve();
    const result = await accepted;
    assert.equal(result.status, 'accepted');
    await closing;
    assert.equal(core.acceptedEffects().length, 1);

    const reopened = createFeishuConversationGateway({
      dbPath,
      accountRef: 'cli_app_a',
      authorize: async () => true,
      coreIntake: core,
      workerId: 'gateway-close-auth-restart',
      clock: () => 1_788_220_800_001,
      pollIntervalMs: 1,
    });
    try {
      const replay = await reopened.accept(raw);
      assert.equal(replay.status, 'duplicate');
      assert.equal(core.acceptedEffects().length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    releaseAuthorization.resolve();
    await Promise.allSettled([accepted, closing, gateway.close()].filter(Boolean));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('close reports a draining recover failure and restart safely retries ambiguous Core accept', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-close-recover-'));
  const dbPath = path.join(directory, 'inbound.db');
  const raw = event({ eventId: 'evt-close-recover', messageId: 'om-close-recover' });
  const normalized = normalizeFeishuInboundMessage(raw, { accountRef: 'cli_app_a' });
  const seed = openInboundEventInbox({
    dbPath,
    clock: () => 1_788_220_800_000,
    maxAttempts: 3,
  });
  seed.receive({
    adapterId: normalized.adapterId,
    accountRef: normalized.accountRef,
    eventType: normalized.eventType,
    eventId: normalized.eventId,
    messageId: normalized.messageId,
    payload: normalized.message,
    payloadHash: normalized.payloadHash,
    conversationLaneKey: normalized.conversationLaneKey,
    sourceOrder: normalized.sourceOrder,
  });
  seed.close();

  const coreEntered = deferred();
  const releaseCore = deferred();
  const durableCore = createInMemoryCoreMessageIntake();
  const gateway = createFeishuConversationGateway({
    dbPath,
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake: {
      async accept(message, acceptance) {
        await durableCore.accept(message, acceptance);
        coreEntered.resolve();
        await releaseCore.promise;
        throw Object.assign(new Error('ambiguous Core response'), { retryable: true });
      },
    },
    workerId: 'gateway-close-recover',
    clock: () => 1_788_220_800_000,
    maxAttempts: 3,
    pollIntervalMs: 1,
    baseRetryDelayMs: 1,
    maxRetryDelayMs: 1,
  });
  let recovering;
  let closing;
  try {
    recovering = gateway.recover();
    await coreEntered.promise;
    closing = gateway.close();
    assert.strictEqual(gateway.close(), closing);
    await assertPending(closing);
    releaseCore.resolve();

    assert.deepEqual(await recovering, {
      claimed: 1,
      committed: 0,
      failed: 1,
      deadLettered: 0,
    });
    await assert.rejects(
      closing,
      (error) => error.code === 'GATEWAY_DRAIN_FAILED'
        && error.cause?.message === 'gateway processing left retryable or dead-lettered messages',
    );
    assert.equal(durableCore.acceptedEffects().length, 1);

    const reopened = createFeishuConversationGateway({
      dbPath,
      accountRef: 'cli_app_a',
      authorize: async () => true,
      coreIntake: durableCore,
      workerId: 'gateway-close-recover-restart',
      clock: () => 1_788_220_800_001,
      maxAttempts: 3,
      pollIntervalMs: 1,
      baseRetryDelayMs: 1,
      maxRetryDelayMs: 1,
    });
    try {
      assert.deepEqual(await reopened.recover(), {
        claimed: 1,
        committed: 1,
        failed: 0,
        deadLettered: 0,
      });
      assert.equal(durableCore.acceptedEffects().length, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    releaseCore.resolve();
    await Promise.allSettled([recovering, closing, gateway.close()].filter(Boolean));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fast accept observes its own durable receipt while an older cross-lane batch item is blocked', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-fast-handoff-'));
  const dbPath = path.join(directory, 'inbound.db');
  const slowRaw = event({ eventId: 'evt-seeded-slow', messageId: 'om-seeded-slow', chatId: 'oc-seeded-slow' });
  const fastRaw = event({ eventId: 'evt-new-fast', messageId: 'om-new-fast', chatId: 'oc-new-fast' });
  const slow = normalizeFeishuInboundMessage(slowRaw, { accountRef: 'cli_app_a' });
  const seed = openInboundEventInbox({ dbPath, clock: () => 1_788_220_800_000 });
  seed.receive({
    adapterId: slow.adapterId,
    accountRef: slow.accountRef,
    eventType: slow.eventType,
    eventId: slow.eventId,
    messageId: slow.messageId,
    payload: slow.message,
    payloadHash: slow.payloadHash,
    conversationLaneKey: slow.conversationLaneKey,
    sourceOrder: slow.sourceOrder,
  });
  seed.close();

  const slowEntered = deferred();
  const releaseSlow = deferred();
  const durableCore = createInMemoryCoreMessageIntake();
  const gateway = createFeishuConversationGateway({
    dbPath,
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake: {
      async accept(message, acceptance) {
        if (message.source.messageId === slow.messageId) {
          slowEntered.resolve();
          await releaseSlow.promise;
        }
        return durableCore.accept(message, acceptance);
      },
    },
    workerId: 'gateway-fast-handoff',
    concurrency: 2,
    clock: () => 1_788_220_800_000,
    pollIntervalMs: 1,
  });
  let fastAccept;
  let recovering;
  try {
    recovering = gateway.recover();
    await slowEntered.promise;
    fastAccept = gateway.accept(fastRaw);
    const result = await Promise.race([
      fastAccept,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('fast durable receipt waited for another lane batch item')),
        500,
      )),
    ]);
    assert.equal(result.receipt.conversationLaneKey, 'feishu:cli_app_a:group:oc-new-fast:chat');
    assert.equal(durableCore.acceptedEffects().length, 1);
    releaseSlow.resolve();
    await recovering;
    assert.equal(durableCore.acceptedEffects().length, 2);
  } finally {
    releaseSlow.resolve();
    await Promise.allSettled([fastAccept, recovering, gateway.close()].filter(Boolean));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recover upgrades a legacy pending payload without waiting for a new platform replay', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-gateway-legacy-recover-'));
  const dbPath = path.join(directory, 'inbound.db');
  const raw = event({ eventId: 'evt-legacy-pending', messageId: 'om-legacy-pending' });
  const legacyEnvelope = normalizeInboundMessageEvent(raw);
  const seed = openInboundEventInbox({ dbPath, clock: () => 1_788_220_800_000 });
  seed.receive({
    eventId: legacyEnvelope.eventId,
    messageId: legacyEnvelope.messageId,
    payload: legacyEnvelope.payload,
  });
  seed.close();

  const core = createInMemoryCoreMessageIntake();
  const gateway = createFeishuConversationGateway({
    dbPath,
    accountRef: 'cli_app_a',
    authorize: async () => true,
    coreIntake: core,
    workerId: 'gateway-legacy-recover',
    clock: () => 1_788_220_800_001,
    pollIntervalMs: 1,
  });
  try {
    assert.deepEqual(await gateway.recover(), {
      claimed: 1,
      committed: 1,
      failed: 0,
      deadLettered: 0,
    });
    assert.equal(core.acceptedEffects().length, 1);
    const replay = await gateway.accept(raw);
    assert.equal(replay.status, 'duplicate');
    assert.equal(core.acceptedEffects().length, 1);
  } finally {
    await gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
