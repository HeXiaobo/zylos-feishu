import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInMemoryCoreMessageIntake } from '../src/lib/core-message-intake-port.js';
import { normalizeFeishuInboundMessage } from '../src/lib/feishu-inbound-normalizer.js';
import { openInboundEventInbox } from '../src/lib/inbound-event-inbox.js';

function event({ eventId, messageId = 'om-logical-1', text = 'hello' }) {
  return {
    event_id: eventId,
    create_time: '1788220800000',
    message: {
      message_id: messageId,
      chat_id: 'oc-1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
    sender: { sender_id: { open_id: 'ou-1' }, tenant_key: 'tenant-1' },
  };
}

test('Core intake fake applies one durable effect for logical replay and rejects hash drift', async () => {
  const core = createInMemoryCoreMessageIntake();
  const websocket = normalizeFeishuInboundMessage(event({ eventId: 'evt-ws' }), {
    accountRef: 'cli_app_a',
  });
  const webhook = normalizeFeishuInboundMessage(event({ eventId: 'evt-webhook' }), {
    accountRef: 'cli_app_a',
  });
  const acceptance = {
    conversationLaneKey: websocket.conversationLaneKey,
    laneSequence: 1,
    sourceOrder: null,
  };

  const first = await core.accept(websocket.message, acceptance);
  const replay = await core.accept(webhook.message, acceptance);
  assert.deepEqual(replay, first);
  assert.equal(first.type, 'MessageAccepted');
  assert.equal(first.conversationLaneKey, websocket.conversationLaneKey);
  assert.equal(first.laneSequence, 1);
  assert.equal(core.acceptedEffects().length, 1);

  const changed = normalizeFeishuInboundMessage(event({ eventId: 'evt-changed', text: 'changed' }), {
    accountRef: 'cli_app_a',
  });
  await assert.rejects(
    core.accept(changed.message, acceptance),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('crash, lease expiry, restart, and concurrent claim preserve one effect and contiguous sequence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-intake-recovery-'));
  const dbPath = path.join(directory, 'inbound.db');
  const core = createInMemoryCoreMessageIntake();
  let now = 1_788_220_800_000;
  const receive = (inbox, normalized) => inbox.receive({
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
  try {
    const firstMessage = normalizeFeishuInboundMessage(event({ eventId: 'evt-first' }), {
      accountRef: 'cli_app_a',
    });
    const beforeCrash = openInboundEventInbox({ dbPath, clock: () => now, maxAttempts: 3 });
    assert.equal(receive(beforeCrash, firstMessage).entry.laneSequence, 1);
    const [crashedClaim] = beforeCrash.claim({ workerId: 'crashed', leaseMs: 100 });
    const firstReceipt = await core.accept(crashedClaim.payload, {
      conversationLaneKey: crashedClaim.conversationLaneKey,
      laneSequence: crashedClaim.laneSequence,
      sourceOrder: crashedClaim.sourceOrder,
    });
    assert.equal(core.acceptedEffects().length, 1);
    beforeCrash.close();

    now += 100;
    const recovered = openInboundEventInbox({ dbPath, clock: () => now, maxAttempts: 3 });
    const [replayedClaim] = recovered.claim({ workerId: 'recovered', leaseMs: 100 });
    assert.equal(replayedClaim.laneSequence, 1);
    assert.deepEqual(await core.accept(replayedClaim.payload, {
      conversationLaneKey: replayedClaim.conversationLaneKey,
      laneSequence: replayedClaim.laneSequence,
      sourceOrder: replayedClaim.sourceOrder,
    }), firstReceipt);
    assert.equal(core.acceptedEffects().length, 1);
    recovered.commit({ receipt: replayedClaim.receipt, result: firstReceipt });

    const transportReplay = normalizeFeishuInboundMessage(event({ eventId: 'evt-webhook' }), {
      accountRef: 'cli_app_a',
    });
    assert.equal(receive(recovered, transportReplay).entry.laneSequence, 1);
    const secondMessage = normalizeFeishuInboundMessage(event({
      eventId: 'evt-second',
      messageId: 'om-logical-2',
    }), { accountRef: 'cli_app_a' });
    assert.equal(receive(recovered, secondMessage).entry.laneSequence, 2);

    const contender = openInboundEventInbox({ dbPath, clock: () => now, maxAttempts: 3 });
    const [winner] = recovered.claim({ workerId: 'winner', leaseMs: 100 });
    assert.equal(winner.laneSequence, 2);
    assert.deepEqual(contender.claim({ workerId: 'loser', leaseMs: 100 }), []);
    const secondReceipt = await core.accept(winner.payload, {
      conversationLaneKey: winner.conversationLaneKey,
      laneSequence: winner.laneSequence,
      sourceOrder: winner.sourceOrder,
    });
    recovered.commit({ receipt: winner.receipt, result: secondReceipt });
    assert.equal(core.acceptedEffects().length, 2);
    contender.close();
    recovered.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
