import { createHash } from 'node:crypto';

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
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

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function assertAcceptMessage(value) {
  const message = requireRecord(value, 'AcceptMessage');
  if (message.schemaVersion !== 1 || message.type !== 'AcceptMessage') {
    throw new TypeError('CoreMessageIntakePort accepts only v1 AcceptMessage');
  }
  for (const field of ['commandId', 'idempotencyKey', 'traceId', 'causationId', 'issuedAt']) {
    requireText(message[field], `AcceptMessage.${field}`);
  }
  const source = requireRecord(message.source, 'AcceptMessage.source');
  for (const field of [
    'adapterId',
    'accountRef',
    'targetRef',
    'conversationKey',
    'messageId',
    'eventId',
    'eventType',
    'payloadHash',
  ]) {
    requireText(source[field], `AcceptMessage.source.${field}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(source.payloadHash)) {
    throw new TypeError('AcceptMessage.source.payloadHash must be a sha256 digest');
  }
  if (source.transportEventKey !== undefined || source.logicalMessageKey !== undefined) {
    throw new TypeError('AcceptMessage.source must not contain derived identity keys');
  }
  requireRecord(message.actor, 'AcceptMessage.actor');
  requireRecord(message.content, 'AcceptMessage.content');
  requireRecord(message.contextHints, 'AcceptMessage.contextHints');
  requireRecord(message.reply, 'AcceptMessage.reply');
  requireRecord(message.policy, 'AcceptMessage.policy');
  if (message.policy.requireIdle !== false) {
    throw new TypeError('ordinary AcceptMessage.policy.requireIdle must be false');
  }
  return message;
}

function assertAcceptance(value) {
  const acceptance = requireRecord(value, 'adapter-local acceptance');
  return Object.freeze({
    conversationLaneKey: requireText(
      acceptance.conversationLaneKey,
      'adapter-local acceptance.conversationLaneKey',
    ),
    laneSequence: requirePositiveInteger(
      acceptance.laneSequence,
      'adapter-local acceptance.laneSequence',
    ),
    sourceOrder: acceptance.sourceOrder ?? null,
  });
}

function assertMessageAccepted(value, expected) {
  const receipt = requireRecord(value, 'MessageAccepted');
  if (receipt.schemaVersion !== 1 || receipt.type !== 'MessageAccepted') {
    throw new TypeError('CoreMessageIntakePort must return v1 MessageAccepted');
  }
  requireText(receipt.requestId, 'MessageAccepted.requestId');
  requireText(receipt.traceId, 'MessageAccepted.traceId');
  if (receipt.conversationLaneKey !== expected.conversationLaneKey
    || receipt.laneSequence !== expected.laneSequence
    || receipt.orderingMode !== 'acceptance'
    || JSON.stringify(receipt.sourceOrder ?? null) !== JSON.stringify(expected.sourceOrder)) {
    throw domainError('CORE_ACCEPTANCE_MISMATCH', 'Core durable receipt changed lane acceptance');
  }
  return Object.freeze({
    schemaVersion: 1,
    type: 'MessageAccepted',
    requestId: receipt.requestId,
    traceId: receipt.traceId,
    conversationLaneKey: receipt.conversationLaneKey,
    laneSequence: receipt.laneSequence,
    orderingMode: 'acceptance',
    sourceOrder: receipt.sourceOrder ?? null,
  });
}

/** Adapt a remote Core durable-accept function to the validated intake port. */
export function createCoreMessageIntakeAdapter({ accept } = {}) {
  if (typeof accept !== 'function') throw new TypeError('Core intake accept must be a function');
  return Object.freeze({
    async accept(message, acceptance) {
      const command = assertAcceptMessage(message);
      const expected = assertAcceptance(acceptance);
      return assertMessageAccepted(await accept(command, expected), expected);
    },
  });
}

/** In-memory adapter for behavior and recovery tests; effects are idempotent. */
export function createInMemoryCoreMessageIntake() {
  const effects = new Map();
  return Object.freeze({
    async accept(message, acceptance) {
      const command = assertAcceptMessage(message);
      const expected = assertAcceptance(acceptance);
      const source = command.source;
      const logicalKey = [
        source.adapterId,
        source.accountRef,
        source.eventType,
        source.messageId,
      ].join('\u0000');
      const existing = effects.get(logicalKey);
      if (existing) {
        if (existing.payloadHash !== source.payloadHash
          || existing.acceptance.conversationLaneKey !== expected.conversationLaneKey
          || existing.acceptance.laneSequence !== expected.laneSequence
          || JSON.stringify(existing.acceptance.sourceOrder) !== JSON.stringify(expected.sourceOrder)) {
          throw domainError('IDEMPOTENCY_CONFLICT', 'logical message replay changed payload or lane acceptance');
        }
        return existing.receipt;
      }
      const requestDigest = createHash('sha256').update(logicalKey).digest('hex');
      const receipt = Object.freeze({
        schemaVersion: 1,
        type: 'MessageAccepted',
        requestId: `req:feishu:${requestDigest}`,
        traceId: command.traceId,
        conversationLaneKey: expected.conversationLaneKey,
        laneSequence: expected.laneSequence,
        orderingMode: 'acceptance',
        sourceOrder: expected.sourceOrder,
      });
      effects.set(logicalKey, Object.freeze({
        payloadHash: source.payloadHash,
        acceptance: expected,
        receipt,
      }));
      return receipt;
    },
    acceptedEffects() {
      return Object.freeze([...effects.values()].map((effect) => effect.receipt));
    },
  });
}
