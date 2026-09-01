import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openFeishuReplyPresentation } from '../src/lib/feishu-reply-presentation.js';

function acceptedMessage(overrides = {}) {
  return {
    ingressId: overrides.ingressId ?? 'inbox:41',
    requestId: overrides.requestId ?? 'req-41',
    sourceMessageId: overrides.sourceMessageId ?? 'om-source-41',
    route: overrides.route ?? { adapterId: 'feishu', targetRef: 'opaque:reply:41' },
    presentationId: overrides.presentationId ?? 'presentation:req-41',
    presenceId: overrides.presenceId ?? 'presence:req-41',
  };
}

function createReactionPort(calls) {
  return {
    async add(effect) {
      calls.push({ operation: 'add', effect: structuredClone(effect) });
      return { outcome: 'platform_accepted', reactionId: 'reaction-41' };
    },
    async remove(effect) {
      calls.push({ operation: 'remove', effect: structuredClone(effect) });
      return { outcome: 'platform_accepted' };
    },
    async reconcile(effect) {
      calls.push({ operation: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'unknown' };
    },
  };
}

function createCardPort() {
  return {
    async apply() {
      return { outcome: 'platform_accepted', cardId: 'card-41' };
    },
    async reconcile() {
      return { outcome: 'unknown' };
    },
  };
}

function deliverySettlement(requestId = 'req-41', overrides = {}) {
  return {
    schemaVersion: 1,
    type: 'DeliverySettlement',
    settlementId: `settlement:delivery:${requestId}:accepted`,
    intentId: `reply:${requestId}:route-a`,
    deliveryId: `delivery:reply:${requestId}:route-a`,
    requestId,
    traceId: `trace:${requestId}`,
    adapterId: 'feishu',
    state: 'accepted',
    basis: 'platform_accepted',
    presented: true,
    ...overrides,
  };
}

function silentReplyOutcome(requestId = 'req-41', overrides = {}) {
  return {
    schemaVersion: 1,
    type: 'ReplyOutcome',
    outcomeId: `outcome:${requestId}`,
    requestId,
    turnId: `turn:${requestId}:1`,
    traceId: `trace:${requestId}`,
    kind: 'silent',
    explicit: true,
    reason: 'no_user_visible_reply_required',
    ...overrides,
  };
}

function runCancelledEvent(requestId = 'req-41', overrides = {}) {
  return {
    schemaVersion: 1,
    type: 'RunCancelled',
    eventId: `event:${requestId}:cancelled`,
    idempotencyKey: `run:${requestId}:cancelled`,
    requestId,
    turnId: `turn:${requestId}:1`,
    generation: 1,
    sequence: 3,
    traceId: `trace:${requestId}`,
    causationId: `cancel:${requestId}`,
    producer: 'core:runtime-lane',
    payload: { mode: 'queued' },
    ...overrides,
  };
}

async function acceptAndBegin(presentation, input = acceptedMessage()) {
  const accepted = await presentation.accept(input);
  await presentation.reconcile();
  return {
    ...accepted,
    presence: presentation.inspect(accepted.handle.requestId).presence,
  };
}

test('durable acceptance binds one reply handle and begins one recoverable presence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presentation-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  try {
    const first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });

    const created = await first.accept(acceptedMessage());
    assert.equal(created.created, true);
    assert.equal(created.handle.requestId, 'req-41');
    assert.deepEqual(created.handle.route, {
      adapterId: 'feishu',
      targetRef: 'opaque:reply:41',
    });
    assert.equal(created.presence.status, 'adding');
    assert.equal(created.presence.operationStatus, 'pending');
    assert.equal(calls.length, 0, 'durable accept must not wait for Feishu reaction I/O');

    await first.reconcile();
    assert.equal(first.inspect('req-41').presence.status, 'active');
    assert.equal(first.inspect('req-41').presence.reactionId, 'reaction-41');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, 'add');
    assert.equal(calls[0].effect.effectKey, 'presence:add:req-41');

    const replay = await first.accept(acceptedMessage());
    assert.equal(replay.created, false);
    assert.equal(replay.presence.status, 'active');
    assert.equal(calls.length, 1, 'idempotent replay must not add a second reaction');
    first.close();

    const reopened = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => 1_788_000_001_000,
      workerId: 'worker-b',
    });
    const snapshot = reopened.inspect('req-41');
    assert.equal(snapshot.handle.ingressId, 'inbox:41');
    assert.equal(snapshot.presence.status, 'active');
    assert.equal(snapshot.presence.reactionId, 'reaction-41');
    assert.equal(calls.length, 1, 'restart must not replay a completed add effect');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reply handle and settlement identity conflicts fail closed', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presentation-conflict-'));
  const calls = [];
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);
    await assert.rejects(
      presentation.accept(acceptedMessage({
        route: { adapterId: 'feishu', targetRef: 'opaque:different-target' },
      })),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      presentation.accept(acceptedMessage({
        route: {
          adapterId: 'feishu',
          targetRef: 'opaque:reply:41',
          unsupported: undefined,
        },
      })),
      TypeError,
    );
    await assert.rejects(
      presentation.accept(acceptedMessage({
        route: { adapterId: 'hxa-connect', targetRef: 'opaque:reply:41' },
      })),
      TypeError,
    );
    const hiddenArrayProperty = [];
    Object.defineProperty(hiddenArrayProperty, 'unsupported', { value: undefined });
    await assert.rejects(
      presentation.accept(acceptedMessage({
        route: {
          adapterId: 'feishu',
          targetRef: 'opaque:reply:41',
          metadata: hiddenArrayProperty,
        },
      })),
      TypeError,
    );
    await assert.rejects(
      presentation.settlePresence({
        requestId: 'req-41',
        signal: { type: 'run_completed' },
      }),
      TypeError,
    );
    await assert.rejects(
      presentation.settlePresence({
        requestId: 'req-41',
        signal: deliverySettlement('req-different'),
      }),
      (error) => error.code === 'IDENTITY_CONFLICT',
    );
    await assert.rejects(
      presentation.settlePresence({
        requestId: 'req-41',
        signal: deliverySettlement('req-41', { adapterId: 'hxa-connect' }),
      }),
      (error) => error.code === 'IDENTITY_CONFLICT',
    );
    assert.equal(presentation.inspect('req-41').presence.status, 'active');
    assert.equal(calls.filter((call) => call.operation === 'remove').length, 0);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reply handle identity comes from durable ingress plus Core request while source message is only a presence target', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-handle-boundary-'));
  const calls = [];
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    const handle = acceptedMessage();
    assert.equal((await presentation.accept(handle)).created, true);
    await presentation.reconcile();
    assert.equal(calls[0].effect.sourceMessageId, handle.sourceMessageId);
    assert.equal((await presentation.accept(handle)).created, false);

    await assert.rejects(
      presentation.accept({ ...handle, ingressId: 'inbox:different-logical-message' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      presentation.accept({ ...handle, sourceMessageId: 'om-different-reaction-target' }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(calls.filter(({ operation }) => operation === 'add').length, 1);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('card activity and elapsed time never finish Reply Presence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-active-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);

    for (const kind of [
      'queued',
      'run_started',
      'card_opened',
      'progress',
      'output_delta',
      'fallback',
    ]) {
      const observed = presentation.observePresence({ requestId: 'req-41', kind });
      assert.equal(observed.status, 'active');
    }

    now += 121_000;
    const overdue = presentation.observePresence({
      requestId: 'req-41',
      kind: 'elapsed_over_120_seconds',
    });
    assert.equal(overdue.status, 'active');
    assert.equal(overdue.staleObservedAt, now);
    assert.equal(calls.filter((call) => call.operation === 'remove').length, 0);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only explicit terminal presentation settlements finish Reply Presence', async () => {
  const scenarios = [
    {
      name: 'explicit silent',
      signal: (requestId) => silentReplyOutcome(requestId),
      reason: 'explicit_silent',
    },
    {
      name: 'confirmed cancellation',
      signal: (requestId) => runCancelledEvent(requestId),
      reason: 'cancelled_confirmed',
    },
    {
      name: 'platform accepted settlement',
      signal: (requestId) => deliverySettlement(requestId),
      reason: 'delivery_platform_accepted',
    },
    {
      name: 'task receipt accepted settlement',
      signal: (requestId) => deliverySettlement(requestId, { disposition: 'task_receipt' }),
      reason: 'delivery_platform_accepted',
    },
    {
      name: 'reconciled settlement',
      signal: (requestId) => deliverySettlement(requestId, {
        settlementId: `settlement:delivery:${requestId}:reconciled`,
        basis: 'reconciled',
      }),
      reason: 'delivery_reconciled',
    },
    {
      name: 'unpresentable settlement',
      signal: (requestId) => deliverySettlement(requestId, {
        settlementId: `settlement:delivery:${requestId}:unpresentable`,
        state: 'unpresentable',
        basis: 'retry_exhausted',
        presented: false,
      }),
      reason: 'delivery_unpresentable',
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-finish-'));
    const calls = [];
    try {
      const requestId = `req-finish-${index}`;
      const presentation = openFeishuReplyPresentation({
        dbPath: path.join(directory, 'presentation.db'),
        reactionPort: createReactionPort(calls),
        cardPort: createCardPort(),
        clock: () => 1_788_000_000_000 + index,
        workerId: 'worker-a',
      });
      await acceptAndBegin(presentation, acceptedMessage({
        ingressId: `inbox:finish:${index}`,
        requestId,
        sourceMessageId: `om-finish-${index}`,
        presentationId: `presentation:${requestId}`,
        presenceId: `presence:${requestId}`,
      }));

      const signal = scenario.signal(requestId);
      const finished = await presentation.settlePresence({ requestId, signal });
      assert.equal(finished.status, 'finished', scenario.name);
      assert.equal(finished.finishReason, scenario.reason, scenario.name);
      assert.equal(calls.filter((call) => call.operation === 'remove').length, 1, scenario.name);

      const replay = await presentation.settlePresence({ requestId, signal });
      assert.equal(replay.status, 'finished', scenario.name);
      assert.equal(
        calls.filter((call) => call.operation === 'remove').length,
        1,
        `${scenario.name} replay must not remove twice`,
      );
      presentation.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('DeliveryReceipt outcomes do not finish presence before DeliverySettlement', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-receipt-'));
  const calls = [];
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);
    const presenceVersion = presentation.inspect('req-41').presence.version;

    for (const outcome of ['platform_accepted', 'unknown', 'reconciled', 'rejected']) {
      const observed = presentation.observeDeliveryReceipt({
        schemaVersion: 1,
        type: 'DeliveryReceipt',
        receiptId: `receipt:${outcome}`,
        intentId: 'reply:req-41:route-a',
        deliveryId: 'delivery:req-41:route-a',
        requestId: 'req-41',
        attemptId: `attempt:${outcome}`,
        traceId: 'trace:req-41',
        adapterId: 'feishu',
        outcome,
        externalRef: outcome === 'platform_accepted' || outcome === 'reconciled'
          ? 'opaque:message-41'
          : null,
        observedAt: '2026-09-01T00:00:00.000Z',
      });
      assert.equal(observed.status, 'active', outcome);
      assert.equal(observed.lastDeliveryOutcome, outcome);
      assert.equal(observed.deliveryReconcileRequired, outcome === 'unknown');
    }
    const stored = presentation.inspect('req-41').presence;
    assert.equal(stored.version, presenceVersion, 'attempt receipts are owned by WT02-C');
    assert.equal(Object.hasOwn(stored, 'lastDeliveryOutcome'), false);
    assert.equal(calls.filter((call) => call.operation === 'remove').length, 0);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact frozen v1 DeliverySettlement finishes the bound Reply Presence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-v1-settlement-'));
  const calls = [];
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort(calls),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);

    const finished = await presentation.settlePresence({
      requestId: 'req-41',
      signal: deliverySettlement(),
    });
    assert.equal(finished.status, 'finished');
    assert.equal(finished.finishReason, 'delivery_platform_accepted');
    assert.equal(calls.filter(({ operation }) => operation === 'remove').length, 1);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('minimal internal settlement signals cannot bypass frozen v1 identity validation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-v1-strict-'));
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);

    await assert.rejects(
      presentation.settlePresence({
        requestId: 'req-41',
        signal: {
          type: 'delivery_settlement',
          state: 'accepted',
          basis: 'platform_accepted',
          presented: true,
        },
      }),
      TypeError,
    );
    await assert.rejects(
      presentation.settlePresence({
        requestId: 'req-41',
        signal: deliverySettlement('req-41', { intentId: '' }),
      }),
      TypeError,
    );
    await assert.rejects(
      presentation.settlePresence({
        requestId: 'req-41',
        signal: runCancelledEvent('req-41', { payload: {} }),
      }),
      TypeError,
    );
    assert.equal(presentation.inspect('req-41').presence.status, 'active');
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact frozen v1 explicit silent ReplyOutcome finishes Reply Presence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-v1-silent-'));
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);

    const finished = await presentation.settlePresence({
      requestId: 'req-41',
      signal: silentReplyOutcome(),
    });
    assert.equal(finished.status, 'finished');
    assert.equal(finished.finishReason, 'explicit_silent');
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an exact frozen v1 RunCancelled terminal finishes Reply Presence without a confirmed flag', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-v1-cancelled-'));
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });
    await acceptAndBegin(presentation);

    const finished = await presentation.settlePresence({
      requestId: 'req-41',
      signal: runCancelledEvent(),
    });
    assert.equal(finished.status, 'finished');
    assert.equal(finished.finishReason, 'cancelled_confirmed');
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed reaction removal is recovered after restart without a final-reply side effect', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-orphan-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const failingPort = createReactionPort(calls);
    failingPort.remove = async (effect) => {
      calls.push({ operation: 'remove', effect: structuredClone(effect) });
      return { outcome: 'rejected', retryable: true, retryAfterMs: 1_000 };
    };
    const first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: failingPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });
    await acceptAndBegin(first);
    const orphaned = await first.settlePresence({
      requestId: 'req-41',
      signal: deliverySettlement(),
    });
    assert.equal(orphaned.status, 'orphaned');
    assert.equal(orphaned.operation, 'remove');
    assert.equal(orphaned.operationStatus, 'pending');
    first.close();

    now += 1_000;
    const recoveredPort = createReactionPort(calls);
    const reopened = openFeishuReplyPresentation({
      dbPath,
      reactionPort: recoveredPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-b',
      retryDelayMs: 1_000,
    });
    const recovery = await reopened.reconcile();
    assert.deepEqual(recovery.presence, { attempted: 1, finished: 1, pending: 0 });
    const finished = reopened.inspect('req-41').presence;
    assert.equal(finished.status, 'finished');
    const removals = calls.filter((call) => call.operation === 'remove');
    assert.equal(removals.length, 2);
    assert.equal(removals[0].effect.effectKey, 'presence:remove:req-41');
    assert.equal(removals[1].effect.effectKey, removals[0].effect.effectKey);
    assert.equal(removals[1].effect.reactionId, 'reaction-41');
    assert.deepEqual(new Set(calls.map((call) => call.operation)), new Set(['add', 'remove']));
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a reaction transport exception reconciles before retrying and never creates a duplicate reaction', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-ambiguous-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const ambiguousPort = createReactionPort(calls);
    ambiguousPort.add = async (effect) => {
      calls.push({ operation: 'add', effect: structuredClone(effect) });
      throw new Error('socket timeout after request write');
    };
    const first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: ambiguousPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });
    const accepted = await first.accept(acceptedMessage());
    assert.equal(accepted.presence.status, 'adding');
    assert.equal(accepted.presence.operationStatus, 'pending');
    await first.reconcile();
    assert.equal(first.inspect('req-41').presence.operationStatus, 'unknown');
    first.close();

    now += 1_000;
    const reconciledPort = createReactionPort(calls);
    reconciledPort.reconcile = async (effect) => {
      calls.push({ operation: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'reconciled', reactionId: 'reaction-41' };
    };
    const reopened = openFeishuReplyPresentation({
      dbPath,
      reactionPort: reconciledPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-b',
      retryDelayMs: 1_000,
    });
    await reopened.reconcile();
    assert.equal(reopened.inspect('req-41').presence.status, 'active');
    assert.deepEqual(calls.map((call) => call.operation), ['add', 'reconcile']);
    assert.equal(calls[0].effect.effectKey, calls[1].effect.effectKey);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired presence lease fences a late ACK and the next cycle reconciles without crashing', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-expiry-'));
  const calls = [];
  let now = 1_788_000_000_000;
  let releaseAdd;
  const addResult = new Promise((resolve) => {
    releaseAdd = resolve;
  });
  try {
    const reactionPort = createReactionPort(calls);
    reactionPort.add = async (effect) => {
      calls.push({ operation: 'add', effect: structuredClone(effect) });
      return addResult;
    };
    reactionPort.reconcile = async (effect) => {
      calls.push({ operation: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'reconciled', reactionId: 'reaction-after-reconcile' };
    };
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
      leaseMs: 10,
    });
    await presentation.accept(acceptedMessage());
    const staleCycle = presentation.reconcile();
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    now += 11;
    releaseAdd({ outcome: 'platform_accepted', reactionId: 'stale-reaction' });

    await assert.doesNotReject(staleCycle);
    const expired = presentation.inspect('req-41').presence;
    assert.equal(expired.status, 'adding');
    assert.equal(expired.operationStatus, 'inflight');
    assert.equal(expired.reactionId, null);

    await presentation.reconcile();
    const recovered = presentation.inspect('req-41').presence;
    assert.equal(recovered.status, 'active');
    assert.equal(recovered.reactionId, 'reaction-after-reconcile');
    assert.deepEqual(calls.map(({ operation }) => operation), ['add', 'reconcile']);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a presence lease takeover keeps the new worker result when the old worker ACK arrives late', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-takeover-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  let now = 1_788_000_000_000;
  let releaseStaleAdd;
  const staleAddResult = new Promise((resolve) => {
    releaseStaleAdd = resolve;
  });
  let first;
  let second;
  try {
    const firstPort = createReactionPort(calls);
    firstPort.add = async (effect) => {
      calls.push({ worker: 'worker-a', operation: 'add', effect: structuredClone(effect) });
      return staleAddResult;
    };
    first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: firstPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
      leaseMs: 10,
    });
    await first.accept(acceptedMessage());
    const staleCycle = first.reconcile();
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

    now += 11;
    const secondPort = createReactionPort(calls);
    secondPort.reconcile = async (effect) => {
      calls.push({ worker: 'worker-b', operation: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'reconciled', reactionId: 'takeover-reaction' };
    };
    second = openFeishuReplyPresentation({
      dbPath,
      reactionPort: secondPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-b',
      leaseMs: 10,
    });
    await second.reconcile();
    assert.equal(second.inspect('req-41').presence.reactionId, 'takeover-reaction');

    releaseStaleAdd({ outcome: 'platform_accepted', reactionId: 'stale-reaction' });
    await assert.doesNotReject(staleCycle);
    const finalPresence = first.inspect('req-41').presence;
    assert.equal(finalPresence.status, 'active');
    assert.equal(finalPresence.reactionId, 'takeover-reaction');
    assert.deepEqual(
      calls.map(({ worker, operation }) => `${worker}:${operation}`),
      ['worker-a:add', 'worker-b:reconcile'],
    );
  } finally {
    first?.close();
    second?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a malformed reaction result remains unknown and reconciles before retrying', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-malformed-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const reactionPort = createReactionPort(calls);
    reactionPort.add = async (effect) => {
      calls.push({ operation: 'add', effect: structuredClone(effect) });
      return {};
    };
    reactionPort.reconcile = async (effect) => {
      calls.push({ operation: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'reconciled', reactionId: 'reaction-41' };
    };
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });
    await presentation.accept(acceptedMessage());
    await presentation.reconcile();
    assert.equal(presentation.inspect('req-41').presence.operationStatus, 'unknown');

    now += 1_000;
    await presentation.reconcile();
    assert.equal(presentation.inspect('req-41').presence.status, 'active');
    assert.deepEqual(calls.map((call) => call.operation), ['add', 'reconcile']);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a settlement racing an in-flight reaction add is serialized into one eventual remove', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-race-'));
  const calls = [];
  let releaseAdd;
  const addResult = new Promise((resolve) => {
    releaseAdd = resolve;
  });
  try {
    const reactionPort = createReactionPort(calls);
    reactionPort.add = async (effect) => {
      calls.push({ operation: 'add', effect: structuredClone(effect) });
      return addResult;
    };
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort,
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
    });

    await presentation.accept(acceptedMessage());
    const accepting = presentation.reconcile();
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const settling = presentation.settlePresence({
      requestId: 'req-41',
      signal: deliverySettlement(),
    });
    assert.equal((await settling).status, 'finishing');

    releaseAdd({ outcome: 'platform_accepted', reactionId: 'reaction-41' });
    await accepting;
    assert.equal(presentation.inspect('req-41').presence.status, 'finishing');
    await presentation.reconcile();
    assert.equal(presentation.inspect('req-41').presence.status, 'finished');
    assert.deepEqual(calls.map((call) => call.operation), ['add', 'remove']);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unknown add reconciled as absent after settlement finishes without creating a late reaction', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-presence-absent-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const reactionPort = createReactionPort(calls);
    reactionPort.add = async (effect) => {
      calls.push({ operation: 'add', effect: structuredClone(effect) });
      return { outcome: 'unknown' };
    };
    reactionPort.reconcile = async (effect) => {
      calls.push({ operation: 'reconcile', effect: structuredClone(effect) });
      return { outcome: 'not_found' };
    };
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort,
      cardPort: createCardPort(),
      clock: () => now,
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });
    assert.equal((await presentation.accept(acceptedMessage())).presence.status, 'adding');
    await presentation.reconcile();
    assert.equal(presentation.inspect('req-41').presence.operationStatus, 'unknown');
    assert.equal((await presentation.settlePresence({
      requestId: 'req-41',
      signal: deliverySettlement(),
    })).status, 'finishing');

    now += 1_000;
    await presentation.reconcile();
    assert.equal(presentation.inspect('req-41').presence.status, 'finished');
    assert.deepEqual(calls.map((call) => call.operation), ['add', 'reconcile']);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('progress is durably coalesced with a Core consumer checkpoint and an immediate terminal barrier', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-coalesce-'));
  const cardCalls = [];
  let now = 1_788_000_000_000;
  const cardPort = {
    async apply(operation) {
      cardCalls.push({ operation: 'apply', input: structuredClone(operation) });
      return {
        outcome: 'platform_accepted',
        cardId: operation.cardId ?? 'card-41',
      };
    },
    async reconcile(operation) {
      cardCalls.push({ operation: 'reconcile', input: structuredClone(operation) });
      return { outcome: 'unknown' };
    },
  };
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort,
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    await acceptAndBegin(presentation);

    for (const [sequence, text] of [[1, 'A'], [2, 'B'], [3, 'C']]) {
      presentation.recordProgress({
        requestId: 'req-41',
        presentationId: 'presentation:req-41',
        sequence,
        type: 'OutputDelta',
        payload: { text },
        terminal: false,
      });
    }
    assert.equal(presentation.inspect('req-41').projection.highWatermark, 3);
    assert.equal((await presentation.flushDue()).projection.attempted, 0);
    assert.equal(cardCalls.length, 0);

    now += 500;
    const firstFlush = await presentation.flushDue();
    assert.deepEqual(firstFlush.projection, { attempted: 1, applied: 1, pending: 0 });
    assert.equal(cardCalls.length, 1);
    assert.equal(cardCalls[0].input.kind, 'open');
    assert.equal(cardCalls[0].input.cardKitSequence, 1);
    assert.deepEqual(cardCalls[0].input.events.map((event) => event.sequence), [1, 2, 3]);
    assert.equal(presentation.inspect('req-41').projection.lastAppliedSequence, 3);

    const advanced = presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 5,
      type: 'ProgressUpdated',
      payload: { stage: 'five' },
      terminal: false,
    });
    assert.equal(advanced.projection.highWatermark, 5);
    const stale = presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 4,
      type: 'ProgressUpdated',
      payload: { stage: 'four' },
      terminal: false,
    });
    assert.equal(stale.accepted, false);
    assert.equal(stale.dropped, true);
    assert.equal(presentation.inspect('req-41').projection.highWatermark, 5);

    const terminal = presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 6,
      type: 'ProjectionTerminal',
      payload: { stage: 'complete' },
      terminal: true,
    });
    assert.equal(terminal.flushDue, true);
    assert.equal(cardCalls.length, 1, 'recording terminal must not block on CardKit');

    const terminalFlush = await presentation.flushDue();
    assert.deepEqual(terminalFlush.projection, { attempted: 1, applied: 1, pending: 0 });
    assert.equal(cardCalls[1].input.kind, 'finalize');
    assert.equal(cardCalls[1].input.cardKitSequence, 2);
    assert.deepEqual(cardCalls[1].input.events.map((event) => event.sequence), [5, 6]);
    const snapshot = presentation.inspect('req-41').projection;
    assert.equal(snapshot.status, 'terminal');
    assert.equal(snapshot.highWatermark, 6);
    assert.equal(snapshot.lastAppliedSequence, 6);
    assert.equal(snapshot.cardKitSequence, 2);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a late terminal barrier fails closed when higher sequences were already observed', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-terminal-'));
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: createCardPort(),
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    await acceptAndBegin(presentation);
    for (const sequence of [4, 5]) {
      presentation.recordProgress({
        requestId: 'req-41',
        presentationId: 'presentation:req-41',
        sequence,
        type: 'ProgressUpdated',
        payload: { stage: `stage-${sequence}` },
        terminal: false,
      });
    }
    assert.throws(
      () => presentation.recordProgress({
        requestId: 'req-41',
        presentationId: 'presentation:req-41',
        sequence: 3,
        type: 'ProjectionTerminal',
        payload: { stage: 'complete' },
        terminal: true,
      }),
      (error) => error.code === 'TERMINAL_CONFLICT',
    );
    const checkpoint = presentation.inspect('req-41').projection;
    assert.equal(checkpoint.terminalSequence, null);
    assert.equal(checkpoint.highWatermark, 5);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a CardKit transport exception reconciles after restart with the same operation and sequence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-ambiguous-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  let now = 1_788_000_000_000;
  const event = {
    requestId: 'req-41',
    presentationId: 'presentation:req-41',
    sequence: 1,
    type: 'ProgressUpdated',
    payload: { stage: 'working' },
    terminal: false,
  };
  try {
    const first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ operation: 'apply', input: structuredClone(operation) });
          throw new Error('socket timeout after card request write');
        },
        async reconcile(operation) {
          calls.push({ operation: 'unexpected-reconcile', input: structuredClone(operation) });
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
      retryDelayMs: 1_000,
    });
    await acceptAndBegin(first);
    first.recordProgress(event);
    now += 500;
    await first.flushDue();
    const ambiguous = first.inspect('req-41').projection;
    assert.equal(ambiguous.status, 'degraded');
    assert.equal(ambiguous.lastAppliedSequence, 0);
    assert.equal(ambiguous.cardKitSequence, 1);
    assert.equal(ambiguous.operationStatus, 'unknown');
    first.close();

    now += 1_000;
    const reopened = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ operation: 'unexpected-apply', input: structuredClone(operation) });
          return { outcome: 'platform_accepted', cardId: 'card-duplicate' };
        },
        async reconcile(operation) {
          calls.push({ operation: 'reconcile', input: structuredClone(operation) });
          return { outcome: 'reconciled', cardId: 'card-41' };
        },
      },
      clock: () => now,
      workerId: 'worker-b',
      coalesceMs: 500,
      retryDelayMs: 1_000,
    });
    await reopened.reconcile();
    const recovered = reopened.inspect('req-41').projection;
    assert.equal(recovered.status, 'active');
    assert.equal(recovered.lastAppliedSequence, 1);
    assert.equal(recovered.cardKitSequence, 1);
    assert.equal(recovered.cardId, 'card-41');
    assert.deepEqual(calls.map((call) => call.operation), ['apply', 'reconcile']);
    assert.equal(calls[0].input.operationId, calls[1].input.operationId);
    assert.equal(calls[0].input.cardKitSequence, calls[1].input.cardKitSequence);

    const replay = reopened.recordProgress(event);
    assert.equal(replay.replayed, true);
    assert.equal((await reopened.flushDue()).projection.attempted, 0);
    assert.equal(calls.length, 2);
    assert.throws(
      () => reopened.recordProgress({ ...event, payload: { stage: 'different' } }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired projection lease fences a late ACK and the next cycle reconciles without crashing', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-expiry-'));
  const calls = [];
  let now = 1_788_000_000_000;
  let releaseApply;
  const applyResult = new Promise((resolve) => {
    releaseApply = resolve;
  });
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ operation: 'apply', input: structuredClone(operation) });
          return applyResult;
        },
        async reconcile(operation) {
          calls.push({ operation: 'reconcile', input: structuredClone(operation) });
          return { outcome: 'reconciled', cardId: 'card-after-reconcile' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      leaseMs: 10,
      coalesceMs: 500,
    });
    await acceptAndBegin(presentation);
    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 1,
      type: 'ProgressUpdated',
      payload: { stage: 'working' },
      terminal: false,
    });
    now += 500;
    const staleCycle = presentation.flushDue();
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    now += 11;
    releaseApply({ outcome: 'platform_accepted', cardId: 'stale-card' });

    await assert.doesNotReject(staleCycle);
    const expired = presentation.inspect('req-41').projection;
    assert.equal(expired.operationStatus, 'inflight');
    assert.equal(expired.lastAppliedSequence, 0);
    assert.equal(expired.cardId, null);

    await presentation.flushDue();
    const recovered = presentation.inspect('req-41').projection;
    assert.equal(recovered.status, 'active');
    assert.equal(recovered.lastAppliedSequence, 1);
    assert.equal(recovered.cardId, 'card-after-reconcile');
    assert.deepEqual(calls.map(({ operation }) => operation), ['apply', 'reconcile']);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a projection lease takeover keeps the new worker result when the old worker ACK arrives late', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-takeover-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  let now = 1_788_000_000_000;
  let releaseStaleApply;
  const staleApplyResult = new Promise((resolve) => {
    releaseStaleApply = resolve;
  });
  let first;
  let second;
  try {
    first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ worker: 'worker-a', operation: 'apply', input: structuredClone(operation) });
          return staleApplyResult;
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      leaseMs: 10,
      coalesceMs: 500,
    });
    await acceptAndBegin(first);
    first.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 1,
      type: 'ProgressUpdated',
      payload: { stage: 'working' },
      terminal: false,
    });
    now += 500;
    const staleCycle = first.flushDue();
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

    now += 11;
    second = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply() {
          return { outcome: 'platform_accepted', cardId: 'unexpected-card' };
        },
        async reconcile(operation) {
          calls.push({ worker: 'worker-b', operation: 'reconcile', input: structuredClone(operation) });
          return { outcome: 'reconciled', cardId: 'takeover-card' };
        },
      },
      clock: () => now,
      workerId: 'worker-b',
      leaseMs: 10,
      coalesceMs: 500,
    });
    await second.flushDue();
    assert.equal(second.inspect('req-41').projection.cardId, 'takeover-card');

    releaseStaleApply({ outcome: 'platform_accepted', cardId: 'stale-card' });
    await assert.doesNotReject(staleCycle);
    const finalProjection = first.inspect('req-41').projection;
    assert.equal(finalProjection.status, 'active');
    assert.equal(finalProjection.cardId, 'takeover-card');
    assert.equal(finalProjection.lastAppliedSequence, 1);
    assert.deepEqual(
      calls.map(({ worker, operation }) => `${worker}:${operation}`),
      ['worker-a:apply', 'worker-b:reconcile'],
    );
  } finally {
    first?.close();
    second?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an accepted card create without a valid identity remains unknown until reconciliation binds it', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-identity-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ operation: 'apply', input: structuredClone(operation) });
          return { outcome: 'platform_accepted', cardId: '' };
        },
        async reconcile(operation) {
          calls.push({ operation: 'reconcile', input: structuredClone(operation) });
          return { outcome: 'reconciled', cardId: 'card-41' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
      retryDelayMs: 1_000,
    });
    await acceptAndBegin(presentation);
    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 1,
      type: 'ProgressUpdated',
      payload: { stage: 'working' },
      terminal: false,
    });
    now += 500;
    const unresolved = await presentation.flushDue();
    assert.deepEqual(unresolved.projection, { attempted: 1, applied: 0, pending: 1 });
    assert.equal(presentation.inspect('req-41').projection.operationStatus, 'unknown');
    assert.equal(presentation.inspect('req-41').projection.lastAppliedSequence, 0);

    now += 1_000;
    await presentation.reconcile();
    const bound = presentation.inspect('req-41').projection;
    assert.equal(bound.cardId, 'card-41');
    assert.equal(bound.lastAppliedSequence, 1);
    assert.deepEqual(calls.map((call) => call.operation), ['apply', 'reconcile']);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CardKit rate limits degrade only projection and never block final settlement', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-isolation-'));
  const reactionCalls = [];
  const cardCalls = [];
  let now = 1_788_000_000_000;
  let rateLimited = true;
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort(reactionCalls),
      cardPort: {
        async apply(operation) {
          cardCalls.push(structuredClone(operation));
          if (rateLimited) {
            return {
              outcome: 'rejected',
              errorCode: 'RATE_LIMITED',
              retryable: true,
              retryAfterMs: 1_000,
            };
          }
          return { outcome: 'platform_accepted', cardId: 'card-41' };
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
      retryDelayMs: 1_000,
    });
    await acceptAndBegin(presentation);
    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 1,
      type: 'OutputDelta',
      payload: { text: 'working' },
      terminal: false,
    });
    now += 500;
    const failedFlush = await presentation.flushDue();
    assert.deepEqual(failedFlush.projection, { attempted: 1, applied: 0, pending: 1 });
    const degraded = presentation.inspect('req-41');
    assert.equal(degraded.projection.status, 'degraded');
    assert.equal(degraded.projection.operationStatus, 'pending');
    assert.equal(degraded.projection.lastAppliedSequence, 0);
    assert.equal(degraded.presence.status, 'active');
    assert.equal(Object.hasOwn(degraded, 'executionStatus'), false);
    assert.equal(Object.hasOwn(degraded, 'deliveryStatus'), false);

    const finished = await presentation.settlePresence({
      requestId: 'req-41',
      signal: deliverySettlement(),
    });
    assert.equal(finished.status, 'finished');
    assert.equal(presentation.inspect('req-41').projection.status, 'degraded');
    assert.equal(cardCalls.length, 1, 'presence settlement must not drive CardKit');

    rateLimited = false;
    now += 1_000;
    const retried = await presentation.flushDue();
    assert.deepEqual(retried.projection, { attempted: 1, applied: 1, pending: 0 });
    assert.equal(presentation.inspect('req-41').projection.status, 'active');
    assert.equal(presentation.inspect('req-41').presence.status, 'finished');
    assert.equal(cardCalls.length, 2);
    assert.equal(cardCalls[0].operationId, cardCalls[1].operationId);
    assert.equal(cardCalls[0].cardKitSequence, cardCalls[1].cardKitSequence);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('progress arriving during an in-flight CardKit update is retained for the next flush', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-projection-race-'));
  const calls = [];
  let now = 1_788_000_000_000;
  let releaseFirst;
  const firstResult = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push(structuredClone(operation));
          if (calls.length === 1) return firstResult;
          return { outcome: 'platform_accepted', cardId: 'card-41' };
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    await acceptAndBegin(presentation);
    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 1,
      type: 'OutputDelta',
      payload: { text: 'first' },
      terminal: false,
    });
    now += 500;
    const firstFlush = presentation.flushDue();
    while (calls.length === 0) await new Promise((resolve) => setImmediate(resolve));

    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 2,
      type: 'OutputDelta',
      payload: { text: 'second' },
      terminal: false,
    });
    releaseFirst({ outcome: 'platform_accepted', cardId: 'card-41' });
    await firstFlush;
    let checkpoint = presentation.inspect('req-41').projection;
    assert.equal(checkpoint.highWatermark, 2);
    assert.equal(checkpoint.lastAppliedSequence, 1);
    assert.equal(checkpoint.cardKitSequence, 1);

    now += 500;
    await presentation.flushDue();
    checkpoint = presentation.inspect('req-41').projection;
    assert.equal(checkpoint.lastAppliedSequence, 2);
    assert.equal(checkpoint.cardKitSequence, 2);
    assert.deepEqual(calls[1].events.map((event) => event.sequence), [2]);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a terminal-only projection opens a card before finalizing it with a higher CardKit sequence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-terminal-first-'));
  const calls = [];
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push(structuredClone(operation));
          if (operation.kind === 'finalize' && operation.cardId === null) {
            const error = new Error('finalize requires card identity');
            error.outcome = 'rejected';
            error.code = 'CARD_ID_REQUIRED';
            throw error;
          }
          if (operation.kind === 'open') {
            return { outcome: 'platform_accepted', cardId: 'card-terminal-first' };
          }
          return { outcome: 'platform_accepted' };
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    await acceptAndBegin(presentation);
    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 6,
      type: 'ProjectionTerminal',
      payload: { stage: 'complete' },
      terminal: true,
    });

    assert.deepEqual((await presentation.flushDue()).projection, {
      attempted: 1,
      applied: 1,
      pending: 0,
    });
    assert.equal(presentation.inspect('req-41').projection.cardId, 'card-terminal-first');
    assert.deepEqual((await presentation.flushDue()).projection, {
      attempted: 1,
      applied: 1,
      pending: 0,
    });
    assert.deepEqual(
      calls.map(({ kind, cardId, cardKitSequence }) => ({ kind, cardId, cardKitSequence })),
      [
        { kind: 'open', cardId: null, cardKitSequence: 1 },
        { kind: 'finalize', cardId: 'card-terminal-first', cardKitSequence: 2 },
      ],
    );
    const checkpoint = presentation.inspect('req-41').projection;
    assert.equal(checkpoint.status, 'terminal');
    assert.equal(checkpoint.lastAppliedSequence, 6);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a progress consumer starts from the first visible Core sequence instead of waiting for sequence one', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-core-checkpoint-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push(structuredClone(operation));
          return { outcome: 'platform_accepted', cardId: 'card-core-checkpoint' };
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    await acceptAndBegin(presentation);
    presentation.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 4,
      type: 'ProgressUpdated',
      payload: { stage: 'working' },
      terminal: false,
    });

    const recorded = presentation.inspect('req-41').projection;
    assert.equal(recorded.highWatermark, 4);
    assert.equal(recorded.lastAppliedSequence, 0);
    now += 500;
    assert.deepEqual((await presentation.flushDue()).projection, {
      attempted: 1,
      applied: 1,
      pending: 0,
    });
    assert.deepEqual(calls[0].events.map((event) => event.sequence), [4]);
    assert.equal(presentation.inspect('req-41').projection.lastAppliedSequence, 4);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('out-of-order Core progress cannot regress a terminal checkpoint across restart', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-core-reorder-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  const cardPort = {
    async apply(operation) {
      calls.push(structuredClone(operation));
      if (operation.kind === 'open') {
        return { outcome: 'platform_accepted', cardId: 'card-core-reorder' };
      }
      return { outcome: 'platform_accepted' };
    },
    async reconcile() {
      return { outcome: 'unknown' };
    },
  };
  try {
    const first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort,
      clock: () => 1_788_000_000_000,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    await acceptAndBegin(first);
    const progress = {
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 4,
      type: 'ProgressUpdated',
      payload: { stage: 'working' },
      terminal: false,
    };
    first.recordProgress(progress);
    first.recordProgress({
      ...progress,
      sequence: 6,
      type: 'ProjectionTerminal',
      payload: { stage: 'complete' },
      terminal: true,
    });
    const late = first.recordProgress({
      ...progress,
      sequence: 5,
      type: 'OutputDelta',
      payload: { text: 'late draft' },
    });
    assert.equal(late.accepted, false);
    assert.equal(late.dropped, true);
    assert.equal(late.projection.highWatermark, 6);

    assert.deepEqual((await first.flushDue()).projection, {
      attempted: 1,
      applied: 1,
      pending: 0,
    });
    assert.equal(first.inspect('req-41').projection.cardId, 'card-core-reorder');
    assert.deepEqual(calls[0].events.map((event) => event.sequence), [4, 6]);
    first.close();

    const reopened = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort,
      clock: () => 1_788_000_001_000,
      workerId: 'worker-b',
      coalesceMs: 500,
    });
    assert.deepEqual((await reopened.flushDue()).projection, {
      attempted: 1,
      applied: 1,
      pending: 0,
    });
    assert.deepEqual(calls[1].events.map((event) => event.sequence), [4, 6]);
    assert.equal(calls[1].cardId, 'card-core-reorder');
    assert.equal(calls[1].cardKitSequence, 2);
    assert.equal(reopened.inspect('req-41').projection.lastAppliedSequence, 6);

    assert.equal(reopened.recordProgress(progress).replayed, true);
    assert.throws(
      () => reopened.recordProgress({ ...progress, payload: { stage: 'conflict' } }),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('projection operation identity hashes the canonical tuple without colon collisions', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-operation-identity-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push(structuredClone(operation));
          return { outcome: 'platform_accepted', cardId: `card:${operation.requestId}` };
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    const handles = [
      acceptedMessage({
        ingressId: 'inbox:tuple-a',
        requestId: 'req:a',
        sourceMessageId: 'om-tuple-a',
        presentationId: 'b',
        presenceId: 'presence:tuple-a',
      }),
      acceptedMessage({
        ingressId: 'inbox:tuple-b',
        requestId: 'req',
        sourceMessageId: 'om-tuple-b',
        presentationId: 'a:b',
        presenceId: 'presence:tuple-b',
      }),
    ];
    for (const handle of handles) {
      await presentation.accept(handle);
      presentation.recordProgress({
        requestId: handle.requestId,
        presentationId: handle.presentationId,
        sequence: 4,
        type: 'ProgressUpdated',
        payload: { stage: 'working' },
        terminal: false,
      });
    }
    now += 500;
    assert.equal((await presentation.flushDue()).projection.applied, 2);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].operationId, calls[1].operationId);
    for (const call of calls) {
      assert.match(call.operationId, /^projection:sha256:[a-f0-9]{64}$/);
    }
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal card creation with an ambiguous ACK reconciles after restart without opening twice', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-terminal-ambiguous-'));
  const dbPath = path.join(directory, 'presentation.db');
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const first = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ method: 'apply', operation: structuredClone(operation) });
          throw new Error('socket timeout after CardKit create');
        },
        async reconcile() {
          throw new Error('unexpected reconcile before restart');
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      retryDelayMs: 1_000,
    });
    await acceptAndBegin(first);
    first.recordProgress({
      requestId: 'req-41',
      presentationId: 'presentation:req-41',
      sequence: 6,
      type: 'ProjectionTerminal',
      payload: { stage: 'complete' },
      terminal: true,
    });
    assert.equal((await first.flushDue()).projection.pending, 1);
    assert.equal(first.inspect('req-41').projection.operationStatus, 'unknown');
    first.close();

    now += 1_000;
    const reopened = openFeishuReplyPresentation({
      dbPath,
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push({ method: 'apply', operation: structuredClone(operation) });
          return { outcome: 'platform_accepted' };
        },
        async reconcile(operation) {
          calls.push({ method: 'reconcile', operation: structuredClone(operation) });
          return { outcome: 'reconciled', cardId: 'card-terminal-ambiguous' };
        },
      },
      clock: () => now,
      workerId: 'worker-b',
      retryDelayMs: 1_000,
    });
    assert.equal((await reopened.reconcile()).projection.applied, 1);
    assert.equal(reopened.inspect('req-41').projection.cardId, 'card-terminal-ambiguous');
    assert.equal((await reopened.flushDue()).projection.applied, 1);
    assert.deepEqual(calls.map(({ method, operation }) => ({
      method,
      kind: operation.kind,
      operationId: operation.operationId,
      cardKitSequence: operation.cardKitSequence,
      cardId: operation.cardId,
    })), [
      {
        method: 'apply',
        kind: 'open',
        operationId: calls[0].operation.operationId,
        cardKitSequence: 1,
        cardId: null,
      },
      {
        method: 'reconcile',
        kind: 'open',
        operationId: calls[0].operation.operationId,
        cardKitSequence: 1,
        cardId: null,
      },
      {
        method: 'apply',
        kind: 'finalize',
        operationId: calls[2].operation.operationId,
        cardKitSequence: 2,
        cardId: 'card-terminal-ambiguous',
      },
    ]);
    assert.notEqual(calls[2].operation.operationId, calls[0].operation.operationId);
    assert.equal(calls.filter(({ operation }) => operation.kind === 'open').length, 2);
    assert.equal(calls.filter(({ method, operation }) => (
      method === 'apply' && operation.kind === 'open'
    )).length, 1);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a terminal barrier is claimed before older due progress from another presentation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-terminal-priority-'));
  const calls = [];
  let now = 1_788_000_000_000;
  try {
    const presentation = openFeishuReplyPresentation({
      dbPath: path.join(directory, 'presentation.db'),
      reactionPort: createReactionPort([]),
      cardPort: {
        async apply(operation) {
          calls.push(structuredClone(operation));
          return { outcome: 'platform_accepted', cardId: `card:${operation.requestId}` };
        },
        async reconcile() {
          return { outcome: 'unknown' };
        },
      },
      clock: () => now,
      workerId: 'worker-a',
      coalesceMs: 500,
    });
    for (const requestId of ['req-a-progress', 'req-z-terminal']) {
      await presentation.accept(acceptedMessage({
        ingressId: `inbox:${requestId}`,
        requestId,
        sourceMessageId: `om:${requestId}`,
        presentationId: `presentation:${requestId}`,
        presenceId: `presence:${requestId}`,
      }));
    }
    presentation.recordProgress({
      requestId: 'req-a-progress',
      presentationId: 'presentation:req-a-progress',
      sequence: 4,
      type: 'ProgressUpdated',
      payload: { stage: 'working' },
      terminal: false,
    });
    now += 500;
    presentation.recordProgress({
      requestId: 'req-z-terminal',
      presentationId: 'presentation:req-z-terminal',
      sequence: 6,
      type: 'ProjectionTerminal',
      payload: { stage: 'complete' },
      terminal: true,
    });

    assert.equal((await presentation.flushDue({ limit: 1 })).projection.attempted, 1);
    assert.equal(calls[0].requestId, 'req-z-terminal');
    assert.equal(calls[0].kind, 'open');
    assert.equal(presentation.inspect('req-a-progress').projection.lastAppliedSequence, 0);
    presentation.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
