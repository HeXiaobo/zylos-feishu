import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationResponseRuntimeAdapter } from '../src/lib/conversation-response-runtime-adapter.js';
import {
  createTypingPresenceCoordinator,
  createTypingDoneMarkerConsumer,
  messageIdFromEndpoint,
  openTypingDoneMarkerStore,
  persistTimeoutPresenceCompletions,
  settlementMessageIdFromEndpoint,
} from '../src/lib/typing-done-marker.js';

function delivery(type, sequence = 1) {
  return {
    schemaVersion: 1,
    requestId: 'assistant.feishu.om-source-1',
    route: {
      channel: 'feishu',
      endpointId: 'oc-1|type:group|root:om-root|msg:om-source-1',
    },
    events: [{
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      requestId: 'assistant.feishu.om-source-1',
      sequence,
      type,
      payload: type === 'RunCompleted' ? { output: 'done' } : { stage: 'tool' },
    }],
  };
}

test('legacy stream marks typing done only after a terminal delivery succeeds', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-typing-done-'));
  try {
    const markers = openTypingDoneMarkerStore({ directory });
    let fail = false;
    const runtime = createConversationResponseRuntimeAdapter({
      stream: {
        async open() { return { messageId: 'card-1' }; },
        async apply({ events }) {
          if (fail) throw new Error('Feishu unavailable');
          const terminal = events.some(event => ['RunCompleted', 'RunFailed'].includes(event.type));
          return { handled: true, pending: false, status: terminal ? 'completed' : 'started' };
        },
      },
      markers,
    });

    await runtime.deliver(delivery('ProgressUpdated'));
    assert.deepEqual(markers.claim(), []);

    fail = true;
    await assert.rejects(runtime.deliver(delivery('RunCompleted', 2)), /Feishu unavailable/);
    assert.deepEqual(markers.claim(), []);

    fail = false;
    await runtime.deliver(delivery('RunCompleted', 2));
    await runtime.deliver(delivery('RunCompleted', 2));
    assert.deepEqual(markers.claim(), ['om-source-1']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a terminal event that is still pending does not mark typing done', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-typing-pending-'));
  try {
    const markers = openTypingDoneMarkerStore({ directory });
    const runtime = createConversationResponseRuntimeAdapter({
      stream: {
        async open() { return { messageId: 'card-1' }; },
        async apply() { return { handled: true, pending: true, status: 'completed' }; },
      },
      markers,
    });

    await runtime.deliver(delivery('RunCompleted'));
    assert.deepEqual(markers.claim(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a successfully presented main timeout marks typing done without a terminal input event', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-typing-timeout-'));
  try {
    const markers = openTypingDoneMarkerStore({ directory });
    const runtime = createConversationResponseRuntimeAdapter({
      stream: {
        async open() { return { messageId: 'card-1' }; },
        async apply() {
          return { handled: true, pending: false, status: 'failed', reason: 'main_timeout' };
        },
      },
      markers,
    });

    await runtime.deliver(delivery('ProgressUpdated'));
    assert.deepEqual(markers.claim(), ['om-source-1']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('typing marker identity fails closed and retains a cleanup timestamp', () => {
  assert.equal(messageIdFromEndpoint('oc-1|type:group|msg:om-safe_1'), 'om-safe_1');
  for (const endpoint of [
    'oc-1|msg:',
    'oc-1|msg:om-one|msg:om-two',
    'oc-1|msg:../escape',
    `oc-1|msg:${'a'.repeat(257)}`,
  ]) assert.equal(messageIdFromEndpoint(endpoint), null, endpoint);

  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-marker-safe-'));
  try {
    const markers = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    markers.mark('om-safe_1');
    assert.equal(readFileSync(path.join(directory, 'om-safe_1.done'), 'utf8'), '1788220800123');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('send settlement skips routes with no presence and rejects malformed message discriminators', () => {
  assert.equal(settlementMessageIdFromEndpoint('oc-proactive-chat'), null);
  assert.equal(
    settlementMessageIdFromEndpoint('task-comment|app:YXBw|task:dGFzaw|comment:Y29tbWVudA'),
    null,
  );
  assert.equal(
    settlementMessageIdFromEndpoint('oc-1|type:p2p|msg:om-source-1'),
    'om-source-1',
  );
  for (const endpoint of [
    'oc-1|msg:',
    'oc-1|msg:one|msg:two',
    'oc-1|msg:../bad',
  ]) {
    assert.throws(
      () => settlementMessageIdFromEndpoint(endpoint),
      error => error?.code === 'INVALID_SOURCE_MESSAGE_IDENTITY',
      endpoint,
    );
  }
});

test('marker consumer fences overlapping drains and acknowledges only successful removal', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-marker-consumer-'));
  try {
    const markers = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    markers.mark('om-safe_1');
    let calls = 0;
    let succeed = false;
    const consumer = createTypingDoneMarkerConsumer({
      markers,
      async remove() {
        calls += 1;
        await Promise.resolve();
        return succeed;
      },
      clock: () => 1_788_220_800_123,
    });

    await Promise.all([consumer.drain(), consumer.drain()]);
    assert.equal(calls, 1);
    assert.deepEqual(markers.claim(), ['om-safe_1']);

    succeed = true;
    await consumer.drain();
    assert.equal(calls, 2);
    assert.deepEqual(markers.claim(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a presented terminal fails closed when its source message identity is not exact', async () => {
  for (const endpointId of ['oc-1|type:group', 'oc-1|msg:one|msg:two', 'oc-1|msg:../bad']) {
    const runtime = createConversationResponseRuntimeAdapter({
      stream: {
        async open() { return { messageId: 'card-1' }; },
        async apply() { return { handled: true, pending: false, status: 'completed' }; },
      },
      markers: { mark() { throw new Error('must not write'); } },
    });
    await assert.rejects(
      runtime.deliver({ ...delivery('RunCompleted'), route: { channel: 'feishu', endpointId } }),
      /source message identity/,
    );
  }
});

test('marker I/O failure rejects worker ACK and a safe terminal replay persists completion', async () => {
  const warnings = [];
  let markerAttempts = 0;
  const runtime = createConversationResponseRuntimeAdapter({
    stream: {
      async open() { return { messageId: 'card-1' }; },
      async apply() { return { handled: true, pending: false, status: 'completed' }; },
    },
    markers: {
      mark() {
        markerAttempts += 1;
        if (markerAttempts === 1) throw new Error('disk full');
      },
    },
    logger: { warn(message, details) { warnings.push([message, details]); } },
  });

  await assert.rejects(runtime.deliver(delivery('RunCompleted')), /disk full/);
  assert.equal((await runtime.deliver(delivery('RunCompleted'))).status, 'completed');
  assert.equal(markerAttempts, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /marker/);
  assert.equal(warnings[0][1].messageId, 'om-source-1');
  assert.equal(warnings[0][1].error, 'disk full');
});

test('durable active presence survives restart and terminal completion removes exactly once', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-restart-'));
  try {
    const firstStore = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    const first = createTypingPresenceCoordinator({
      store: firstStore,
      async addReaction() { return { success: true, reactionId: 'reaction-restart-1' }; },
      async removeReaction() { throw new Error('first process must not remove'); },
    });
    assert.equal((await first.begin('om-restart-1')).reactionId, 'reaction-restart-1');
    firstStore.mark('om-restart-1');

    const removals = [];
    const secondStore = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_801_000 });
    const second = createTypingPresenceCoordinator({
      store: secondStore,
      async addReaction() { throw new Error('restart must not add again'); },
      async removeReaction(messageId, reactionId) {
        removals.push([messageId, reactionId]);
        return { success: true };
      },
    });
    const consumer = createTypingDoneMarkerConsumer({
      markers: secondStore,
      remove: messageId => second.finish(messageId),
    });

    await consumer.drain();
    await consumer.drain();
    assert.deepEqual(removals, [['om-restart-1', 'reaction-restart-1']]);
    assert.equal(secondStore.getActive('om-restart-1'), null);
    assert.deepEqual(secondStore.claim(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed active-state write compensates the newly added reaction', async () => {
  const calls = [];
  const coordinator = createTypingPresenceCoordinator({
    store: {
      getActive() { return null; },
      beginAdding(messageId) {
        return { presence: { status: 'adding', messageId, reactionId: null } };
      },
      registerActive() { throw new Error('state disk full'); },
      finishActive() { throw new Error('not reached'); },
      finishAdding(messageId) { calls.push(['finish-adding', messageId]); return true; },
    },
    async addReaction(messageId) {
      calls.push(['add', messageId]);
      return { success: true, reactionId: 'reaction-untracked-1' };
    },
    async removeReaction(messageId, reactionId) {
      calls.push(['remove', messageId, reactionId]);
      return { success: true };
    },
  });

  await assert.rejects(coordinator.begin('om-untracked-1'), /state disk full/);
  assert.deepEqual(calls, [
    ['add', 'om-untracked-1'],
    ['remove', 'om-untracked-1', 'reaction-untracked-1'],
    ['finish-adding', 'om-untracked-1'],
  ]);
});

test('active presence replay is idempotent and a different reaction identity conflicts', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-identity-'));
  try {
    const store = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    store.beginAdding('om-identity-1');
    const first = store.registerActive({ messageId: 'om-identity-1', reactionId: 'reaction-one' });
    const replay = store.registerActive({ messageId: 'om-identity-1', reactionId: 'reaction-one' });
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.throws(
      () => store.registerActive({ messageId: 'om-identity-1', reactionId: 'reaction-two' }),
      error => error?.code === 'IDEMPOTENCY_CONFLICT',
    );

    let adds = 0;
    const coordinator = createTypingPresenceCoordinator({
      store,
      async addReaction() { adds += 1; throw new Error('must not add'); },
      async removeReaction() { throw new Error('not reached'); },
    });
    assert.equal((await coordinator.begin('om-identity-1')).reactionId, 'reaction-one');
    assert.equal(adds, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an adding presence is reconciled after restart before any duplicate reaction is added', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-adding-'));
  try {
    const firstStore = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    firstStore.beginAdding('om-adding-restart-1');

    const calls = [];
    const secondStore = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_801_000 });
    const second = createTypingPresenceCoordinator({
      store: secondStore,
      async addReaction() { calls.push(['add']); throw new Error('must not add twice'); },
      async removeReaction(messageId, reactionId) {
        calls.push(['remove', messageId, reactionId]);
        return { success: true };
      },
      async reconcileReaction(messageId, reactionId) {
        calls.push(['reconcile', messageId, reactionId]);
        return { outcome: 'reconciled', reactionId: 'reaction-recovered-1' };
      },
    });

    assert.equal((await second.begin('om-adding-restart-1')).reactionId, 'reaction-recovered-1');
    assert.equal(await second.finish('om-adding-restart-1'), true);
    assert.deepEqual(calls, [
      ['reconcile', 'om-adding-restart-1', null],
      ['remove', 'om-adding-restart-1', 'reaction-recovered-1'],
    ]);
    assert.equal(secondStore.getActive('om-adding-restart-1'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an active delete is settled only after exact reconciliation proves the reaction absent', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-delete-gap-'));
  try {
    const store = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    store.beginAdding('om-delete-gap-1');
    store.registerActive({ messageId: 'om-delete-gap-1', reactionId: 'reaction-delete-gap-1' });
    const reconciliations = [];
    const coordinator = createTypingPresenceCoordinator({
      store,
      async addReaction() { throw new Error('not reached'); },
      async removeReaction() { return { success: false }; },
      async reconcileReaction(messageId, reactionId) {
        reconciliations.push([messageId, reactionId]);
        return { outcome: 'not_found' };
      },
    });

    assert.equal(await coordinator.finish('om-delete-gap-1'), true);
    assert.deepEqual(reconciliations, [['om-delete-gap-1', 'reaction-delete-gap-1']]);
    assert.equal(store.getActive('om-delete-gap-1'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an explicit not-found delete receipt settles without a second ambiguous lookup', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-delete-absent-'));
  try {
    const store = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    store.beginAdding('om-delete-absent-1');
    store.registerActive({
      messageId: 'om-delete-absent-1',
      reactionId: 'reaction-delete-absent-1',
    });
    const coordinator = createTypingPresenceCoordinator({
      store,
      async addReaction() { throw new Error('not reached'); },
      async removeReaction() { return { success: false, notFound: true }; },
      async reconcileReaction() { throw new Error('a proven absence must not be queried again'); },
    });

    assert.equal(await coordinator.finish('om-delete-absent-1'), true);
    assert.equal(store.getActive('om-delete-absent-1'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a concurrent terminal finish waits for begin registration and cannot strand the reaction', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-race-'));
  try {
    const store = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    let releaseAdd;
    const addStarted = new Promise(resolve => { releaseAdd = resolve; });
    let continueAdd;
    const addBlocked = new Promise(resolve => { continueAdd = resolve; });
    const calls = [];
    const coordinator = createTypingPresenceCoordinator({
      store,
      async addReaction(messageId) {
        calls.push(['add', messageId]);
        releaseAdd();
        await addBlocked;
        return { success: true, reactionId: 'reaction-race-1' };
      },
      async removeReaction(messageId, reactionId) {
        calls.push(['remove', messageId, reactionId]);
        return { success: true };
      },
    });

    const beginning = coordinator.begin('om-race-1');
    await addStarted;
    const finishing = coordinator.finish('om-race-1');
    continueAdd();
    await beginning;
    assert.equal(await finishing, true);
    assert.deepEqual(calls, [
      ['add', 'om-race-1'],
      ['remove', 'om-race-1', 'reaction-race-1'],
    ]);
    assert.equal(store.getActive('om-race-1'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a begin journal failure prevents the external reaction side effect', async () => {
  let adds = 0;
  const coordinator = createTypingPresenceCoordinator({
    store: {
      getActive() { return null; },
      beginAdding() { throw new Error('journal unavailable'); },
      registerActive() { throw new Error('not reached'); },
      finishActive() { throw new Error('not reached'); },
      finishAdding() { throw new Error('not reached'); },
    },
    async addReaction() { adds += 1; return { success: true, reactionId: 'reaction-never' }; },
    async removeReaction() { throw new Error('not reached'); },
  });

  await assert.rejects(coordinator.begin('om-journal-failure-1'), /journal unavailable/);
  assert.equal(adds, 0);
});

test('a done marker without local state adopts an owned reaction or acknowledges proven absence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-adopt-'));
  try {
    const store = openTypingDoneMarkerStore({ directory, clock: () => 1_788_220_800_123 });
    const reconciled = ['reaction-orphan-1', null];
    const removals = [];
    const coordinator = createTypingPresenceCoordinator({
      store,
      async addReaction() { throw new Error('not reached'); },
      async removeReaction(messageId, reactionId) {
        removals.push([messageId, reactionId]);
        return { success: true };
      },
      async reconcileReaction() {
        const reactionId = reconciled.shift();
        return reactionId ? { outcome: 'reconciled', reactionId } : { outcome: 'not_found' };
      },
    });

    assert.equal(await coordinator.finish('om-adopt-1'), true);
    assert.deepEqual(removals, [['om-adopt-1', 'reaction-orphan-1']]);
    assert.equal(store.getActive('om-adopt-1'), null);
    assert.equal(await coordinator.finish('om-already-absent-1'), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('timeout completion acknowledges only after its exact durable presence marker is written', async () => {
  let markerAttempts = 0;
  const acknowledgements = [];
  const input = {
    requestIds: ['assistant.feishu.hash-1'],
    activeMessageIds: ['om-timeout-1'],
    requestIdForMessage: messageId => messageId === 'om-timeout-1'
      ? 'assistant.feishu.hash-1'
      : 'unexpected',
    mark(messageId) {
      markerAttempts += 1;
      assert.equal(messageId, 'om-timeout-1');
      if (markerAttempts === 1) throw new Error('marker disk full');
    },
    async acknowledge(requestId) { acknowledgements.push(requestId); },
  };

  await assert.rejects(persistTimeoutPresenceCompletions(input), /marker disk full/);
  assert.deepEqual(acknowledgements, []);
  assert.deepEqual(await persistTimeoutPresenceCompletions(input), { settled: 1, unresolved: 0 });
  assert.deepEqual(acknowledgements, ['assistant.feishu.hash-1']);
});
