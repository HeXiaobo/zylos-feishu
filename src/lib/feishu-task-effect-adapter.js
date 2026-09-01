import { createHash } from 'node:crypto';

import {
  createVerifiedTaskEffectSettlement,
  taskEffectPayloadHash,
} from './task-effect-settlement.js';

const CLAIM_FIELDS = new Set([
  'effect',
  'attempt',
  'leaseEpoch',
  'workerId',
  'generation',
  'status',
  'leaseExpiresAt',
  'nextAttemptAt',
  'lastError',
  'receiptId',
]);
const IDENTITY_FIELDS = new Set(['tenantRef', 'accountRef']);

function domainError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositive(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function clientToken(effectId) {
  return `zte_${createHash('sha256').update(effectId).digest('hex').slice(0, 40)}`;
}

function normalizeIdentity(value) {
  const identity = requireRecord(value, 'TaskEffect adapter identity');
  const unknown = Object.keys(identity).find(key => !IDENTITY_FIELDS.has(key));
  if (unknown) throw new TypeError(`unsupported TaskEffect identity field: ${unknown}`);
  return {
    tenantRef: requireText(identity.tenantRef, 'identity.tenantRef'),
    accountRef: requireText(identity.accountRef, 'identity.accountRef'),
  };
}

function normalizeEffect(value, identity) {
  const effect = structuredClone(requireRecord(value, 'TaskEffect'));
  if (effect.schemaVersion !== 1 || effect.type !== 'TaskEffect') {
    throw new TypeError('TaskEffect schema/type is unsupported');
  }
  requireText(effect.effectId, 'TaskEffect.effectId');
  requireText(effect.requestId, 'TaskEffect.requestId');
  requireText(effect.traceId, 'TaskEffect.traceId');
  requireText(effect.taskId, 'TaskEffect.taskId');
  requirePositive(effect.coreVersion, 'TaskEffect.coreVersion');
  const source = requireRecord(effect.source, 'TaskEffect.source');
  const actor = requireRecord(effect.actor, 'TaskEffect.actor');
  const task = requireRecord(effect.task, 'TaskEffect.task');
  if (source.adapterId !== 'feishu' || source.accountRef !== identity.accountRef) {
    throw domainError('IDENTITY_MISMATCH', 'TaskEffect account does not match Feishu adapter');
  }
  if (actor.provider !== 'feishu' || actor.tenantRef !== identity.tenantRef
      || actor.provenance !== 'verified_channel_actor') {
    throw domainError('IDENTITY_MISMATCH', 'TaskEffect actor does not match Feishu adapter');
  }
  if (task.id !== effect.taskId || task.version !== effect.coreVersion) {
    throw domainError('PAYLOAD_MISMATCH', 'TaskEffect task identity/version mismatch');
  }
  return effect;
}

function normalizeClaim(value, identity) {
  const claim = requireRecord(value, 'TaskEffect claim');
  const unknown = Object.keys(claim).find(key => !CLAIM_FIELDS.has(key));
  if (unknown) throw new TypeError(`unsupported TaskEffect claim field: ${unknown}`);
  return {
    effect: normalizeEffect(claim.effect, identity),
    attempt: requirePositive(claim.attempt, 'TaskEffect claim.attempt'),
    leaseEpoch: requirePositive(claim.leaseEpoch, 'TaskEffect claim.leaseEpoch'),
    workerId: requireText(claim.workerId, 'TaskEffect claim.workerId'),
    generation: Number.isSafeInteger(claim.generation) && claim.generation >= 0
      ? claim.generation
      : 0,
  };
}

function effectIdentity(effect, identity) {
  return Object.freeze({
    tenantRef: identity.tenantRef,
    accountRef: identity.accountRef,
    effectId: effect.effectId,
    payloadHash: taskEffectPayloadHash(effect),
    coreTaskId: effect.taskId,
    coreTaskVersion: effect.coreVersion,
  });
}

function normalizeRemote(value) {
  const remote = requireRecord(value, 'native Task projection');
  return {
    ...remote,
    guid: requireText(remote.guid, 'native Task guid'),
    coreTaskId: requireText(remote.coreTaskId, 'native Task coreTaskId'),
    coreTaskVersion: requirePositive(remote.coreTaskVersion, 'native Task coreTaskVersion'),
  };
}

function receipt(outcome, claim, remote) {
  return createVerifiedTaskEffectSettlement({
    outcome,
    effect: claim.effect,
    claim,
    remote,
  });
}

function isLegacyProjection(remote) {
  return remote.coreTaskId !== null
    && remote.coreTaskVersion !== null
    && [remote.tenantRef, remote.accountRef, remote.effectId, remote.payloadHash]
      .every(value => value === null || value === undefined);
}

function assertNoIdentityConflict(remote, identity) {
  if (isLegacyProjection(remote) && remote.coreTaskId === identity.coreTaskId) {
    throw domainError(
      'LEGACY_PROJECTION_REQUIRES_ADOPTION',
      `legacy native Task projection requires explicit adoption: ${remote.guid}`,
    );
  }
  if (remote.coreTaskId !== identity.coreTaskId
      || remote.tenantRef !== identity.tenantRef
      || remote.accountRef !== identity.accountRef) {
    throw domainError(
      'EXTERNAL_IDENTITY_CONFLICT',
      `native Task projection scope mismatch: ${remote.guid}`,
    );
  }
  if (remote.effectId !== identity.effectId) return;
  if (remote.payloadHash !== identity.payloadHash
      || remote.tenantRef !== identity.tenantRef
      || remote.accountRef !== identity.accountRef
      || remote.coreTaskId !== identity.coreTaskId
      || remote.coreTaskVersion !== identity.coreTaskVersion) {
    throw domainError(
      'IDEMPOTENCY_CONFLICT',
      `TaskEffect identity belongs to different projection content: ${identity.effectId}`,
    );
  }
}

/**
 * Feishu Native Task Effect adapter. Durability, retry attempts and leases are
 * owned by Core's TaskEffect relay. This adapter contributes stable platform
 * identity, exact reconciliation, payload conflict checks and monotonic Core
 * version projection without introducing another delivery queue. Legacy
 * markers are deliberately not adopted here: migration requires a separately
 * accepted durable Core transaction and this adapter always fails them closed.
 */
export function createFeishuTaskEffectAdapter({
  gateway,
  memberMapper,
  identity: rawIdentity,
} = {}) {
  const remote = requireRecord(gateway, 'TaskEffect gateway');
  for (const operation of ['findTasksByCoreTaskId', 'createTask', 'updateTask']) {
    if (typeof remote[operation] !== 'function') {
      throw new TypeError(`gateway.${operation} must be a function`);
    }
  }
  if (!memberMapper || typeof memberMapper.map !== 'function') {
    throw new TypeError('memberMapper.map must be a function');
  }
  const adapterIdentity = normalizeIdentity(rawIdentity);

  async function find(effect) {
    const candidates = await remote.findTasksByCoreTaskId(effect.taskId);
    if (!Array.isArray(candidates)) {
      throw new TypeError('gateway.findTasksByCoreTaskId must return an array');
    }
    if (candidates.length > 1) {
      throw domainError(
        'EXTERNAL_IDENTITY_CONFLICT',
        `multiple native Tasks project Core task ${effect.taskId}`,
      );
    }
    return candidates.length === 0 ? null : normalizeRemote(candidates[0]);
  }

  async function reconcileEffect(effectInput, claim = {
    attempt: 1, leaseEpoch: 1, workerId: 'reconcile', generation: 0,
  }) {
    const effect = normalizeEffect(effectInput, adapterIdentity);
    const identity = effectIdentity(effect, adapterIdentity);
    const current = await find(effect);
    if (current === null) return Object.freeze({ outcome: 'not_delivered', ...identity });
    assertNoIdentityConflict(current, identity);
    if (current.effectId === identity.effectId) {
      return receipt('reconciled', claim, current);
    }
    if (current.coreTaskVersion > effect.coreVersion) {
      return receipt('suppressed', claim, current);
    }
    return Object.freeze({
      outcome: 'not_delivered',
      ...identity,
      externalTaskId: current.guid,
      externalVersion: current.coreTaskVersion,
    });
  }

  return Object.freeze({
    reconcile(effectInput) {
      return reconcileEffect(effectInput);
    },

    async apply(claimInput) {
      const claim = normalizeClaim(claimInput, adapterIdentity);
      const identity = effectIdentity(claim.effect, adapterIdentity);
      if (claim.attempt > 1) {
        const observed = await reconcileEffect(claim.effect, claim);
        if (observed.outcome !== 'not_delivered') return observed;
      }
      const current = await find(claim.effect);
      if (current !== null) {
        assertNoIdentityConflict(current, identity);
        if (current.effectId === identity.effectId) {
          return receipt('reconciled', claim, current);
        }
        if (current.coreTaskVersion > claim.effect.coreVersion) {
          return receipt('suppressed', claim, current);
        }
      }
      let members;
      try {
        members = memberMapper.map(claim.effect.task);
      } catch (error) {
        throw domainError('MEMBER_MAPPING_FAILED', 'TaskEffect member mapping failed', false);
      }
      const operation = current === null ? 'createTask' : 'updateTask';
      const projected = normalizeRemote(await remote[operation]({
        ...(current === null ? {} : { taskGuid: current.guid }),
        task: claim.effect.task,
        members,
        clientToken: clientToken(claim.effect.effectId),
        effectIdentity: identity,
      }));
      assertNoIdentityConflict(projected, identity);
      if (projected.effectId !== identity.effectId
          || projected.coreTaskVersion !== identity.coreTaskVersion) {
        throw domainError(
          'PROJECTION_READBACK_MISMATCH',
          `native Task did not persist TaskEffect identity: ${identity.effectId}`,
          true,
        );
      }
      return receipt('platform_accepted', claim, projected);
    },
  });
}

function safeFailure(error, classification, attempt) {
  return JSON.stringify({
    code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'TASK_EFFECT_FAILED',
    classification,
    retryable: classification === 'retryable',
    attempt,
  });
}

function requireWorkerInterface(effects) {
  const relay = requireRecord(effects, 'TaskEffect relay');
  for (const operation of ['claim', 'acknowledge', 'fail', 'reconcile']) {
    if (typeof relay[operation] !== 'function') {
      throw new TypeError(`TaskEffect relay.${operation} must be a function`);
    }
  }
  return relay;
}

/**
 * One bounded TaskEffect relay cycle. Core keeps durable ownership; the worker
 * passes through the exact lease fence, marks ambiguity before reconciliation,
 * and emits a task receipt only after Core accepts the platform settlement.
 */
export async function processFeishuTaskEffectsOnce({
  effects: rawEffects,
  adapter,
  taskReceiptDelivery,
  routeForEffect,
  workerId,
  leaseMs = 30_000,
  limit = 25,
  retryAfterMs = 5_000,
  maxAttempts = 5,
} = {}) {
  const effects = requireWorkerInterface(rawEffects);
  if (!adapter || typeof adapter.apply !== 'function' || typeof adapter.reconcile !== 'function') {
    throw new TypeError('TaskEffect adapter must provide apply and reconcile');
  }
  if (!taskReceiptDelivery || typeof taskReceiptDelivery.send !== 'function') {
    throw new TypeError('taskReceiptDelivery.send must be a function');
  }
  if (typeof routeForEffect !== 'function') throw new TypeError('routeForEffect must be a function');
  const normalizedWorkerId = requireText(workerId, 'TaskEffect workerId');
  requirePositive(leaseMs, 'TaskEffect leaseMs');
  requirePositive(limit, 'TaskEffect claim limit');
  requirePositive(retryAfterMs, 'TaskEffect retryAfterMs');
  requirePositive(maxAttempts, 'TaskEffect maxAttempts');
  const claimed = effects.claim({ workerId: normalizedWorkerId, leaseMs, limit });
  if (!Array.isArray(claimed)) throw new TypeError('TaskEffect relay.claim must return an array');
  const summary = {
    claimed: claimed.length,
    acknowledged: 0,
    reconciled: 0,
    retryWaiting: 0,
    deadLettered: 0,
    unknown: 0,
    leaseLost: 0,
    receiptPending: 0,
  };

  async function deliverReceipt(effect, settlement) {
    const route = await routeForEffect(effect);
    if (route === null || route === undefined) return;
    try {
      await taskReceiptDelivery.send({ effect, settlement, route });
    } catch {
      // Its own durable file outbox retains the ReplyIntent. Projection state
      // and any Assistant execution terminal remain unchanged.
      summary.receiptPending += 1;
    }
  }

  for (const claim of claimed) {
    let settlement;
    try {
      settlement = await adapter.apply(claim);
    } catch (error) {
      const uncertain = error?.outcome === 'unknown' || error?.code === 'DELIVERY_UNKNOWN';
      const classification = uncertain
        ? 'unknown'
        : error?.retryable === false || claim.attempt >= maxAttempts
          ? 'permanent'
          : 'retryable';
      effects.fail({
        effectId: claim.effect.effectId,
        workerId: claim.workerId,
        leaseEpoch: claim.leaseEpoch,
        classification,
        error: safeFailure(error, classification, claim.attempt),
        retryAfterMs,
      });
      if (classification === 'permanent') {
        summary.deadLettered += 1;
        continue;
      }
      if (classification === 'retryable') {
        summary.retryWaiting += 1;
        continue;
      }
      summary.unknown += 1;
      try {
        const observed = await adapter.reconcile(claim.effect);
        const delivered = ['platform_accepted', 'reconciled', 'suppressed'].includes(
          observed?.outcome,
        );
        effects.reconcile({
          effectId: claim.effect.effectId,
          actorId: normalizedWorkerId,
          outcome: delivered ? 'delivered' : 'not_delivered',
          receipt: observed,
        });
        if (delivered) {
          summary.reconciled += 1;
          await deliverReceipt(claim.effect, observed);
        }
      } catch {
        // Core remains visibly unknown. A later reconciler resumes with the
        // same effect identity; this cycle never retries platform mutation.
      }
      continue;
    }

    try {
      effects.acknowledge({
        effectId: claim.effect.effectId,
        workerId: claim.workerId,
        leaseEpoch: claim.leaseEpoch,
        receipt: settlement,
      });
    } catch (error) {
      if (error?.code === 'EFFECT_LEASE_LOST' || error?.code === 'EFFECT_LEASE_EXPIRED') {
        summary.leaseLost += 1;
        continue;
      }
      throw error;
    }
    summary.acknowledged += 1;
    await deliverReceipt(claim.effect, settlement);
  }
  return Object.freeze(summary);
}
