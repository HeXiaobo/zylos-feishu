import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskActionContextSigner } from '../src/lib/task-action-context.js';
import {
  createTaskCardActionRuntime,
  createTaskCardEventHandlers,
  createTaskCardSender,
  routeVerifiedWebhookEvent,
} from '../src/lib/task-card-runtime.js';

const NOW = 1_700_000_000_000;
const SECRET = 'feishu-card-context-secret-32-bytes';

function task(overrides = {}) {
  return {
    id: 'task-runtime-1',
    title: 'Review the customer proposal',
    description: 'Confirm scope and price.',
    state: 'review',
    ownerId: 'ou_owner',
    acceptorId: 'ou_acceptor',
    assigneeId: 'agent:yueran',
    version: 7,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

test('sends a trusted Core task snapshot through the existing interactive message seam', async () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const calls = [];
  const sender = createTaskCardSender({
    sendMessage: async (...args) => {
      calls.push(args);
      return { success: true, messageId: 'om_task_card_1' };
    },
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  const result = await sender.send({
    receiveId: 'oc_task_chat',
    receiveIdType: 'chat_id',
    task: task(),
  });

  assert.deepEqual(result, { success: true, messageId: 'om_task_card_1' });
  assert.equal(calls.length, 1);
  const [receiveId, card, receiveIdType, msgType] = calls[0];
  assert.equal(receiveId, 'oc_task_chat');
  assert.equal(receiveIdType, 'chat_id');
  assert.equal(msgType, 'interactive');
  assert.equal(card.header.title.content, '任务待验收');

  const accept = card.elements
    .find((element) => element.tag === 'action')
    .actions.find((button) => button.value.action === 'accept');
  assert.deepEqual(contexts.verify(accept.value.context), {
    taskId: 'task-runtime-1',
    expectedVersion: 7,
    expiresAt: NOW + 10 * 60_000,
  });
  assert.equal(Object.hasOwn(accept.value, 'actorId'), false);
});

test('routes a real v2 card.action.trigger payload with the trusted Feishu operator', async () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-runtime-action',
    expectedVersion: 11,
    expiresAt: NOW + 10 * 60_000,
  });
  const calls = [];
  const runtime = createTaskCardActionRuntime({
    verifyTaskActionContext: (token) => contexts.verify(token),
    executeTaskAction: async (route) => {
      calls.push(route);
      return { ok: true, task: { id: route.command.taskId, version: 12 } };
    },
  });

  const result = await runtime.handle({
    context: {
      open_message_id: 'om_task_card_runtime',
      open_chat_id: 'oc_task_chat',
    },
    operator: {
      open_id: 'ou_trusted_card_operator',
      user_id: 'trusted-user-id',
    },
    action: {
      tag: 'button',
      value: { action: 'start', context },
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], result.route);
  assert.deepEqual(result.coreResult, {
    ok: true,
    task: { id: 'task-runtime-action', version: 12 },
  });
  assert.deepEqual(result.route, {
    kind: 'task-action',
    command: {
      type: 'StartTask',
      taskId: 'task-runtime-action',
      actorId: 'ou_trusted_card_operator',
      idempotencyKey: result.route.command.idempotencyKey,
    },
    expectedVersion: 11,
  });
  assert.match(
    result.route.command.idempotencyKey,
    /^feishu:card-[A-Za-z0-9_-]{43}:task-command$/,
  );
});

test('derives the same Core idempotency key for a retried card click', async () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-retried-click',
    expectedVersion: 3,
    expiresAt: NOW + 60_000,
  });
  const routes = [];
  const runtime = createTaskCardActionRuntime({
    verifyTaskActionContext: (token) => contexts.verify(token),
    executeTaskAction: async (route) => {
      routes.push(route);
      return { ok: true };
    },
  });
  const base = {
    context: {
      open_message_id: 'om_retried_card',
      open_chat_id: 'oc_task_chat',
    },
    operator: { open_id: 'ou_retrying_operator' },
  };

  await runtime.handle({
    ...base,
    action: {
      tag: 'button',
      value: { action: 'accept', context },
    },
  });
  await runtime.handle({
    ...base,
    action: {
      tag: 'button',
      value: { context, action: 'accept' },
    },
  });

  assert.equal(routes.length, 2);
  assert.equal(
    routes[0].command.idempotencyKey,
    routes[1].command.idempotencyKey,
  );
});

test('rejects actor injection from button value before reaching Core', async () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-actor-injection',
    expectedVersion: 2,
    expiresAt: NOW + 60_000,
  });
  let executed = false;
  const runtime = createTaskCardActionRuntime({
    verifyTaskActionContext: (token) => contexts.verify(token),
    executeTaskAction: async () => {
      executed = true;
    },
  });

  await assert.rejects(() => runtime.handle({
    context: {
      open_message_id: 'om_actor_injection',
      open_chat_id: 'oc_task_chat',
    },
    operator: { open_id: 'ou_trusted_operator' },
    action: {
      tag: 'button',
      value: {
        action: 'accept',
        context,
        actorId: 'ou_button_supplied_actor',
      },
    },
  }), TypeError);
  assert.equal(executed, false);
});

test('does not fall back to a legacy actor when a v2 operator is malformed', async () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-mixed-actor-shapes',
    expectedVersion: 2,
    expiresAt: NOW + 60_000,
  });
  let executed = false;
  const runtime = createTaskCardActionRuntime({
    verifyTaskActionContext: (token) => contexts.verify(token),
    executeTaskAction: async () => {
      executed = true;
    },
  });

  await assert.rejects(() => runtime.handle({
    context: {
      open_message_id: 'om_mixed_actor_shapes',
      open_chat_id: 'oc_task_chat',
    },
    operator: {},
    open_id: 'ou_legacy_fallback_must_not_win',
    action: {
      tag: 'button',
      value: { action: 'accept', context },
    },
  }), TypeError);
  assert.equal(executed, false);
});

test('exposes the exact WebSocket callback key and forwards its authenticated payload', async () => {
  const payload = {
    context: {
      open_message_id: 'om_ws_card_action',
      open_chat_id: 'oc_task_chat',
    },
    operator: { open_id: 'ou_ws_operator' },
    action: { tag: 'button', value: { action: 'start', context: 'signed' } },
  };
  const calls = [];
  const errors = [];
  const handlers = createTaskCardEventHandlers({
    handleTaskCardAction: async (event) => {
      calls.push(event);
      return { ok: true };
    },
    onError: (error) => errors.push(error),
  });

  assert.deepEqual(Object.keys(handlers), ['card.action.trigger']);
  const response = await handlers['card.action.trigger'](payload);

  assert.deepEqual(calls, [payload]);
  assert.deepEqual(errors, []);
  assert.deepEqual(response, {
    toast: { type: 'success', content: '任务操作已处理' },
  });
});

test('accepts the SDK legacy verified webhook callback shape', async () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-legacy-webhook',
    expectedVersion: 5,
    expiresAt: NOW + 60_000,
  });
  let route;
  const runtime = createTaskCardActionRuntime({
    verifyTaskActionContext: (token) => contexts.verify(token),
    executeTaskAction: async (input) => {
      route = input;
      return { ok: true };
    },
  });

  await runtime.handle({
    open_id: 'ou_legacy_trusted_operator',
    open_message_id: 'om_legacy_card',
    token: 'verified-by-webhook-transport',
    action: {
      tag: 'button',
      value: { action: 'request_changes', context },
    },
  });

  assert.equal(route.command.type, 'RequestChanges');
  assert.equal(route.command.actorId, 'ou_legacy_trusted_operator');
  assert.equal(route.expectedVersion, 5);
});

test('fails a card callback closed when its runtime is not configured', async () => {
  const unavailable = new Error('signed task actions are not configured');
  const errors = [];
  const handlers = createTaskCardEventHandlers({
    handleTaskCardAction: async () => {
      throw unavailable;
    },
    onError: (error) => errors.push(error),
  });

  await assert.rejects(
    () => handlers['card.action.trigger']({}),
    unavailable,
  );
  assert.deepEqual(errors, [unavailable]);
});

test('does not produce a webhook success ack before Core completes', async () => {
  let completeCore;
  const coreCompletion = new Promise((resolve) => {
    completeCore = resolve;
  });
  const handlers = createTaskCardEventHandlers({
    handleTaskCardAction: async () => coreCompletion,
    onError() {},
  });
  let settled = false;

  const responsePromise = routeVerifiedWebhookEvent(
    {
      header: { event_type: 'card.action.trigger' },
      event: {},
    },
    handlers['card.action.trigger'],
  )
    .then((response) => {
      settled = true;
      return response;
    });
  await Promise.resolve();
  assert.equal(settled, false);

  completeCore({ ok: true });
  const response = await responsePromise;
  assert.equal(settled, true);
  assert.deepEqual(response, {
    statusCode: 200,
    body: { toast: { type: 'success', content: '任务操作已处理' } },
  });
});

test('returns a retryable webhook status when the Core command fails', async () => {
  const handlers = createTaskCardEventHandlers({
    handleTaskCardAction: async () => {
      throw new Error('Core temporarily unavailable');
    },
    onError() {},
  });

  const response = await routeVerifiedWebhookEvent(
    {
      header: { event_type: 'card.action.trigger' },
      event: {},
    },
    handlers['card.action.trigger'],
  );

  assert.deepEqual(response, {
    statusCode: 503,
    body: {
      toast: { type: 'error', content: '任务操作失败，请刷新任务后重试' },
    },
  });
});

test('keeps ordinary message webhooks on the immediate-ack path', async () => {
  let cardHandlerCalled = false;

  const response = await routeVerifiedWebhookEvent({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: { message_id: 'om_ordinary_message' },
      sender: { sender_id: { open_id: 'ou_sender' } },
    },
  }, async () => {
    cardHandlerCalled = true;
  });

  assert.deepEqual(response, {
    statusCode: 200,
    body: { code: 0 },
  });
  assert.equal(cardHandlerCalled, false);
});
