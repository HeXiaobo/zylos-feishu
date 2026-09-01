import { createHash } from 'node:crypto';

const SETTLED_OUTCOMES = new Set(['platform_accepted', 'reconciled', 'suppressed']);

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function conflict(message) {
  const error = new Error(message);
  error.code = 'IDEMPOTENCY_CONFLICT';
  error.retryable = false;
  return error;
}

export function taskEffectPayloadHash(effect) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(requireRecord(effect, 'TaskEffect'))))
    .digest('hex')}`;
}

export function verifyTaskEffectSettlement({ effect: rawEffect, settlement: rawSettlement }) {
  const effect = requireRecord(rawEffect, 'TaskEffect');
  const settlement = requireRecord(rawSettlement, 'TaskEffect settlement');
  if (!SETTLED_OUTCOMES.has(settlement.outcome)) {
    throw new TypeError('task receipt requires a settled TaskEffect');
  }
  const effectId = requireText(effect.effectId, 'TaskEffect.effectId');
  const payloadHash = taskEffectPayloadHash(effect);
  if (requireText(settlement.effectId, 'TaskEffect settlement.effectId') !== effectId
      || requireText(settlement.payloadHash, 'TaskEffect settlement.payloadHash') !== payloadHash) {
    throw conflict('verified TaskEffect settlement identity conflict');
  }
  const externalTaskId = requireText(
    settlement.externalTaskId,
    'TaskEffect settlement.externalTaskId',
  );
  const externalVersion = requirePositive(
    settlement.externalVersion,
    'TaskEffect settlement.externalVersion',
  );
  const coreVersion = requirePositive(effect.coreVersion, 'TaskEffect.coreVersion');
  if ((settlement.outcome === 'suppressed' && externalVersion <= coreVersion)
      || (settlement.outcome !== 'suppressed' && externalVersion !== coreVersion)) {
    throw conflict('verified TaskEffect settlement version conflict');
  }
  const attempt = requirePositive(settlement.attempt, 'TaskEffect settlement.attempt');
  const leaseEpoch = requirePositive(settlement.leaseEpoch, 'TaskEffect settlement.leaseEpoch');
  const workerId = requireText(settlement.workerId, 'TaskEffect settlement.workerId');
  if (!Number.isSafeInteger(settlement.generation) || settlement.generation < 0) {
    throw new TypeError('TaskEffect settlement.generation must be a non-negative integer');
  }
  return Object.freeze({
    outcome: settlement.outcome,
    effectId,
    payloadHash,
    externalTaskId,
    externalVersion,
    attempt,
    leaseEpoch,
    workerId,
    generation: settlement.generation,
  });
}

export function createVerifiedTaskEffectSettlement({ outcome, effect, claim, remote }) {
  const fence = requireRecord(claim, 'TaskEffect claim');
  const external = requireRecord(remote, 'native Task projection');
  return verifyTaskEffectSettlement({
    effect,
    settlement: {
      outcome,
      effectId: effect.effectId,
      payloadHash: taskEffectPayloadHash(effect),
      externalTaskId: external.guid,
      externalVersion: external.coreTaskVersion,
      attempt: fence.attempt,
      leaseEpoch: fence.leaseEpoch,
      workerId: fence.workerId,
      generation: fence.generation,
    },
  });
}
