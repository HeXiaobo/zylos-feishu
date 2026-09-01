import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  openInboundEventInbox,
  processInboundEventInboxOnce,
} from '../src/lib/inbound-event-inbox.js';
import { normalizeFeishuInboundMessage } from '../src/lib/feishu-inbound-normalizer.js';
import { normalizeInboundMessageEvent } from '../src/lib/inbound-message-event.js';

function inbound(overrides = {}) {
  return {
    eventId: overrides.eventId ?? 'evt_message_1',
    messageId: overrides.messageId ?? 'om_message_1',
    payload: overrides.payload ?? {
      message: { message_id: 'om_message_1', text: '任务：整理客户记录' },
      sender: { sender_id: { open_id: 'ou_sender' } },
    },
  };
}

test('inbound inbox durably deduplicates event and message identities across reopen', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-'));
  const dbPath = path.join(directory, 'inbound.db');
  try {
    const first = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_000_000,
      maxAttempts: 3,
    });
    const created = first.receive(inbound());
    assert.equal(created.created, true);
    assert.equal(created.entry.status, 'received');
    assert.equal(first.receive(inbound()).created, false);
    first.close();

    const reopened = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_001_000,
      maxAttempts: 3,
    });
    const replayByMessage = reopened.receive(inbound({ eventId: 'evt_message_retry' }));
    assert.equal(replayByMessage.created, false);
    assert.equal(replayByMessage.entry.messageId, 'om_message_1');
    assert.equal(reopened.query({ eventId: 'evt_message_1' }).status, 'received');
    assert.equal(reopened.query({ eventId: 'evt_message_retry' }).status, 'received');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('namespaced dual identities allocate one monotonic lane sequence after dedupe', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-lanes-'));
  const dbPath = path.join(directory, 'inbound.db');
  try {
    const inbox = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_000_000,
      maxAttempts: 3,
    });
    const first = inbox.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId: 'evt_ws_1',
      messageId: 'om_1',
      payload: { normalized: 'same message' },
      conversationLaneKey: 'feishu:cli_app_a:group:oc_1:chat',
      sourceOrder: null,
    });
    const webhookReplay = inbox.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId: 'evt_webhook_1',
      messageId: 'om_1',
      payload: { normalized: 'same message' },
      conversationLaneKey: 'feishu:cli_app_a:group:oc_1:chat',
      sourceOrder: null,
    });
    const second = inbox.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId: 'evt_ws_2',
      messageId: 'om_2',
      payload: { normalized: 'second message' },
      conversationLaneKey: 'feishu:cli_app_a:group:oc_1:chat',
      sourceOrder: 'offset:2',
    });
    const otherAccount = inbox.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_b',
      eventType: 'im.message.receive_v1',
      eventId: 'evt_ws_1',
      messageId: 'om_1',
      payload: { normalized: 'same message' },
      conversationLaneKey: 'feishu:cli_app_b:group:oc_1:chat',
      sourceOrder: null,
    });

    assert.equal(first.created, true);
    assert.equal(first.entry.laneSequence, 1);
    assert.equal(webhookReplay.created, false);
    assert.equal(webhookReplay.entry.id, first.entry.id);
    assert.equal(webhookReplay.entry.laneSequence, 1);
    assert.equal(second.entry.laneSequence, 2);
    assert.equal(second.entry.sourceOrder, 'offset:2');
    assert.equal(otherAccount.created, true);
    assert.equal(otherAccount.entry.laneSequence, 1);
    assert.throws(
      () => inbox.receive({
        adapterId: 'feishu',
        accountRef: 'cli_app_a',
        eventType: 'im.message.receive_v1',
        eventId: 'evt_ws_1',
        messageId: 'om_alias',
        payload: { normalized: 'same message' },
        conversationLaneKey: 'feishu:cli_app_a:group:oc_1:chat',
        sourceOrder: null,
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => inbox.receive({
        adapterId: 'feishu',
        accountRef: 'cli_app_a',
        eventType: 'im.message.receive_v1',
        eventId: 'evt_ws_1',
        messageId: 'om_1',
        payload: { normalized: 'changed payload' },
        conversationLaneKey: 'feishu:cli_app_a:group:oc_1:chat',
        sourceOrder: null,
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('opening a legacy inbox migrates additively and preserves replay across restart', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-migration-'));
  const dbPath = path.join(directory, 'inbound.db');
  try {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE feishu_inbound_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        message_id TEXT,
        request_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        last_error TEXT,
        result_json TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        committed_at INTEGER,
        dead_lettered_at INTEGER
      );
      CREATE TABLE feishu_inbound_identities (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        inbox_id INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
      );
    `);
    const payload = JSON.stringify(inbound().payload);
    const hash = createHash('sha256').update(payload).digest('hex');
    legacy.prepare(`
      INSERT INTO feishu_inbound_inbox (
        event_id, message_id, request_fingerprint, payload_json, status,
        available_at, received_at, updated_at
      ) VALUES (?, ?, ?, ?, 'received', ?, ?, ?)
    `).run('evt_message_1', 'om_message_1', hash, payload, 1, 1, 1);
    legacy.prepare(`
      INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, 1)
    `).run('event', 'evt_message_1');
    legacy.prepare(`
      INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, 1)
    `).run('message', 'om_message_1');
    legacy.close();

    const migrated = openInboundEventInbox({ dbPath, clock: () => 2, maxAttempts: 3 });
    assert.equal(migrated.receive(inbound()).created, false);
    const created = migrated.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId: 'evt_new',
      messageId: 'om_new',
      payload: { normalized: 'new' },
      conversationLaneKey: 'feishu:cli_app_a:p2p:oc_new:chat',
      sourceOrder: null,
    });
    assert.equal(created.entry.laneSequence, 1);
    migrated.close();

    const reopened = openInboundEventInbox({ dbPath, clock: () => 3, maxAttempts: 3 });
    assert.equal(reopened.query({ eventId: 'evt_message_1' }).id, 1);
    assert.equal(reopened.query({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      messageId: 'om_new',
    }).laneSequence, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy identities bridge to one namespaced row and reject payload drift in the same database', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-legacy-bridge-'));
  const dbPath = path.join(directory, 'inbound.db');
  const raw = {
    event_id: 'evt_legacy_ws',
    create_time: '1787900000000',
    message: {
      message_id: 'om_legacy_message',
      chat_id: 'oc_legacy_chat',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'legacy hello' }),
    },
    sender: {
      sender_id: { open_id: 'ou_legacy_sender' },
      sender_type: 'user',
      tenant_key: 'tenant_legacy',
    },
  };
  try {
    const legacyEnvelope = normalizeInboundMessageEvent(raw);
    const legacyPayloadJson = JSON.stringify(legacyEnvelope.payload);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE feishu_inbound_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        message_id TEXT,
        request_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        last_error TEXT,
        result_json TEXT,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        committed_at INTEGER,
        dead_lettered_at INTEGER
      );
      CREATE TABLE feishu_inbound_identities (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        inbox_id INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
      );
    `);
    legacy.prepare(`
      INSERT INTO feishu_inbound_inbox (
        event_id, message_id, request_fingerprint, payload_json, status,
        available_at, received_at, updated_at
      ) VALUES (?, ?, ?, ?, 'received', ?, ?, ?)
    `).run(
      legacyEnvelope.eventId,
      legacyEnvelope.messageId,
      createHash('sha256').update(legacyPayloadJson).digest('hex'),
      legacyPayloadJson,
      1,
      1,
      1,
    );
    legacy.prepare(`
      INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, 1)
    `).run('event', legacyEnvelope.eventId);
    legacy.prepare(`
      INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, 1)
    `).run('message', legacyEnvelope.messageId);
    legacy.close();

    const migrated = openInboundEventInbox({ dbPath, clock: () => 2, maxAttempts: 3 });
    const bridgeRaw = {
      header: { event_id: 'evt_legacy_webhook', create_time: '1787900000999' },
      message: raw.message,
      sender: raw.sender,
    };
    const normalized = normalizeFeishuInboundMessage(bridgeRaw, { accountRef: 'cli_app_a' });
    const bridged = migrated.receive({
      adapterId: normalized.adapterId,
      accountRef: normalized.accountRef,
      eventType: normalized.eventType,
      eventId: normalized.eventId,
      messageId: normalized.messageId,
      payload: normalized.message,
      payloadHash: normalized.payloadHash,
      legacyPayload: normalizeInboundMessageEvent(bridgeRaw).payload,
      conversationLaneKey: normalized.conversationLaneKey,
      sourceOrder: normalized.sourceOrder,
    });
    assert.equal(bridged.created, false);
    assert.equal(bridged.entry.id, 1);
    assert.equal(bridged.entry.laneSequence, 1);
    assert.deepEqual(bridged.entry.payload, normalized.message);
    assert.equal(migrated.query({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      messageId: 'om_legacy_message',
    }).id, 1);
    migrated.close();

    const reopened = openInboundEventInbox({ dbPath, clock: () => 3, maxAttempts: 3 });
    const websocket = normalizeFeishuInboundMessage(raw, { accountRef: 'cli_app_a' });
    const replay = reopened.receive({
      adapterId: websocket.adapterId,
      accountRef: websocket.accountRef,
      eventType: websocket.eventType,
      eventId: websocket.eventId,
      messageId: websocket.messageId,
      payload: websocket.message,
      payloadHash: websocket.payloadHash,
      legacyPayload: legacyEnvelope.payload,
      conversationLaneKey: websocket.conversationLaneKey,
      sourceOrder: websocket.sourceOrder,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.entry.id, 1);
    assert.equal(replay.entry.laneSequence, 1);

    const changedRaw = {
      ...bridgeRaw,
      message: {
        ...raw.message,
        content: JSON.stringify({ text: 'tampered replay' }),
      },
    };
    const changed = normalizeFeishuInboundMessage(changedRaw, { accountRef: 'cli_app_a' });
    assert.throws(
      () => reopened.receive({
        adapterId: changed.adapterId,
        accountRef: changed.accountRef,
        eventType: changed.eventType,
        eventId: changed.eventId,
        messageId: changed.messageId,
        payload: changed.message,
        payloadHash: changed.payloadHash,
        legacyPayload: normalizeInboundMessageEvent(changedRaw).payload,
        conversationLaneKey: changed.conversationLaneKey,
        sourceOrder: changed.sourceOrder,
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker leases a received event and commits it with a fenced receipt', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-lease-'));
  const dbPath = path.join(directory, 'inbound.db');
  try {
    const inbox = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_000_000,
      maxAttempts: 3,
    });
    inbox.receive(inbound());

    const [claimed] = inbox.claim({ workerId: 'worker-a', leaseMs: 5_000, limit: 10 });
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.attempt, 1);
    assert.deepEqual(claimed.payload, inbound().payload);
    assert.deepEqual(claimed.receipt, {
      id: claimed.id,
      workerId: 'worker-a',
      version: 2,
    });

    const committed = inbox.commit({
      receipt: claimed.receipt,
      result: { accepted: true },
    });
    assert.equal(committed.status, 'committed');
    assert.deepEqual(committed.result, { accepted: true });
    assert.deepEqual(inbox.claim({ workerId: 'worker-b', leaseMs: 5_000, limit: 10 }), []);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired processing lease is recovered and fences the stale worker', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-recover-'));
  const dbPath = path.join(directory, 'inbound.db');
  let now = 1_787_900_000_000;
  try {
    const inbox = openInboundEventInbox({ dbPath, clock: () => now, maxAttempts: 3 });
    inbox.receive(inbound());
    const [stale] = inbox.claim({ workerId: 'worker-a', leaseMs: 1_000 });

    now += 1_000;
    const [recovered] = inbox.claim({ workerId: 'worker-b', leaseMs: 1_000 });
    assert.equal(recovered.id, stale.id);
    assert.equal(recovered.attempt, 2);
    assert.throws(
      () => inbox.commit({ receipt: stale.receipt, result: { accepted: true } }),
      (error) => error.code === 'LEASE_LOST',
    );
    assert.equal(inbox.commit({
      receipt: recovered.receipt,
      result: { accepted: true },
    }).status, 'committed');
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed handling waits before retry and dead-letters at the configured attempt limit', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-fail-'));
  const dbPath = path.join(directory, 'inbound.db');
  let now = 1_787_900_000_000;
  try {
    const inbox = openInboundEventInbox({ dbPath, clock: () => now, maxAttempts: 2 });
    inbox.receive(inbound());
    const [first] = inbox.claim({ workerId: 'worker-a', leaseMs: 5_000 });
    const failed = inbox.fail({
      receipt: first.receipt,
      error: new Error('temporary Core outage'),
      retryAfterMs: 1_000,
    });
    assert.equal(failed.status, 'failed');
    assert.deepEqual(inbox.claim({ workerId: 'worker-b', leaseMs: 5_000 }), []);

    now += 1_000;
    const [second] = inbox.claim({ workerId: 'worker-b', leaseMs: 5_000 });
    assert.equal(second.attempt, 2);
    const dead = inbox.fail({
      receipt: second.receipt,
      error: new Error('still unavailable'),
      retryAfterMs: 1_000,
    });
    assert.equal(dead.status, 'dead_letter');
    assert.match(dead.lastError, /still unavailable/);
    assert.deepEqual(inbox.claim({ workerId: 'worker-c', leaseMs: 5_000 }), []);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a dead-lettered lane head remains auditable and the next sequence advances after restart', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-dead-lane-'));
  const dbPath = path.join(directory, 'inbound.db');
  const lane = 'feishu:cli_app_a:group:oc_dead_lane:chat';
  const receive = (inbox, suffix) => inbox.receive({
    adapterId: 'feishu',
    accountRef: 'cli_app_a',
    eventType: 'im.message.receive_v1',
    eventId: `evt_dead_lane_${suffix}`,
    messageId: `om_dead_lane_${suffix}`,
    payload: { normalized: `message ${suffix}` },
    conversationLaneKey: lane,
    sourceOrder: null,
  });
  try {
    const inbox = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_000_000,
      maxAttempts: 3,
    });
    assert.equal(receive(inbox, 1).entry.laneSequence, 1);
    assert.equal(receive(inbox, 2).entry.laneSequence, 2);
    const [first] = inbox.claim({ workerId: 'worker-a', leaseMs: 5_000, limit: 10 });
    const dead = inbox.fail({
      receipt: first.receipt,
      error: Object.assign(new Error('permanent poison message'), { retryable: false }),
      retryAfterMs: 1_000,
    });
    assert.equal(dead.status, 'dead_letter');
    inbox.close();

    const reopened = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_001_000,
      maxAttempts: 3,
    });
    const [next] = reopened.claim({ workerId: 'worker-b', leaseMs: 5_000, limit: 10 });
    assert.equal(next.messageId, 'om_dead_lane_2');
    assert.equal(next.laneSequence, 2);
    assert.equal(reopened.query({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      messageId: 'om_dead_lane_1',
    }).status, 'dead_letter');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('repeated worker crashes dead-letter an event after its final lease expires', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-crash-'));
  const dbPath = path.join(directory, 'inbound.db');
  let now = 1_787_900_000_000;
  try {
    const inbox = openInboundEventInbox({ dbPath, clock: () => now, maxAttempts: 2 });
    inbox.receive(inbound());
    inbox.claim({ workerId: 'worker-a', leaseMs: 1_000 });

    now += 1_000;
    const [lastAttempt] = inbox.claim({ workerId: 'worker-b', leaseMs: 1_000 });
    assert.equal(lastAttempt.attempt, 2);

    now += 1_000;
    assert.deepEqual(inbox.claim({ workerId: 'worker-c', leaseMs: 1_000 }), []);
    const dead = inbox.query({ eventId: 'evt_message_1' });
    assert.equal(dead.status, 'dead_letter');
    assert.match(dead.lastError, /lease expired/i);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker processes claimed payloads and independently settles poison events', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-worker-'));
  const dbPath = path.join(directory, 'inbound.db');
  try {
    const inbox = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_000_000,
      maxAttempts: 3,
    });
    inbox.receive({ eventId: 'evt_poison', messageId: 'om_poison', payload: { kind: 'poison' } });
    inbox.receive({ eventId: 'evt_healthy', messageId: 'om_healthy', payload: { kind: 'healthy' } });
    const handled = [];

    const summary = await processInboundEventInboxOnce({
      inbox,
      workerId: 'worker-a',
      leaseMs: 5_000,
      limit: 10,
      handleMessage: async (payload, metadata) => {
        handled.push({ payload, metadata });
        if (payload.kind === 'poison') {
          const error = new Error('malformed event');
          error.retryable = false;
          throw error;
        }
        return { accepted: true };
      },
    });

    assert.deepEqual(summary, {
      claimed: 2,
      committed: 1,
      failed: 0,
      deadLettered: 1,
    });
    assert.equal(handled.length, 2);
    assert.deepEqual(handled[1].metadata, {
      inboxId: handled[1].metadata.inboxId,
      eventId: 'evt_healthy',
      messageId: 'om_healthy',
      attempt: 1,
    });
    assert.equal(inbox.query({ eventId: 'evt_poison' }).status, 'dead_letter');
    assert.equal(inbox.query({ eventId: 'evt_healthy' }).status, 'committed');
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('batch settlement waits for every started lane before surfacing the first lease error', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-settle-barrier-'));
  const dbPath = path.join(directory, 'inbound.db');
  const releaseHealthy = (() => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  })();
  const leaseFailureObserved = (() => {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  })();
  try {
    const durable = openInboundEventInbox({
      dbPath,
      clock: () => 1_787_900_000_000,
      maxAttempts: 3,
    });
    for (const suffix of ['lease-lost', 'healthy']) {
      durable.receive({
        adapterId: 'feishu',
        accountRef: 'cli_app_a',
        eventType: 'im.message.receive_v1',
        eventId: `evt_${suffix}`,
        messageId: `om_${suffix}`,
        payload: { kind: suffix },
        conversationLaneKey: `feishu:cli_app_a:group:oc_${suffix}:chat`,
        sourceOrder: null,
      });
    }
    const inbox = {
      claim: durable.claim,
      fail: durable.fail,
      commit(input) {
        if (input.result.kind === 'lease-lost') {
          const error = Object.assign(new Error('synthetic lease loss'), { code: 'LEASE_LOST' });
          leaseFailureObserved.resolve();
          throw error;
        }
        return durable.commit(input);
      },
    };
    const processing = processInboundEventInboxOnce({
      inbox,
      workerId: 'worker-settle-barrier',
      leaseMs: 5_000,
      limit: 10,
      concurrency: 2,
      handleMessage: async (payload) => {
        if (payload.kind === 'healthy') await releaseHealthy.promise;
        return payload;
      },
    });

    await leaseFailureObserved.promise;
    const early = await Promise.race([
      processing.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setImmediate(() => resolve('pending'))),
    ]);
    assert.equal(early, 'pending');
    releaseHealthy.resolve();
    await assert.rejects(processing, (error) => error.code === 'LEASE_LOST');
    assert.equal(durable.query({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId: 'evt_healthy',
    }).status, 'committed');
    durable.close();
  } finally {
    releaseHealthy.resolve();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy and namespaced writers converge atomically in both arrival orders', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-mixed-writers-'));
  const dbPath = path.join(directory, 'inbound.db');
  const raw = (suffix) => ({
    event_id: `evt_mixed_${suffix}`,
    create_time: '1787900000000',
    message: {
      message_id: `om_mixed_${suffix}`,
      chat_id: `oc_mixed_${suffix}`,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: `mixed ${suffix}` }),
    },
    sender: {
      sender_id: { open_id: 'ou_mixed_sender' },
      sender_type: 'user',
      tenant_key: 'tenant_mixed',
    },
  });
  const receiveV1 = (inbox, source) => {
    const normalized = normalizeFeishuInboundMessage(source, { accountRef: 'cli_app_a' });
    return inbox.receive({
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
  };
  try {
    let inbox = openInboundEventInbox({ dbPath, clock: () => 2, maxAttempts: 3 });

    const legacyFirstRaw = raw('legacy_first');
    const legacyEnvelope = normalizeInboundMessageEvent(legacyFirstRaw);
    const legacyFirst = inbox.receive({
      eventId: legacyEnvelope.eventId,
      messageId: legacyEnvelope.messageId,
      payload: legacyEnvelope.payload,
    });
    inbox.close();
    const previousWriter = new Database(dbPath);
    const previousRow = previousWriter.prepare(`
      SELECT request_fingerprint FROM feishu_inbound_inbox WHERE id = ?
    `).get(legacyFirst.entry.id);
    previousWriter.prepare(`
      UPDATE feishu_inbound_inbox
      SET writer_provenance = NULL, payload_hash = ?
      WHERE id = ?
    `).run(`sha256:${previousRow.request_fingerprint}`, legacyFirst.entry.id);
    previousWriter.close();
    inbox = openInboundEventInbox({ dbPath, clock: () => 3, maxAttempts: 3 });

    assert.throws(
      () => inbox.receive({
        eventId: legacyEnvelope.eventId,
        messageId: legacyEnvelope.messageId,
        payload: {
          ...legacyEnvelope.payload,
          message: {
            ...legacyEnvelope.payload.message,
            content: JSON.stringify({ text: 'legacy-only payload drift' }),
          },
        },
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    const legacyBridged = receiveV1(inbox, legacyFirstRaw);
    assert.equal(legacyBridged.created, false);
    assert.equal(legacyBridged.entry.id, legacyFirst.entry.id);
    assert.equal(legacyBridged.entry.laneSequence, 1);

    const namespacedFirstRaw = raw('namespaced_first');
    const namespacedFirst = receiveV1(inbox, namespacedFirstRaw);
    const namespacedEnvelope = normalizeInboundMessageEvent(namespacedFirstRaw);
    const legacyReplay = inbox.receive({
      eventId: namespacedEnvelope.eventId,
      messageId: namespacedEnvelope.messageId,
      payload: namespacedEnvelope.payload,
    });
    assert.equal(legacyReplay.created, false);
    assert.equal(legacyReplay.entry.id, namespacedFirst.entry.id);

    const changedPayload = {
      ...namespacedEnvelope.payload,
      message: {
        ...namespacedEnvelope.payload.message,
        content: JSON.stringify({ text: 'mixed writer payload drift' }),
      },
    };
    assert.throws(
      () => inbox.receive({
        eventId: namespacedEnvelope.eventId,
        messageId: namespacedEnvelope.messageId,
        payload: changedPayload,
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('namespaced payload hashes are controlled and canonical payload drift fails closed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-hash-integrity-'));
  const dbPath = path.join(directory, 'inbound.db');
  try {
    const inbox = openInboundEventInbox({ dbPath, clock: () => 4, maxAttempts: 3 });
    assert.throws(
      () => inbox.receive({
        adapterId: 'feishu',
        accountRef: 'cli_app_a',
        eventType: 'im.message.receive_v1',
        eventId: 'evt_unbound_hash',
        messageId: 'om_unbound_hash',
        payload: { message: 'a' },
        payloadHash: `sha256:${'a'.repeat(64)}`,
        conversationLaneKey: 'feishu:cli_app_a:group:oc_hash:chat',
        sourceOrder: null,
      }),
      (error) => error.code === 'INVALID_PAYLOAD_HASH',
    );

    const raw = {
      event_id: 'evt_canonical_hash',
      create_time: '1787900000000',
      message: {
        message_id: 'om_canonical_hash',
        chat_id: 'oc_hash',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'canonical a' }),
      },
      sender: {
        sender_id: { open_id: 'ou_hash_sender' },
        tenant_key: 'tenant_hash',
      },
    };
    const normalized = normalizeFeishuInboundMessage(raw, { accountRef: 'cli_app_a' });
    const receive = (payload) => inbox.receive({
      adapterId: normalized.adapterId,
      accountRef: normalized.accountRef,
      eventType: normalized.eventType,
      eventId: normalized.eventId,
      messageId: normalized.messageId,
      payload,
      payloadHash: normalized.payloadHash,
      conversationLaneKey: normalized.conversationLaneKey,
      sourceOrder: normalized.sourceOrder,
    });
    assert.equal(receive(normalized.message).created, true);
    assert.throws(
      () => receive({
        ...normalized.message,
        content: { kind: 'text', text: 'canonical b' },
      }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema migration rebuilds missing namespaced identities without duplicating an inbox row', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-identity-rebuild-'));
  const dbPath = path.join(directory, 'inbound.db');
  const raw = {
    event_id: 'evt_identity_rebuild',
    create_time: '1787900000000',
    message: {
      message_id: 'om_identity_rebuild',
      chat_id: 'oc_identity_rebuild',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'identity rebuild' }),
    },
    sender: {
      sender_id: { open_id: 'ou_identity_rebuild' },
      tenant_key: 'tenant_identity_rebuild',
    },
  };
  const normalized = normalizeFeishuInboundMessage(raw, { accountRef: 'cli_app_a' });
  const receive = (inbox) => inbox.receive({
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
    const first = openInboundEventInbox({ dbPath, clock: () => 5, maxAttempts: 3 });
    const created = receive(first);
    assert.equal(created.created, true);
    first.close();

    const damaged = new Database(dbPath);
    damaged.prepare('DELETE FROM feishu_inbound_source_identities').run();
    damaged.close();

    const reopened = openInboundEventInbox({ dbPath, clock: () => 6, maxAttempts: 3 });
    const replay = receive(reopened);
    assert.equal(replay.created, false);
    assert.equal(replay.entry.id, created.entry.id);
    reopened.close();

    const verify = new Database(dbPath);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM feishu_inbound_inbox').get().count, 1);
    assert.equal(
      verify.prepare('SELECT COUNT(*) AS count FROM feishu_inbound_source_identities').get().count,
      2,
    );
    assert.deepEqual(verify.pragma('foreign_key_check'), []);
    verify.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema migration fails closed when legacy and namespaced identities split across rows', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-split-identity-'));
  const dbPath = path.join(directory, 'inbound.db');
  const eventId = 'evt_split_identity';
  const messageId = 'om_split_identity';
  try {
    const inbox = openInboundEventInbox({ dbPath, clock: () => 7, maxAttempts: 3 });
    inbox.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId,
      messageId,
      payload: { canonical: 'namespaced row' },
      conversationLaneKey: 'feishu:cli_app_a:group:oc_split:chat',
      sourceOrder: null,
    });
    inbox.close();

    const legacyPayload = JSON.stringify({
      message: { message_id: messageId, content: JSON.stringify({ text: 'legacy row' }) },
      sender: { sender_id: { open_id: 'ou_split' } },
      _timestamp: '1787900000000',
    });
    const damaged = new Database(dbPath);
    damaged.exec(`
      DROP TRIGGER IF EXISTS trg_feishu_legacy_identity_no_split;
      DROP TRIGGER IF EXISTS trg_feishu_source_identity_no_split;
    `);
    const inserted = damaged.prepare(`
      INSERT INTO feishu_inbound_inbox (
        event_id, message_id, request_fingerprint, payload_json, status,
        available_at, received_at, updated_at, writer_provenance, legacy_payload_json
      ) VALUES (?, ?, ?, ?, 'received', 7, 7, 7, 'legacy-v0', ?)
    `).run(
      eventId,
      messageId,
      createHash('sha256').update(legacyPayload).digest('hex'),
      legacyPayload,
      legacyPayload,
    );
    const legacyId = Number(inserted.lastInsertRowid);
    damaged.prepare(`
      INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, ?)
    `).run('event', eventId, legacyId);
    damaged.prepare(`
      INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, ?)
    `).run('message', messageId, legacyId);
    damaged.close();

    assert.throws(
      () => openInboundEventInbox({ dbPath, clock: () => 8, maxAttempts: 3 }),
      (error) => error.code === 'IDENTITY_CONFLICT'
        && /legacy and namespaced/i.test(error.message),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('database fencing blocks a rolling legacy writer from splitting a namespaced identity', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-inbound-rolling-fence-'));
  const dbPath = path.join(directory, 'inbound.db');
  const eventId = 'evt_rolling_fence';
  const messageId = 'om_rolling_fence';
  try {
    const oldConnection = new Database(dbPath);
    const inbox = openInboundEventInbox({ dbPath, clock: () => 9, maxAttempts: 3 });
    const created = inbox.receive({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      eventId,
      messageId,
      payload: { canonical: 'new writer row' },
      conversationLaneKey: 'feishu:cli_app_a:group:oc_rolling:chat',
      sourceOrder: null,
    });
    assert.equal(created.created, true);
    const [newWriterLease] = inbox.claim({
      workerId: 'new-writer-processing',
      leaseMs: 5_000,
      limit: 1,
    });
    assert.equal(newWriterLease.id, created.entry.id);

    const oldWriterReceive = oldConnection.transaction((legacyEventId, legacyMessageId, payload) => {
      const payloadJson = JSON.stringify(payload);
      const inserted = oldConnection.prepare(`
        INSERT INTO feishu_inbound_inbox (
          event_id, message_id, request_fingerprint, payload_json, status,
          available_at, received_at, updated_at
        ) VALUES (?, ?, ?, ?, 'received', 9, 9, 9)
      `).run(
        legacyEventId,
        legacyMessageId,
        createHash('sha256').update(payloadJson).digest('hex'),
        payloadJson,
      );
      const legacyId = Number(inserted.lastInsertRowid);
      oldConnection.prepare(`
        INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, ?)
      `).run('event', legacyEventId, legacyId);
      oldConnection.prepare(`
        INSERT INTO feishu_inbound_identities (kind, value, inbox_id) VALUES (?, ?, ?)
      `).run('message', legacyMessageId, legacyId);
      return legacyId;
    });
    const conflictingPayload = (text) => ({
      message: {
        message_id: messageId,
        chat_id: 'oc_rolling',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
      sender: { sender_id: { open_id: 'ou_rolling' }, tenant_key: 'tenant_rolling' },
      _timestamp: '1787900000000',
    });
    assert.throws(
      () => oldWriterReceive(eventId, messageId, conflictingPayload('new writer row')),
      /split inbound identity/i,
    );
    assert.throws(
      () => oldWriterReceive(eventId, messageId, conflictingPayload('payload drift')),
      /split inbound identity/i,
    );
    assert.equal(
      oldConnection.prepare('SELECT COUNT(*) AS count FROM feishu_inbound_inbox').get().count,
      1,
    );
    inbox.commit({ receipt: newWriterLease.receipt, result: { accepted: 'new writer' } });

    const healthyRaw = {
      event_id: 'evt_rolling_healthy',
      create_time: '1787900000001',
      message: {
        message_id: 'om_rolling_healthy',
        chat_id: 'oc_rolling_healthy',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'healthy old writer row' }),
      },
      sender: {
        sender_id: { open_id: 'ou_rolling_healthy' },
        tenant_key: 'tenant_rolling',
      },
    };
    const healthyEnvelope = normalizeInboundMessageEvent(healthyRaw);
    const healthyLegacyId = oldWriterReceive(
      healthyEnvelope.eventId,
      healthyEnvelope.messageId,
      healthyEnvelope.payload,
    );
    const healthy = normalizeFeishuInboundMessage(healthyRaw, { accountRef: 'cli_app_a' });
    const bridgedHealthy = inbox.receive({
      adapterId: healthy.adapterId,
      accountRef: healthy.accountRef,
      eventType: healthy.eventType,
      eventId: healthy.eventId,
      messageId: healthy.messageId,
      payload: healthy.message,
      payloadHash: healthy.payloadHash,
      conversationLaneKey: healthy.conversationLaneKey,
      sourceOrder: healthy.sourceOrder,
    });
    assert.equal(bridgedHealthy.created, false);
    assert.equal(bridgedHealthy.entry.id, healthyLegacyId);
    const [healthyLease] = inbox.claim({
      workerId: 'new-writer-healthy',
      leaseMs: 5_000,
      limit: 1,
    });
    assert.equal(healthyLease.id, healthyLegacyId);
    inbox.commit({ receipt: healthyLease.receipt, result: { accepted: 'healthy legacy' } });

    oldConnection.close();
    inbox.close();

    const reopened = openInboundEventInbox({ dbPath, clock: () => 10, maxAttempts: 3 });
    assert.equal(reopened.query({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      messageId,
    }).status, 'committed');
    assert.equal(reopened.query({
      adapterId: 'feishu',
      accountRef: 'cli_app_a',
      eventType: 'im.message.receive_v1',
      messageId: healthy.messageId,
    }).status, 'committed');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
