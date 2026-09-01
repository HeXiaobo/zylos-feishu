import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertAcceptMessage,
  assertDeliveryReceipt,
  assertReplyIntent,
  assertRunEventVector,
  loadContractFixture,
  logicalMessageKey,
  transportKey,
} from './helpers/assistant-reply-contract.js';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/assistant-reply-contract/v1',
);

test('common fixture manifest freezes Core-compatible names and byte hashes', () => {
  const manifest = loadContractFixture('fixture-manifest.json');
  assert.equal(manifest.algorithm, 'sha256');
  assert.deepEqual(
    manifest.commonContracts.map((entry) => entry.name),
    ['AcceptMessage', 'RuntimeEvents', 'ReplyIntent', 'DeliveryReceipt'],
  );
  for (const entry of manifest.commonContracts) {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIRECTORY, entry.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});

test('Core v1-named AcceptMessage vectors keep Feishu routes opaque', () => {
  const fixture = loadContractFixture('accept-message.json');
  assert.equal(fixture.contract, 'AcceptMessage');
  for (const vector of fixture.vectors) {
    assertAcceptMessage(vector.command);
    assert.equal(vector.accepted.requestId.startsWith('req:'), true);
    assert.equal(vector.accepted.conversationLaneKey, vector.command.source.conversationKey);
    assert.equal(Number.isSafeInteger(vector.accepted.laneSequence), true);
    assert.equal(vector.accepted.orderingMode, 'acceptance');
    assert.equal(vector.accepted.sourceOrder, null);
    assert.equal(Object.keys(vector.command.route || {}).length, 0);
    assert.match(vector.command.source.targetRef, /^feishu-route:v1:opaque-/);
  }
});

test('Runtime event vectors preserve identity, monotonic sequence, fencing, and one last terminal', () => {
  const fixture = loadContractFixture('run-events.json');
  assert.equal(fixture.contract, 'RuntimeEvents');
  fixture.vectors.forEach(assertRunEventVector);
  assert.deepEqual(
    fixture.vectors.map((vector) => vector.events.at(-1).type),
    ['RunCompleted', 'RunFailed', 'RunCancelled'],
  );
  const answerStart = fixture.vectors[0].events.find((event) => event.type === 'RunStarted');
  assert.equal(answerStart.payload.runtimeLane, 'runtime:shared');
  assert.equal(answerStart.generation, 1);
});

test('Reply Intent vectors keep outcome, task effect, and delivery causes separate', () => {
  const fixture = loadContractFixture('reply-intents.json');
  assert.equal(fixture.contract, 'ReplyIntent');
  fixture.vectors.forEach(({ intent }) => assertReplyIntent(intent));
  const taskReceipt = fixture.vectors.find((vector) => vector.name === 'task-receipt').intent;
  assert.equal(taskReceipt.cause.kind, 'task_effect');
  assert.equal(taskReceipt.disposition, 'task_receipt');
  const silent = fixture.vectors.find((vector) => vector.name === 'explicit-silent').intent;
  assert.equal(silent.disposition, 'suppress');
  assert.equal(silent.payload.reason, 'explicit_silent');
  const invalid = fixture.invalid.find((vector) => vector.name === 'empty-visible-answer');
  assert.equal(invalid.expectedError, 'MISSING_OUTPUT');
  assert.equal(invalid.intent.payload.text, '');
});

test('Delivery Receipt vectors never conflate platform acceptance with user read', () => {
  const fixture = loadContractFixture('delivery-receipts.json');
  assert.equal(fixture.contract, 'DeliveryReceipt');
  fixture.vectors.forEach(({ receipt }) => assertDeliveryReceipt(receipt));
  const accepted = fixture.vectors.find((vector) => vector.name === 'platform-accepted').receipt;
  assert.equal(accepted.userRead, 'unknown');
  const unknown = fixture.vectors.find((vector) => vector.name === 'unknown-before-reconcile').receipt;
  assert.equal(unknown.settlement, 'pending_reconciliation');
  const exhausted = fixture.vectors.find((vector) => vector.name === 'delivery-exhausted').receipt;
  assert.equal(exhausted.result, 'rejected');
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.settlement, 'unpresentable');
  assert.notEqual(exhausted.settlement, 'accepted');
});

test('dual Feishu identities deduplicate before allocating one lane/presentation/presence', () => {
  const fixture = loadContractFixture('feishu-intake.json');
  const { websocket, webhook, expected } = fixture.duplicateDelivery;
  assert.notEqual(transportKey(websocket), transportKey(webhook));
  assert.equal(logicalMessageKey(websocket), logicalMessageKey(webhook));
  assert.equal(websocket.payloadHash, webhook.payloadHash);
  for (const field of [
    'requestIds',
    'laneSequences',
    'presentationIds',
    'presenceEffectIds',
    'cardIds',
    'reactionIds',
  ]) {
    assert.equal(expected[field].length, 1, `${field} must be allocated once`);
  }
  assert.deepEqual(
    fixture.identity.transportKeyFields,
    ['adapterId', 'accountRef', 'eventType', 'eventId'],
  );
  assert.deepEqual(
    fixture.identity.logicalMessageKeyFields,
    ['adapterId', 'accountRef', 'eventType', 'messageId'],
  );
  assert.equal(fixture.fingerprintConflict.expected.error, 'IDEMPOTENCY_CONFLICT');
  assert.notEqual(
    fixture.fingerprintConflict.first.payloadHash,
    fixture.fingerprintConflict.replay.payloadHash,
  );
});

test('Conversation Lane vectors use thread then root then chat while reply targets remain independent', () => {
  const fixture = loadContractFixture('feishu-intake.json');
  const lanes = new Map(fixture.conversationLanes.map((vector) => [vector.name, vector]));
  assert.equal(lanes.get('p2p-chat').laneKey, 'feishu:cli_app_a:p2p:oc_p2p_a:chat');
  assert.equal(lanes.get('group-main-chat').laneKey, 'feishu:cli_app_a:group:oc_group_a:chat');
  const firstReply = lanes.get('group-reply-tree-root-fallback');
  const secondReply = lanes.get('group-reply-tree-different-parent-same-lane');
  assert.equal(firstReply.laneKey, secondReply.laneKey);
  assert.notEqual(firstReply.platform.parentId, secondReply.platform.parentId);
  assert.notEqual(firstReply.replyTargetRef, secondReply.replyTargetRef);
  assert.equal(firstReply.laneKey.includes(firstReply.platform.parentId), false);
  assert.equal(firstReply.laneKey.includes(firstReply.platform.messageId), false);
  assert.equal(firstReply.laneKey.includes(firstReply.platform.upperMessageId), false);
  const topic = lanes.get('topic-group-thread-precedence');
  assert.match(topic.laneKey, /topic_group:oc_group_a:thread:omt_thread_a$/);
  assert.equal(topic.laneKey.includes(topic.platform.rootId), false);
});

test('Feishu Context Hints contain platform facts, not Core truncation or Runtime sessions', () => {
  const { contextHints } = loadContractFixture('feishu-intake.json');
  assert.equal(contextHints.ownedBy, 'feishu');
  assert.deepEqual(contextHints.allowedFields, [
    'threadRef',
    'rootRef',
    'parentRef',
    'quoteRefs',
    'mentionRefs',
    'attachmentRefs',
    'platformHistoryRefs',
  ]);
  assert.deepEqual(contextHints.forbiddenPolicyFields, [
    'tokenBudget',
    'truncation',
    'contextSnapshot',
    'runtimeSession',
  ]);
  assert.equal(contextHints.runtimeLane, 'runtime:shared');
  assert.equal(contextHints.runtimeCapacity, 1);
  assert.equal(contextHints.conversationLaneCreatesRuntimeSession, false);
});

test('Reply Presence settles only from explicit silent or delivery settlement', () => {
  const { presenceLifecycle } = loadContractFixture('feishu-presentation.json');
  assert.equal(presenceLifecycle.beginAfter, 'durable_acceptance');
  assert.ok(presenceLifecycle.keepActiveDuring.includes('card_opened'));
  assert.ok(presenceLifecycle.keepActiveDuring.includes('elapsed_over_120_seconds'));
  assert.ok(presenceLifecycle.keepActiveDuring.includes('delivery_unknown'));
  const unknown = presenceLifecycle.settlements.find((entry) => entry.on.includes('unknown'));
  assert.equal(unknown.presence, 'active');
  assert.equal(unknown.next, 'reconcile');
  const exhausted = presenceLifecycle.settlements.find((entry) => entry.on.includes('delivery_exhausted'));
  assert.equal(exhausted.delivered, false);
  assert.equal(exhausted.alert, true);
  assert.deepEqual(presenceLifecycle.orphanRecovery, {
    retryPresenceRemoval: true,
    resendFinalReply: false,
  });
});

test('Feishu projection and final adapter cannot own or block the Runtime terminal', () => {
  const { projection, finalAdapter } = loadContractFixture('feishu-presentation.json');
  assert.deepEqual(projection.coalesceKey, ['requestId', 'presentationId']);
  assert.deepEqual(projection.persisted, ['highWatermark', 'lastAppliedSequence', 'cardKitSequence']);
  assert.equal(projection.terminalBarrier.trailingFlush, true);
  assert.equal(projection.terminalBarrier.blocksFinalIntent, false);
  assert.equal(projection.projectionFailureCreatesRunFailed, false);
  assert.equal(projection.duplicateCreatesCard, false);
  assert.equal(projection.duplicateCreatesReaction, false);
  assert.equal(projection.progressAckScope, 'consumer_route');
  assert.equal(projection.globalAck, false);
  assert.equal(finalAdapter.physicalStore, 'feishu-local');
  assert.equal(finalAdapter.sharedPhysicalOutboxWithHxa, false);
  assert.equal(finalAdapter.unknownBeforeRetry, 'reconcile');
  assert.deepEqual(finalAdapter.redriveReuses, ['intentId', 'deliveryId']);
  assert.equal(finalAdapter.deliveryExhaustionChangesRunOutcome, false);
});

test('task paths use Task Effects and preserve verified actor authorization', () => {
  const fixture = loadContractFixture('feishu-task-effects.json');
  const routeAxes = Object.fromEntries(fixture.routes.map((route) => [route.name, route.axis]));
  assert.deepEqual(routeAxes, {
    chat_only: 'assistant_request',
    create_task: 'task_effect',
    confirmation: 'task_effect',
    task_action: 'task_effect',
    task_receipt: 'delivery',
  });
  assert.equal(fixture.command.actor.verified, true);
  for (const field of fixture.authorization.required) {
    assert.notEqual(fixture.command[field], undefined, `TaskCommand.${field} is required`);
  }
  assert.equal(fixture.authorization.assistantMayConstructActor, false);
  assert.equal(fixture.authorization.assistantMayWriteDatabase, false);
  assert.equal(fixture.nativeTask.sourceOfTruth, false);
  assert.equal(fixture.nativeTask.completionMapsTo, 'SubmitForReview');
  assert.equal(fixture.nativeTask.directDoneAllowed, false);
  assert.equal(fixture.receiptIntent.cause, 'task_effect');
  assert.equal(fixture.receiptIntent.manufacturesAssistantRunTerminal, false);
});

test.todo('production gateway namespaces transport/logical identities and assigns laneSequence after dedupe');
test.todo('production gateway coalesces WebSocket/Webhook duplicates into one request, card, and reaction');
test.todo('production history key falls back to root_id when thread_id is absent');
test.todo('production routing treats topic_group as a thread-capable group');
test.todo('production Reply Presence survives card open, progress, and 120 seconds');
test.todo('production projection timeouts never manufacture RunFailed');
test.todo('production final adapter reconciles unknown before retry and reuses intentId on redrive');
test.todo('production native-task edits enter durable inbox and issue authorized versioned Core commands');
