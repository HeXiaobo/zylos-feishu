import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkIntakeConfirmationCardRenderer,
  createWorkIntakeConfirmationRuntime,
  isWorkIntakeConfirmationAction,
  parseWorkIntakeConfirmationAction,
} from '../src/lib/work-intake-confirmation-card.js';
import { createWorkIntakeConfirmationContextSigner } from '../src/lib/work-intake-confirmation-context.js';

const NOW = 1_777_777_777_000;
const signer = createWorkIntakeConfirmationContextSigner({
  secret: 'work-intake-confirmation-secret-at-least-32-bytes',
  clock: () => NOW,
});
const renderer = createWorkIntakeConfirmationCardRenderer({
  issueContext: (claims) => signer.issue(claims),
  clock: () => NOW,
  contextTtlMs: 60_000,
});

const decision = Object.freeze({
  decision: 'confirm',
  reasonCode: 'INSUFFICIENT_TASK_DETAIL',
  intentRevision: 1,
  sourceKey: 'feishu:om_confirm:work-intake:r1',
  taskDraft: Object.freeze({
    title: '跟一下这个事',
    description: null,
    ownerId: 'ou_sender',
    acceptorId: 'ou_sender',
    assigneeId: null,
    dueText: null,
    riskLevel: 'normal',
  }),
});
const inboundEnvelope = Object.freeze({
  source: Object.freeze({
    channel: 'feishu',
    messageId: 'om_confirm',
    conversationId: 'oc_confirm',
    conversationType: 'direct',
    threadId: null,
  }),
  sender: Object.freeze({ id: 'ou_sender', kind: 'human' }),
  text: '跟一下这个事',
  intentRevision: 1,
  receivedAt: '2026-08-25T03:00:00.000Z',
  timeZone: 'Asia/Shanghai',
  people: Object.freeze([]),
});

function cardAndContext() {
  const card = renderer.render({
    decision,
    inboundEnvelope,
    endpoint: 'oc_confirm|type:p2p|msg:om_confirm',
  });
  const buttons = card.body.elements.filter((element) => element.tag === 'button');
  return { card, buttons, context: buttons[0].behaviors[0].value.context };
}

function callback(action, context, actorId = 'ou_sender') {
  return {
    operator: { open_id: actorId },
    context: { open_message_id: 'om_confirmation_card' },
    action: {
      tag: 'button',
      value: { action, context },
    },
  };
}

test('renders the required create/chat/edit confirmation choices', () => {
  const { card, buttons } = cardAndContext();
  assert.equal(card.header.title.content, '这条消息要创建任务吗？');
  assert.deepEqual(
    buttons.map((button) => button.text.content),
    ['创建任务', '只当普通消息', '编辑'],
  );
  assert.equal(new Set(buttons.map((button) => button.behaviors[0].value.context)).size, 1);
});

test('trusted callback sends only a stable confirmation command to Core', () => {
  const { context } = cardAndContext();
  const route = parseWorkIntakeConfirmationAction(
    callback('work_intake_create_task', context),
    { verifyContext: (token) => signer.verify(token) },
  );
  assert.equal(route.kind, 'work-intake-confirmation');
  assert.equal(route.action, 'create_task');
  assert.deepEqual(route.confirmationRequest, {
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'create_task',
    actorId: 'ou_sender',
  });
  assert.equal(Object.hasOwn(route, 'taskEnvelope'), false);
  assert.equal(Object.hasOwn(route.claims, 'taskDraft'), false);
  assert.equal(Object.hasOwn(route.claims, 'originalText'), false);
  assert.equal(isWorkIntakeConfirmationAction(callback('work_intake_create_task', context)), true);
});

test('retry and duplicate clicks always produce the same Core confirmation key', async () => {
  const { context } = cardAndContext();
  const calls = [];
  const runtime = createWorkIntakeConfirmationRuntime({
    verifyContext: (token) => signer.verify(token),
    executeDecision: async (route) => {
      calls.push(route.confirmationRequest.sourceKey);
      return { queued: true };
    },
  });
  for (let retry = 0; retry < 10; retry += 1) {
    await runtime.handle(callback('work_intake_create_task', context));
  }
  assert.deepEqual(new Set(calls), new Set(['feishu:om_confirm:work-intake:r1']));
});

test('chat-only and edit callbacks carry only their Core confirmation choice', () => {
  const { context } = cardAndContext();
  for (const action of ['work_intake_chat_only', 'work_intake_edit']) {
    const route = parseWorkIntakeConfirmationAction(callback(action, context), {
      verifyContext: (token) => signer.verify(token),
    });
    assert.equal(Object.hasOwn(route, 'taskEnvelope'), false);
    assert.equal(route.confirmationRequest.action, action.replace('work_intake_', ''));
  }
});

test('rejects actor spoofing, a tampered token, and unsupported actions', () => {
  const { context } = cardAndContext();
  assert.throws(() => parseWorkIntakeConfirmationAction(
    callback('work_intake_create_task', context, 'ou_attacker'),
    { verifyContext: (token) => signer.verify(token) },
  ), /original human sender/);
  const tampered = `${context.slice(0, -1)}${context.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => parseWorkIntakeConfirmationAction(
    callback('work_intake_create_task', tampered),
    { verifyContext: (token) => signer.verify(token) },
  ), /invalid or expired/);
  assert.equal(isWorkIntakeConfirmationAction(callback('start', context)), false);
  assert.throws(() => parseWorkIntakeConfirmationAction(callback('start', context), {
    verifyContext: (token) => signer.verify(token),
  }), /unsupported/);
});
