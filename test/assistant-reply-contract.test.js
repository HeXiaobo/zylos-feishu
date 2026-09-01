import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COMMON_CONTRACT_DIGEST,
  assertAcceptMessage,
  assertAcceptedMessage,
  assertAuthorizationDecision,
  assertCancelRequest,
  assertCommonContractDigest,
  assertCommonContractReference,
  assertContextSnapshot,
  assertDeliveryReceipt,
  assertDeliverySettlement,
  assertReplyIntent,
  assertReplyOutcome,
  assertRunEventVector,
  assertTaskCommand,
  loadCommonContractFixture,
  loadContractFixture,
  logicalMessageKey,
  transportKey,
} from './helpers/assistant-reply-contract.js';

const FIXTURE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/assistant-reply-contract/v1',
);

test('common fixture manifest freezes the cross-repository contract bytes', () => {
  const manifest = loadContractFixture('fixture-manifest.json');
  assert.equal(manifest.algorithm, 'sha256');
  assert.deepEqual(manifest.commonContracts, [{
    name: 'zylos.assistant-reply-contract/v1',
    file: 'common-contract-vectors.json',
    sha256: COMMON_CONTRACT_DIGEST,
  }]);
  const bytes = fs.readFileSync(path.join(FIXTURE_DIRECTORY, 'common-contract-vectors.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), COMMON_CONTRACT_DIGEST);
  assertCommonContractDigest();
});

test('common contract records the ownership and delivery semantics used by adapters', () => {
  const common = loadCommonContractFixture();
  assert.equal(common.schemaVersion, 1);
  assert.equal(common.contractId, 'zylos.assistant-reply-contract/v1');
  assert.equal(common.runtimeLane.runtimeLaneId, 'runtime:shared');
  assert.equal(common.runtimeLane.capacity, 1);
  assert.equal(common.runtimeLane.conversationLaneAcceptance, 'concurrent');
  assert.equal(common.runtimeLane.laneExposure, 'head_only');
  assert.equal(common.runtimeLane.ordinaryMessageDuringActiveTurn, 'queued');
  assert.equal(common.runtimeLane.ordinaryMessageMayAppendOrPreempt, false);
  assertCancelRequest(common.cancelRequest);
  assertContextSnapshot(common.contextSnapshot);
  assert.equal(
    common.contextSnapshot.conversationLaneKey,
    common.acceptMessage.accepted.conversationLaneKey,
  );
  assert.equal(common.semantics.platformAcceptedMeans, 'platform_accepted_not_user_read');
  assert.equal(common.semantics.progressReliability, 'best_effort_projection');
  assert.equal(common.semantics.finalDeliveryReliability, 'durable_outbox_at_least_once');
  assert.equal(common.semantics.unknownOutcomePolicy, 'reconcile_before_retry');
  assert.equal(common.semantics.silentCreatesReplyIntent, false);
  assert.equal(common.semantics.cancelledCreatesReplyIntent, false);
  assert.equal(common.semantics.cancelledFinishesPresence, true);
});

test('Feishu AcceptMessage binding keeps source identity derived and routes opaque', () => {
  const common = loadCommonContractFixture();
  const fixture = loadContractFixture('accept-message.json');
  assert.equal(fixture.contract, 'FeishuIntakeAdapter');
  assertCommonContractReference(fixture.commonContractRef, 'acceptMessage');
  const { command, accepted, replayRules } = common.acceptMessage;
  assertAcceptMessage(command);
  assertAcceptedMessage(accepted);
  assert.equal(accepted.conversationLaneKey, 'feishu:acct-01:group:chat-01:reply:root-01');
  assert.equal(accepted.laneSequence, 42);
  assert.equal(command.source.targetRef.startsWith('opaque:'), true);
  assert.equal(command.source.conversationKey.startsWith('opaque:'), true);
  assert.equal(fixture.identity.derivedOnly, true);
  assert.deepEqual(replayRules.transportIdentityFields, [
    'source.adapterId',
    'source.accountRef',
    'source.eventType',
    'source.eventId',
  ]);
  assert.deepEqual(replayRules.logicalMessageIdentityFields, [
    'source.adapterId',
    'source.accountRef',
    'source.eventType',
    'source.messageId',
  ]);
  assert.equal(replayRules.sameKeyDifferentPayload, 'IDEMPOTENCY_CONFLICT');
});

test('dual Feishu identities deduplicate before allocating one presentation and presence', () => {
  const fixture = loadContractFixture('accept-message.json');
  const { websocket, webhook, expected } = fixture.duplicateDelivery;
  assert.notEqual(transportKey(websocket), transportKey(webhook));
  assert.equal(logicalMessageKey(websocket), logicalMessageKey(webhook));
  assert.equal(websocket.payloadHash, webhook.payloadHash);
  assert.equal(expected.logicalMessageProducesOne, true);
  for (const field of ['presentationIds', 'presenceEffectIds', 'cardIds', 'reactionIds']) {
    assert.equal(expected[field].length, 1, `${field} must be allocated once`);
  }
  assert.equal(fixture.fingerprintConflict.expected.error, 'IDEMPOTENCY_CONFLICT');
  assert.notEqual(
    fixture.fingerprintConflict.first.payloadHash,
    fixture.fingerprintConflict.replay.payloadHash,
  );
});

test('Runtime events preserve generation fencing, monotonic sequence, and one last terminal', () => {
  const common = loadCommonContractFixture();
  const fixture = loadContractFixture('run-events.json');
  assert.equal(fixture.contract, 'FeishuProgressAdapter');
  assertCommonContractReference(fixture.commonContractRef, 'runtimeEventStreams');
  common.runtimeEventStreams.forEach(assertRunEventVector);
  assert.deepEqual(
    common.runtimeEventStreams.map((vector) => vector.events.at(-1).type),
    ['RunCompleted', 'RunFailed', 'RunCancelled', 'RunCompleted'],
  );
  assert.equal(fixture.projection.consumes.includes('ProgressUpdated'), true);
  assert.equal(fixture.projection.consumes.includes('OutputDelta'), true);
  assert.equal(fixture.projection.ignoresExecutionTerminal, true);
  assert.equal(fixture.projection.finalIntentIndependent, true);
  const answer = common.runtimeEventStreams.find((vector) => vector.name === 'answer-completed');
  const answerStart = answer.events.find((event) => event.type === 'RunStarted');
  assert.equal(answerStart.payload.runtimeLaneId, 'runtime:shared');
  assert.equal(answerStart.payload.runtimeLane, undefined);
  assert.equal(answer.events.find((event) => event.type === 'OutputDelta').payload.text, 'The decision is approved.');
  assert.equal(answer.events.at(-1).payload.outcomeId, 'outcome:req-001');
  const cancelled = common.runtimeEventStreams.find((vector) => vector.name === 'run-cancelled');
  assert.equal(cancelled.events.at(-1).payload.outcomeId, undefined);
  const cancelledBinding = fixture.streamBindings.find((binding) => binding.name === 'cancelled');
  assert.equal(cancelledBinding.presenceSettlement, 'cancelled_confirmed');
});

test('ReplyOutcome and ReplyIntent keep silent and cancellation execution-only', () => {
  const common = loadCommonContractFixture();
  const fixture = loadContractFixture('reply-intents.json');
  assertCommonContractReference(fixture.commonContractRef, 'replyIntents');
  for (const outcome of Object.values(common.replyOutcomes)) assertReplyOutcome(outcome);
  for (const intent of Object.values(common.replyIntents)) assertReplyIntent(intent);
  assert.equal(Object.keys(common.replyIntents).includes('silent'), false);
  assert.equal(common.replyOutcomes.silent.explicit, true);
  assert.equal(fixture.silent.replyIntent, 'none');
  assert.equal(fixture.silent.presenceSettlement, 'explicit_silent');
  assert.equal(fixture.invalid[0].expectedError, 'MISSING_OUTPUT');
  assert.equal(common.replyOutcomes.invalidEmptyAnswer.content.text, '');
  assert.equal(fixture.bindings.find((binding) => binding.name === 'answer').presentation, 'card');
  assert.equal(fixture.bindings.find((binding) => binding.name === 'failure-notice').presentation, 'failure_notice');
});

test('DeliveryReceipt uses outcome/externalRef and independent settlements', () => {
  const common = loadCommonContractFixture();
  const fixture = loadContractFixture('delivery-receipts.json');
  assertCommonContractReference(fixture.commonReceiptRef, 'deliveryReceipts');
  assertCommonContractReference(fixture.commonSettlementRef, 'deliverySettlements');
  for (const receipt of Object.values(common.deliveryReceipts)) assertDeliveryReceipt(receipt);
  for (const settlement of Object.values(common.deliverySettlements)) assertDeliverySettlement(settlement);
  assert.equal(fixture.receiptPolicy.outcomeField, 'outcome');
  assert.equal(fixture.receiptPolicy.externalRefField, 'externalRef');
  assert.deepEqual(fixture.receiptPolicy.forbiddenFields, [
    'result',
    'userRead',
    'userReceived',
    'settlement',
  ]);
  assert.equal(common.deliveryReceipts.unknown.nextAction, 'reconcile_before_retry');
  assert.equal(common.deliverySettlements.unpresentable.basis, 'retry_exhausted');
  assert.equal(common.deliverySettlements.unpresentable.presented, false);
  assert.equal(fixture.receiptPolicy.retryExhaustion, 'delivery_settlement');
});

test('Conversation Lane vectors use thread then root then chat while reply targets remain independent', () => {
  const fixture = loadContractFixture('accept-message.json');
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
  const { contextHints } = loadContractFixture('accept-message.json');
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
  assert.deepEqual(contextHints.coreOwns, [
    'authorized-selection',
    'general-token-truncation',
    'immutable-context-snapshot',
  ]);
  assert.equal(contextHints.runtimeLaneId, 'runtime:shared');
  assert.equal(contextHints.runtimeLane, undefined);
  assert.equal(contextHints.runtimeCapacity, 1);
  assert.equal(contextHints.conversationLaneCreatesRuntimeSession, false);
});

test('Reply Presence settles only from explicit silent, confirmed cancellation, or delivery settlement', () => {
  const { presenceLifecycle, commonContractRefs } = loadContractFixture('feishu-presentation.json');
  assertCommonContractReference(commonContractRefs.find((ref) => ref.pointer === 'replyOutcomes'), 'replyOutcomes');
  assertCommonContractReference(commonContractRefs.find((ref) => ref.pointer === 'deliverySettlements'), 'deliverySettlements');
  assert.equal(presenceLifecycle.beginAfter, 'durable_acceptance');
  assert.ok(presenceLifecycle.keepActiveDuring.includes('card_opened'));
  assert.ok(presenceLifecycle.keepActiveDuring.includes('elapsed_over_120_seconds'));
  assert.ok(presenceLifecycle.keepActiveDuring.includes('delivery_unknown'));
  const silent = presenceLifecycle.settlements.find((entry) => entry.intent === 'silent');
  assert.deepEqual(silent.on, ['suppressed']);
  const cancelled = presenceLifecycle.settlements.find((entry) => entry.intent === 'cancelled');
  assert.deepEqual(cancelled.on, ['cancelled_confirmed']);
  assert.equal(cancelled.presence, 'finished');
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
  assert.equal(finalAdapter.platformAcceptedMeansUserRead, false);
  assert.equal(finalAdapter.deliveryExhaustionChangesRunOutcome, false);
});

test('task paths use structured TaskCommand and preserve verified actor authorization', () => {
  const common = loadCommonContractFixture();
  const fixture = loadContractFixture('feishu-task-effects.json');
  assertCommonContractReference(fixture.commonTaskRef, 'taskCommand');
  assert.equal(fixture.commonReceiptIntentRef.pointer, 'replyIntents.taskReceipt');
  assert.equal(fixture.commonReceiptIntentRef.cause, 'task_effect');
  assertTaskCommand(common.taskCommand.command);
  assertAuthorizationDecision(common.taskCommand.authorizationDecision);
  const routeAxes = Object.fromEntries(fixture.routes.map((route) => [route.name, route.axis]));
  assert.deepEqual(routeAxes, {
    chat_only: 'assistant_request',
    create_task: 'task_effect',
    confirmation: 'task_effect',
    task_action: 'task_effect',
    task_receipt: 'delivery',
  });
  for (const field of fixture.authorization.required) {
    assert.notEqual(common.taskCommand.command[field], undefined, `TaskCommand.${field} is required`);
  }
  assert.equal(fixture.authorization.assistantMayConstructActor, false);
  assert.equal(fixture.authorization.assistantMayWriteDatabase, false);
  assert.equal(fixture.nativeTask.sourceOfTruth, false);
  assert.equal(fixture.nativeTask.completionMapsTo, 'SubmitForReview');
  assert.equal(fixture.nativeTask.directDoneAllowed, false);
});

test.todo('production gateway namespaces transport/logical identities and assigns laneSequence after dedupe');
test.todo('production gateway coalesces WebSocket/Webhook duplicates into one request, card, and reaction');
test.todo('production history key falls back to root_id when thread_id is absent');
test.todo('production routing treats topic_group as a thread-capable group');
test.todo('production Reply Presence survives card open, progress, and 120 seconds');
test.todo('production projection timeouts never manufacture RunFailed');
test.todo('production final adapter reconciles unknown before retry and reuses intentId on redrive');
test.todo('production native-task edits enter durable inbox and issue authorized versioned Core commands');
