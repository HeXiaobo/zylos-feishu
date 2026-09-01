import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeishuTaskEffectAdapter,
  processFeishuTaskEffectsOnce,
} from '../src/lib/feishu-task-effect-adapter.js';

function effect(version, overrides = {}) {
  return {
    schemaVersion: 1,
    type: 'TaskEffect',
    effectId: `effect-task-1-v${version}`,
    requestId: `req-task-1-v${version}`,
    traceId: `trace:req-task-1-v${version}`,
    source: {
      adapterId: 'feishu', accountRef: 'acct-1', eventType: 'task.command_v1',
      eventId: `evt-task-1-v${version}`, messageId: 'msg-task-1',
    },
    actor: {
      provider: 'feishu', tenantRef: 'tenant-1', externalId: 'user-1',
      provenance: 'verified_channel_actor',
    },
    taskId: 'task-1',
    coreVersion: version,
    origin: 'structured_action',
    eventId: `task-event-v${version}`,
    task: {
      id: 'task-1', version, title: 'Durable projection',
      state: version === 1 ? 'ready' : 'in_progress',
    },
    ...overrides,
  };
}

function harness() {
  let remote = null;
  const calls = [];
  const gateway = {
    async findTasksByCoreTaskId(taskId) {
      calls.push(['find', taskId]);
      return remote === null ? [] : [structuredClone(remote)];
    },
    async createTask(input) {
      calls.push(['create', input]);
      remote = {
        guid: 'guid-task-1', url: 'https://example.invalid/task-1',
        coreTaskId: input.task.id,
        coreTaskVersion: input.task.version,
        ...input.effectIdentity,
      };
      return structuredClone(remote);
    },
    async updateTask(input) {
      calls.push(['update', input]);
      remote = {
        ...remote,
        coreTaskVersion: input.task.version,
        ...input.effectIdentity,
      };
      return structuredClone(remote);
    },
  };
  const adapter = () => createFeishuTaskEffectAdapter({
    gateway,
    memberMapper: { map: () => [] },
    identity: { tenantRef: 'tenant-1', accountRef: 'acct-1' },
  });
  return { adapter, calls, get remote() { return remote; }, set remote(value) { remote = value; } };
}

test('TaskEffect create/update/replay use stable identity and never regress out of order', async () => {
  const state = harness();
  const adapter = state.adapter();
  const created = await adapter.apply({
    effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
  });
  assert.equal(created.outcome, 'platform_accepted');
  assert.equal(created.externalTaskId, 'guid-task-1');
  assert.equal(created.externalVersion, 1);
  assert.equal(created.effectId, 'effect-task-1-v1');

  const updated = await adapter.apply({
    effect: effect(2), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
  });
  assert.equal(updated.outcome, 'platform_accepted');
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 1);

  const restarted = state.adapter();
  const replay = await restarted.apply({
    effect: effect(2), attempt: 2, leaseEpoch: 2, workerId: 'worker-b', generation: 0,
  });
  assert.equal(replay.outcome, 'reconciled');
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 1);

  const stale = await restarted.apply({
    effect: effect(1), attempt: 3, leaseEpoch: 3, workerId: 'worker-c', generation: 0,
  });
  assert.equal(stale.outcome, 'suppressed');
  assert.equal(stale.externalVersion, 2);
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 1);
});

test('unknown retry reconciles exact effect before I/O and identity payload conflict fails closed', async () => {
  const state = harness();
  const first = state.adapter();
  await first.apply({
    effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
  });
  const creates = state.calls.filter(([name]) => name === 'create').length;

  const recovered = await state.adapter().apply({
    effect: effect(1), attempt: 2, leaseEpoch: 2, workerId: 'worker-b', generation: 0,
  });
  assert.equal(recovered.outcome, 'reconciled');
  assert.equal(state.calls.filter(([name]) => name === 'create').length, creates);

  state.remote.payloadHash = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  await assert.rejects(
    () => state.adapter().reconcile(effect(1)),
    error => error?.code === 'IDEMPOTENCY_CONFLICT' && error?.retryable === false,
  );

  state.remote = {
    ...state.remote,
    effectId: 'effect-other',
    tenantRef: 'tenant-other',
  };
  await assert.rejects(
    () => state.adapter().reconcile(effect(2)),
    error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT' && error?.retryable === false,
  );
});

test('TaskEffect worker fences acknowledgement before receipt and reconciles unknown exactly', async () => {
  const taskEffect = effect(1);
  const calls = [];
  const effects = {
    claim() {
      return [{
        effect: taskEffect, attempt: 1, leaseEpoch: 4, workerId: 'worker-a', generation: 0,
      }];
    },
    acknowledge(request) {
      calls.push(['ack', request]);
      return { status: 'acknowledged' };
    },
    fail(request) {
      calls.push(['fail', request]);
      return { status: request.classification === 'unknown' ? 'unknown' : 'retry_wait' };
    },
    reconcile(request) {
      calls.push(['reconcile', request]);
      return { status: 'acknowledged' };
    },
  };
  const unknown = new Error('response contained token=secret and a task body');
  unknown.outcome = 'unknown';
  const summary = await processFeishuTaskEffectsOnce({
    effects,
    workerId: 'worker-a',
    leaseMs: 5_000,
    adapter: {
      async apply() { throw unknown; },
      async reconcile(observed) {
        assert.equal(observed.effectId, taskEffect.effectId);
        return {
          outcome: 'reconciled', effectId: taskEffect.effectId,
          externalTaskId: 'guid-task-1', externalVersion: 1,
        };
      },
    },
    taskReceiptDelivery: {
      async send(request) { calls.push(['receipt', request]); return { success: true }; },
    },
    routeForEffect: () => ({ adapterId: 'feishu', targetRef: 'opaque:reply-1' }),
  });
  assert.equal(summary.reconciled, 1);
  assert.deepEqual(calls.map(([name]) => name), ['fail', 'reconcile', 'receipt']);
  assert.equal(calls[0][1].classification, 'unknown');
  assert.doesNotMatch(calls[0][1].error, /secret|task body/);
});

test('lost TaskEffect lease never delivers a task receipt and retries are bounded', async () => {
  const calls = [];
  const leaseLost = new Error('stale owner');
  leaseLost.code = 'EFFECT_LEASE_LOST';
  const summary = await processFeishuTaskEffectsOnce({
    effects: {
      claim: () => [{
        effect: effect(1), attempt: 3, leaseEpoch: 1, workerId: 'stale-worker', generation: 0,
      }],
      acknowledge() { throw leaseLost; },
      fail(request) { calls.push(['fail', request]); return { status: 'dead_letter' }; },
      reconcile() { throw new Error('must not reconcile'); },
    },
    workerId: 'stale-worker',
    leaseMs: 5_000,
    maxAttempts: 3,
    adapter: {
      async apply() {
        return {
          outcome: 'platform_accepted', effectId: effect(1).effectId,
          externalTaskId: 'guid-task-1', externalVersion: 1,
        };
      },
      async reconcile() { throw new Error('must not reconcile'); },
    },
    taskReceiptDelivery: {
      async send() { calls.push(['receipt']); },
    },
    routeForEffect: () => ({ adapterId: 'feishu', targetRef: 'opaque:reply-1' }),
  });
  assert.equal(summary.leaseLost, 1);
  assert.equal(calls.some(([name]) => name === 'receipt'), false);

  const bounded = [];
  const outage = new Error('platform unavailable');
  outage.retryable = true;
  const exhausted = await processFeishuTaskEffectsOnce({
    effects: {
      claim: () => [{
        effect: effect(1), attempt: 3, leaseEpoch: 3, workerId: 'worker-final', generation: 0,
      }],
      acknowledge() { throw new Error('must not acknowledge'); },
      fail(request) { bounded.push(request); return { status: 'dead_letter' }; },
      reconcile() { throw new Error('must not reconcile'); },
    },
    workerId: 'worker-final',
    leaseMs: 5_000,
    maxAttempts: 3,
    adapter: {
      async apply() { throw outage; },
      async reconcile() { throw new Error('must not reconcile'); },
    },
    taskReceiptDelivery: { async send() { throw new Error('must not send'); } },
    routeForEffect: () => ({ adapterId: 'feishu', targetRef: 'opaque:reply-1' }),
  });
  assert.equal(exhausted.deadLettered, 1);
  assert.equal(bounded[0].classification, 'permanent');
});
