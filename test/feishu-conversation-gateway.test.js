import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInMemoryCoreMessageIntake } from '../src/lib/core-message-intake-port.js';
import { createFeishuConversationGateway } from '../src/lib/feishu-conversation-gateway.js';

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
