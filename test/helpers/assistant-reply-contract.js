import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/assistant-reply-contract/v1',
);

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
const DELIVERY_RESULTS = new Set([
  'platform_accepted',
  'unknown',
  'reconciled',
  'rejected',
  'suppressed',
]);

export function loadContractFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), 'utf8'));
}

export function requireText(value, label) {
  assert.equal(typeof value, 'string', `${label} must be text`);
  assert.notEqual(value.trim(), '', `${label} must not be empty`);
  return value;
}

export function assertAcceptMessage(command) {
  assert.equal(command.schemaVersion, 1);
  assert.equal(command.type, 'AcceptMessage');
  for (const field of ['commandId', 'idempotencyKey', 'traceId']) {
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
  assert.equal(command.source.adapterId, 'feishu');
  assert.equal(command.policy.requireIdle, false);
  assert.equal(command.reply.mode, 'required');
  requireText(command.reply.targetRef, 'AcceptMessage.reply.targetRef');
}

export function assertRunEventVector(vector) {
  assert.ok(Array.isArray(vector.events));
  assert.ok(vector.events.length > 0);
  const requestIds = new Set();
  const turnIds = new Set();
  const sequences = [];
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
    sequences.push(event.sequence);
    assert.equal(eventIds.has(event.eventId), false, `duplicate eventId ${event.eventId}`);
    eventIds.add(event.eventId);
    const serialized = JSON.stringify(event);
    const prior = idempotency.get(event.idempotencyKey);
    if (prior) assert.equal(prior, serialized, 'idempotency replay changed payload');
    idempotency.set(event.idempotencyKey, serialized);
  }

  assert.equal(requestIds.size, 1, 'one vector must describe one request');
  assert.equal(turnIds.size, 1, 'one vector must describe one fenced Runtime Turn');
  assert.deepEqual(sequences, sequences.toSorted((left, right) => left - right));
  assert.equal(new Set(sequences).size, sequences.length, 'event sequence must be unique');
  const terminals = vector.events.filter((event) => TERMINAL_EVENT_TYPES.has(event.type));
  assert.equal(terminals.length, 1, 'a run must have exactly one terminal event');
  assert.equal(vector.events.at(-1), terminals[0], 'the terminal event must be last');
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
  assert.equal(intent.route?.adapterId, 'feishu');
  requireText(intent.route?.targetRef, 'ReplyIntent.route.targetRef');
  assert.equal(typeof intent.route.targetRef, 'string', 'Core treats targetRef as opaque');
  assert.ok(['send', 'suppress', 'failure_notice', 'task_receipt'].includes(intent.disposition));
  if (intent.disposition === 'send') {
    requireText(intent.payload?.text, 'visible ReplyIntent.payload.text');
  }
  if (intent.disposition === 'task_receipt') {
    assert.equal(intent.cause.kind, 'task_effect');
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
    'attemptId',
    'traceId',
    'adapterId',
  ]) {
    requireText(receipt[field], `DeliveryReceipt.${field}`);
  }
  assert.equal(receipt.adapterId, 'feishu');
  assert.ok(DELIVERY_RESULTS.has(receipt.result));
  assert.notEqual(receipt.result, 'user_received');
}

export function transportKey(source) {
  return [source.adapterId, source.accountRef, source.eventType, source.eventId].join('/');
}

export function logicalMessageKey(source) {
  return [source.adapterId, source.accountRef, source.eventType, source.messageId].join('/');
}
