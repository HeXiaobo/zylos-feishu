import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/assistant-reply-contract/v1',
);

export const COMMON_CONTRACT_DIGEST =
  '581475d80e85cd156c4f6629d0e8e8ee82c2689e89de214c1bb24b404cd10195';

const RUN_EVENT_TYPES = new Set([
  'RunAccepted',
  'RunQueued',
  'RunStarted',
  'ProgressUpdated',
  'OutputDelta',
  'RunCompleted',
  'RunFailed',
  'RunCancelled',
]);
const TERMINAL_EVENT_TYPES = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);
const DELIVERY_OUTCOMES = new Set([
  'platform_accepted',
  'unknown',
  'reconciled',
  'rejected',
]);
const SETTLEMENT_STATES = new Set(['accepted', 'unpresentable']);

export function loadContractFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), 'utf8'));
}

export function loadCommonContractFixture() {
  return loadContractFixture('common-contract-vectors.json');
}

export function requireText(value, label) {
  assert.equal(typeof value, 'string', `${label} must be text`);
  assert.notEqual(value.trim(), '', `${label} must not be empty`);
  return value;
}

export function assertCommonContractDigest() {
  const bytes = fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'common-contract-vectors.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), COMMON_CONTRACT_DIGEST);
}

export function assertCommonContractReference(reference, pointer) {
  assert.equal(reference?.file, 'common-contract-vectors.json');
  assert.equal(reference?.pointer, pointer);
}

export function assertAcceptMessage(command) {
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, 'AcceptMessage');
  for (const field of [
    'commandId',
    'idempotencyKey',
    'traceId',
    'causationId',
    'issuedAt',
  ]) {
    requireText(command[field], `AcceptMessage.${field}`);
  }
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
    requireText(command.source?.[field], `AcceptMessage.source.${field}`);
  }
  assert.match(command.source.payloadHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(command.source.transportEventKey, undefined);
  assert.equal(command.source.logicalMessageKey, undefined);
  requireText(command.actor?.provider, 'AcceptMessage.actor.provider');
  requireText(command.actor?.tenantRef, 'AcceptMessage.actor.tenantRef');
  requireText(command.actor?.externalId, 'AcceptMessage.actor.externalId');
  assert.equal(command.content?.kind, 'text');
  requireText(command.content?.text, 'AcceptMessage.content.text');
  assert.ok(command.contextHints);
  assert.ok(['required', 'optional', 'none'].includes(command.reply?.mode));
  if (command.reply.mode !== 'none') requireText(command.reply.targetRef, 'AcceptMessage.reply.targetRef');
  assert.equal(Number.isSafeInteger(command.policy?.priority), true);
  assert.equal(command.policy.requireIdle, false);
}

export function assertAcceptedMessage(accepted) {
  assert.equal(accepted.schemaVersion, 1);
  assert.equal(accepted.type, 'MessageAccepted');
  for (const field of ['requestId', 'traceId', 'conversationLaneKey']) {
    requireText(accepted[field], `MessageAccepted.${field}`);
  }
  assert.equal(Number.isSafeInteger(accepted.laneSequence), true);
  assert.equal(accepted.laneSequence > 0, true);
  assert.equal(accepted.orderingMode, 'acceptance');
  assert.equal(accepted.sourceOrder, null);
}

export function assertCancelRequest(command) {
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, 'CancelRequest');
  for (const field of [
    'commandId',
    'idempotencyKey',
    'requestId',
    'turnId',
    'traceId',
    'causationId',
    'issuedAt',
    'mode',
    'reason',
  ]) {
    requireText(command[field], `CancelRequest.${field}`);
  }
  for (const field of ['adapterId', 'accountRef', 'eventType', 'eventId', 'messageId']) {
    requireText(command.source?.[field], `CancelRequest.source.${field}`);
  }
  for (const field of ['provider', 'tenantRef', 'externalId', 'provenance']) {
    requireText(command.actor?.[field], `CancelRequest.actor.${field}`);
  }
  assert.equal(command.actor.provenance, 'verified_channel_actor');
  assert.equal(command.source.transportEventKey, undefined);
  assert.equal(command.source.logicalMessageKey, undefined);
}

export function assertContextSnapshot(snapshot) {
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.type, 'ContextSnapshot');
  for (const field of [
    'snapshotId',
    'requestId',
    'turnId',
    'traceId',
    'conversationLaneKey',
    'contentHash',
    'retryPolicy',
  ]) {
    requireText(snapshot[field], `ContextSnapshot.${field}`);
  }
  assert.equal(Number.isSafeInteger(snapshot.asOfLaneSequence), true);
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Array.isArray(snapshot.items));
  assert.ok(snapshot.items.length > 0);
  assert.equal(snapshot.truncation?.strategy, 'deterministic_budget_v1');
  assert.equal(Number.isSafeInteger(snapshot.truncation.inputTokens), true);
  assert.equal(Number.isSafeInteger(snapshot.truncation.keptTokens), true);
  assert.ok(Array.isArray(snapshot.truncation.droppedItemRefs));
}

export function assertRunEventVector(vector) {
  assert.ok(Array.isArray(vector.events));
  assert.ok(vector.events.length > 0);
  const requestIds = new Set();
  const turnIds = new Set();
  const generations = new Map();
  const eventIds = new Set();
  const idempotency = new Map();

  for (const event of vector.events) {
    assert.equal(event.schemaVersion, 1);
    assert.ok(RUN_EVENT_TYPES.has(event.type), `unsupported run event ${event.type}`);
    for (const field of [
      'eventId',
      'idempotencyKey',
      'requestId',
      'turnId',
      'traceId',
      'causationId',
      'producer',
    ]) {
      requireText(event[field], `${event.type}.${field}`);
    }
    assert.equal(Number.isSafeInteger(event.sequence) && event.sequence > 0, true);
    assert.equal(Number.isSafeInteger(event.generation) && event.generation > 0, true);
    requestIds.add(event.requestId);
    turnIds.add(event.turnId);
    const sequenceForGeneration = generations.get(event.generation) ?? [];
    sequenceForGeneration.push(event.sequence);
    generations.set(event.generation, sequenceForGeneration);
    assert.equal(eventIds.has(event.eventId), false, `duplicate eventId ${event.eventId}`);
    eventIds.add(event.eventId);
    const serialized = JSON.stringify(event);
    const prior = idempotency.get(event.idempotencyKey);
    if (prior) assert.equal(prior, serialized, 'idempotency replay changed payload');
    idempotency.set(event.idempotencyKey, serialized);
    assert.equal(event.payload?.runtimeLane, undefined);
    if (event.payload?.runtimeLaneId !== undefined) {
      assert.equal(event.payload.runtimeLaneId, 'runtime:shared');
    }
  }

  assert.equal(requestIds.size, 1, 'one vector must describe one request');
  assert.equal(turnIds.size, 1, 'one vector must describe one fenced Runtime Turn');
  for (const sequences of generations.values()) {
    assert.deepEqual(sequences, sequences.toSorted((left, right) => left - right));
    assert.equal(new Set(sequences).size, sequences.length, 'event sequence must be unique');
  }
  const terminals = vector.events.filter((event) => TERMINAL_EVENT_TYPES.has(event.type));
  assert.equal(terminals.length, 1, 'a run must have exactly one terminal event');
  assert.equal(vector.events.at(-1), terminals[0], 'the terminal event must be last');
  const terminal = terminals[0];
  if (terminal.type === 'RunCancelled') {
    assert.equal(terminal.payload?.outcomeId, undefined);
  } else {
    requireText(terminal.payload?.outcomeId, `${terminal.type}.payload.outcomeId`);
  }
}

export function assertReplyOutcome(outcome) {
  assert.equal(outcome.schemaVersion, 1);
  assert.equal(outcome.type, 'ReplyOutcome');
  for (const field of ['outcomeId', 'requestId', 'turnId', 'traceId']) {
    requireText(outcome[field], `ReplyOutcome.${field}`);
  }
  assert.ok(['answer', 'silent', 'failure'].includes(outcome.kind));
  if (outcome.kind === 'answer') {
    assert.equal(outcome.content?.format, 'text');
    assert.equal(typeof outcome.content.text, 'string');
  }
  if (outcome.kind === 'silent') assert.equal(outcome.explicit, true);
  if (outcome.kind === 'failure') {
    requireText(outcome.code, 'ReplyOutcome.code');
    assert.equal(typeof outcome.retryable, 'boolean');
  }
}

export function assertReplyIntent(intent) {
  assert.equal(intent.schemaVersion, 1);
  assert.equal(intent.type, 'ReplyIntent');
  for (const field of [
    'intentId',
    'requestId',
    'traceId',
    'contentHash',
    'idempotencyKey',
  ]) {
    requireText(intent[field], `ReplyIntent.${field}`);
  }
  assert.match(intent.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(['run_terminal', 'task_effect'].includes(intent.cause?.kind));
  requireText(intent.cause?.eventId, 'ReplyIntent.cause.eventId');
  requireText(intent.route?.adapterId, 'ReplyIntent.route.adapterId');
  requireText(intent.route?.targetRef, 'ReplyIntent.route.targetRef');
  assert.ok(['send', 'failure_notice', 'task_receipt'].includes(intent.disposition));
  if (intent.disposition === 'send') requireText(intent.payload?.text, 'visible ReplyIntent.payload.text');
  if (intent.disposition === 'failure_notice') requireText(intent.payload?.text, 'failure ReplyIntent.payload.text');
  if (intent.disposition === 'task_receipt') {
    assert.equal(intent.cause.kind, 'task_effect');
    requireText(intent.payload?.text, 'task ReplyIntent.payload.text');
  } else {
    assert.equal(intent.cause.kind, 'run_terminal');
  }
}

export function assertDeliveryReceipt(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.type, 'DeliveryReceipt');
  for (const field of [
    'receiptId',
    'intentId',
    'deliveryId',
    'requestId',
    'attemptId',
    'traceId',
    'adapterId',
    'outcome',
    'observedAt',
  ]) {
    requireText(receipt[field], `DeliveryReceipt.${field}`);
  }
  assert.ok(DELIVERY_OUTCOMES.has(receipt.outcome));
  assert.equal(receipt.externalRef === null || typeof receipt.externalRef === 'string', true);
  for (const forbidden of ['result', 'settlement', 'userRead', 'userReceived']) {
    assert.equal(receipt[forbidden], undefined, `DeliveryReceipt.${forbidden} is not public contract`);
  }
}

export function assertDeliverySettlement(settlement) {
  assert.equal(settlement.schemaVersion, 1);
  assert.equal(settlement.type, 'DeliverySettlement');
  for (const field of [
    'settlementId',
    'intentId',
    'deliveryId',
    'requestId',
    'traceId',
    'adapterId',
    'basis',
  ]) {
    requireText(settlement[field], `DeliverySettlement.${field}`);
  }
  assert.ok(SETTLEMENT_STATES.has(settlement.state));
  assert.equal(typeof settlement.presented, 'boolean');
  assert.equal(settlement.outcome, undefined);
  assert.equal(settlement.userRead, undefined);
}

export function assertTaskCommand(command) {
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, 'TaskCommand');
  for (const field of [
    'commandId',
    'idempotencyKey',
    'requestId',
    'turnId',
    'traceId',
    'taskId',
    'command',
    'capability',
  ]) {
    requireText(command[field], `TaskCommand.${field}`);
  }
  for (const field of ['adapterId', 'accountRef', 'eventType', 'eventId', 'messageId']) {
    requireText(command.source?.[field], `TaskCommand.source.${field}`);
  }
  for (const field of ['provider', 'tenantRef', 'externalId', 'provenance']) {
    requireText(command.actor?.[field], `TaskCommand.actor.${field}`);
  }
  assert.equal(command.actor.provenance, 'verified_channel_actor');
  assert.equal(Number.isSafeInteger(command.expectedVersion), true);
  assert.equal(command.aiMayConstructActor, false);
  assert.equal(command.aiMayWriteDatabase, false);
  assert.equal(command.source.transportEventKey, undefined);
  assert.equal(command.source.logicalMessageKey, undefined);
}

export function assertAuthorizationDecision(decision) {
  assert.equal(decision.schemaVersion, 1);
  assert.equal(decision.type, 'AuthorizationDecision');
  for (const field of ['decisionId', 'commandId', 'enforcedBy', 'decision']) {
    requireText(decision[field], `AuthorizationDecision.${field}`);
  }
  assert.equal(decision.decision, 'allow');
  assert.ok(Array.isArray(decision.checked));
}

export function transportKey(source) {
  return [source.adapterId, source.accountRef, source.eventType, source.eventId].join('/');
}

export function logicalMessageKey(source) {
  return [source.adapterId, source.accountRef, source.eventType, source.messageId].join('/');
}
