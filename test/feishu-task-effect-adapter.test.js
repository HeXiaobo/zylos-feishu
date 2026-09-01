import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeishuTaskEffectAdapter,
  processFeishuTaskEffectsOnce,
} from '../src/lib/feishu-task-effect-adapter.js';
import { taskEffectPayloadHash } from '../src/lib/task-effect-settlement.js';

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
  const adapter = (options = {}) => createFeishuTaskEffectAdapter({
    gateway,
    memberMapper: { map: () => [] },
    identity: { tenantRef: 'tenant-1', accountRef: 'acct-1' },
    ...options,
  });
  return { adapter, calls, get remote() { return remote; }, set remote(value) { remote = value; } };
}

test('partial or mismatched native Task markers always fail closed before update', async () => {
  const targetEffect = effect(2);
  const exact = {
    guid: 'guid-task-1',
    url: 'https://example.invalid/task-1',
    coreTaskId: 'task-1',
    coreTaskVersion: 2,
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    effectId: targetEffect.effectId,
    payloadHash: taskEffectPayloadHash(targetEffect),
  };
  const variants = [];
  for (const field of [
    'coreTaskId',
    'coreTaskVersion',
    'tenantRef',
    'accountRef',
    'effectId',
    'payloadHash',
  ]) {
    variants.push({ name: `${field}=null`, remote: { ...exact, [field]: null } });
    const missing = { ...exact };
    delete missing[field];
    variants.push({ name: `${field}=missing`, remote: missing });
  }
  variants.push(
    { name: 'coreTaskId=different', remote: { ...exact, coreTaskId: 'task-other' } },
    { name: 'coreTaskVersion=different', remote: { ...exact, coreTaskVersion: 3 } },
    { name: 'tenantRef=different', remote: { ...exact, tenantRef: 'tenant-other' } },
    { name: 'accountRef=different', remote: { ...exact, accountRef: 'acct-other' } },
    { name: 'effectId=different', remote: { ...exact, effectId: 'effect-other' } },
    {
      name: 'payloadHash=different',
      remote: {
        ...exact,
        payloadHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
  );

  for (const variant of variants) {
    const state = harness();
    state.remote = variant.remote;
    await assert.rejects(
      () => state.adapter().apply({
        effect: targetEffect,
        attempt: 1,
        leaseEpoch: 1,
        workerId: 'worker-a',
        generation: 0,
      }),
      error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT'
        && error?.retryable === false,
      variant.name,
    );
    assert.equal(
      state.calls.filter(([name]) => name === 'update').length,
      0,
      variant.name,
    );
  }
});

test('partial marker stays fail-closed across concurrent apply and restart replay', async () => {
  const state = harness();
  state.remote = {
    guid: 'guid-task-1',
    url: 'https://example.invalid/task-1',
    coreTaskId: 'task-1',
    coreTaskVersion: 1,
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    effectId: null,
    payloadHash: null,
  };
  const claim = (workerId, leaseEpoch, generation) => ({
    effect: effect(1),
    attempt: leaseEpoch,
    leaseEpoch,
    workerId,
    generation,
  });

  const concurrent = await Promise.allSettled([
    state.adapter().apply(claim('worker-a', 1, 0)),
    state.adapter().apply(claim('worker-b', 2, 1)),
  ]);
  for (const result of concurrent) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason?.code, 'EXTERNAL_IDENTITY_CONFLICT');
  }
  await assert.rejects(
    () => state.adapter().apply(claim('worker-restarted', 3, 2)),
    error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT'
      && error?.retryable === false,
  );
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 0);
});

test('legacy Task marker requires a separate durable adoption transaction', async () => {
  const state = harness();
  state.remote = {
    guid: 'guid-task-1',
    url: 'https://example.invalid/task-1',
    coreTaskId: 'task-1',
    coreTaskVersion: 1,
    tenantRef: null,
    accountRef: null,
    effectId: null,
    payloadHash: null,
  };

  await assert.rejects(
    () => state.adapter().apply({
      effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
    }),
    error => error?.code === 'LEGACY_PROJECTION_REQUIRES_ADOPTION'
      && error?.retryable === false,
  );
  assert.equal(state.calls.some(([name]) => name === 'update'), false);
});

test('malformed legacy-style markers are external conflicts, never adoption candidates', async () => {
  const invalidBaseFields = [
    ['coreTaskId=empty', { coreTaskId: '' }],
    ['coreTaskId=whitespace', { coreTaskId: ' task-1' }],
    ['coreTaskId=String object', { coreTaskId: new String('task-1') }],
    ['coreTaskVersion=missing', { coreTaskVersion: undefined }],
    ['coreTaskVersion=null', { coreTaskVersion: null }],
    ['coreTaskVersion=string', { coreTaskVersion: '1' }],
    ['coreTaskVersion=zero', { coreTaskVersion: 0 }],
    ['coreTaskVersion=negative', { coreTaskVersion: -1 }],
    ['coreTaskVersion=fractional', { coreTaskVersion: 1.5 }],
    ['coreTaskVersion=NaN', { coreTaskVersion: Number.NaN }],
    ['coreTaskVersion=Infinity', { coreTaskVersion: Number.POSITIVE_INFINITY }],
    ['coreTaskVersion=unsafe', { coreTaskVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['coreTaskVersion=Number object', { coreTaskVersion: new Number(1) }],
  ];

  for (const [name, override] of invalidBaseFields) {
    const state = harness();
    state.remote = {
      guid: 'guid-task-1',
      url: 'https://example.invalid/task-1',
      coreTaskId: 'task-1',
      coreTaskVersion: 1,
      tenantRef: null,
      accountRef: null,
      effectId: null,
      payloadHash: null,
      ...override,
    };
    await assert.rejects(
      () => state.adapter().apply({
        effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
      }),
      error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT'
        && error?.retryable === false,
      name,
    );
    assert.equal(state.calls.filter(([operation]) => operation === 'update').length, 0, name);
  }
});

test('legacy Task marker cannot be adopted concurrently through the TaskEffect adapter', async () => {
  const state = harness();
  state.remote = {
    guid: 'guid-task-1',
    url: 'https://example.invalid/task-1',
    coreTaskId: 'task-1',
    coreTaskVersion: 1,
    tenantRef: null,
    accountRef: null,
    effectId: null,
    payloadHash: null,
  };
  let authorizations = 0;
  const options = {
    legacyProjectionAdoption: {
      async authorize() {
        authorizations += 1;
        return { authorized: true, adoptionId: 'migration-legacy-task-1' };
      },
    },
  };

  const results = await Promise.allSettled([
    state.adapter(options).apply({
      effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
    }),
    state.adapter(options).apply({
      effect: effect(1), attempt: 2, leaseEpoch: 2, workerId: 'worker-b', generation: 1,
    }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  for (const result of results) {
    assert.equal(result.reason?.code, 'LEGACY_PROJECTION_REQUIRES_ADOPTION');
  }
  assert.equal(authorizations, 0);
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 0);
});

test('removed legacy adoption option cannot authorize an update after restart or replay', async () => {
  const state = harness();
  state.remote = {
    guid: 'guid-task-1',
    url: 'https://example.invalid/task-1',
    coreTaskId: 'task-1',
    coreTaskVersion: 1,
    tenantRef: null,
    accountRef: null,
    effectId: null,
    payloadHash: null,
  };
  let authorizations = 0;
  const options = {
    legacyProjectionAdoption: {
      async authorize() {
        authorizations += 1;
        return { authorized: true, adoptionId: 'migration-legacy-task-1' };
      },
    },
  };

  for (const [index, adapter] of [state.adapter(options), state.adapter(options)].entries()) {
    await assert.rejects(
      () => adapter.apply({
        effect: effect(1),
        attempt: index + 1,
        leaseEpoch: index + 1,
        workerId: `worker-${index + 1}`,
        generation: index,
      }),
      error => error?.code === 'LEGACY_PROJECTION_REQUIRES_ADOPTION',
    );
  }
  assert.equal(authorizations, 0);
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 0);
});

test('legacy marker for another Core task cannot be adopted by a permissive old strategy', async () => {
  const state = harness();
  state.remote = {
    guid: 'guid-other-task',
    url: 'https://example.invalid/other-task',
    coreTaskId: 'task-other',
    coreTaskVersion: 1,
    tenantRef: null,
    accountRef: null,
    effectId: null,
    payloadHash: null,
  };
  let authorizations = 0;
  const adapter = state.adapter({
    legacyProjectionAdoption: {
      async authorize() {
        authorizations += 1;
        return { authorized: true, adoptionId: 'wrong-core-adoption' };
      },
    },
  });

  await assert.rejects(
    () => adapter.apply({
      effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
    }),
    error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT' && error?.retryable === false,
  );
  assert.equal(authorizations, 0);
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 0);
});

test('TaskEffect create/exact replay use stable identity and cross-effect overwrite fails closed', async () => {
  const state = harness();
  const adapter = state.adapter();
  const created = await adapter.apply({
    effect: effect(1), attempt: 1, leaseEpoch: 1, workerId: 'worker-a', generation: 0,
  });
  assert.equal(created.outcome, 'platform_accepted');
  assert.equal(created.externalTaskId, 'guid-task-1');
  assert.equal(created.externalVersion, 1);
  assert.equal(created.effectId, 'effect-task-1-v1');

  const restarted = state.adapter();
  const replay = await restarted.apply({
    effect: effect(1), attempt: 2, leaseEpoch: 2, workerId: 'worker-b', generation: 0,
  });
  assert.equal(replay.outcome, 'reconciled');
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 0);

  await assert.rejects(
    () => restarted.apply({
      effect: effect(2), attempt: 1, leaseEpoch: 3, workerId: 'worker-c', generation: 0,
    }),
    error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT' && error?.retryable === false,
  );
  assert.equal(state.calls.filter(([name]) => name === 'update').length, 0);
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
    error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT' && error?.retryable === false,
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
