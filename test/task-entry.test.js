import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildC4ReceiveArgs,
  buildZylosTaskCommandArgs,
  isExplicitTaskProtocolMessage,
  parseExplicitTaskMessage,
} from '../src/lib/task-entry.js';
import { createTaskActionContextSigner } from '../src/lib/task-action-context.js';

const NOW = 1_700_000_000_000;
const SECRET = 'feishu-card-context-secret-32-bytes';

test('routes an explicit create protocol to C4 with a normalized task envelope', () => {
  const route = parseExplicitTaskMessage({
    messageType: 'text',
    text: '/zylos-task create {"title":"Follow up the customer","description":"Send the revised proposal","assigneeId":"agent:yueran","dueAt":"2026-08-28T18:00:00+08:00"}',
    messageId: 'om_task_create_1',
    actorId: 'ou_creator_1',
  });

  assert.deepEqual(route, {
    kind: 'task-intent',
    taskEnvelope: {
      idempotencyKey: 'feishu:om_task_create_1:task-intent',
      source: {
        channel: 'feishu',
        externalId: 'om_task_create_1',
        senderId: 'ou_creator_1',
      },
      task: {
        title: 'Follow up the customer',
        description: 'Send the revised proposal',
        ownerId: 'ou_creator_1',
        acceptorId: 'ou_creator_1',
        assigneeId: 'agent:yueran',
        dueAt: '2026-08-28T10:00:00.000Z',
      },
    },
  });

  assert.deepEqual(
    buildC4ReceiveArgs({
      receiverPath: '/opt/zylos/c4-receive.js',
      source: 'feishu',
      endpoint: 'oc_chat|type:p2p|msg:om_task_create_1',
      content: '[Feishu DM] Creator said: create a task',
      taskEnvelope: route.taskEnvelope,
    }),
    [
      '/opt/zylos/c4-receive.js',
      '--channel', 'feishu',
      '--endpoint', 'oc_chat|type:p2p|msg:om_task_create_1',
      '--json',
      '--task-envelope-json', JSON.stringify(route.taskEnvelope),
      '--content', '[Feishu DM] Creator said: create a task',
    ],
  );

  assert.deepEqual(
    buildC4ReceiveArgs({
      receiverPath: '/opt/zylos/c4-receive.js',
      source: 'feishu',
      endpoint: 'oc_chat|type:p2p|msg:om_ordinary',
      content: '[Feishu DM] Sender said: ordinary chat',
      assistantRequest: {
        requestId: 'assistant.feishu.om_ordinary',
        sourceId: 'om_ordinary',
      },
    }),
    [
      '/opt/zylos/c4-receive.js',
      '--channel', 'feishu',
      '--endpoint', 'oc_chat|type:p2p|msg:om_ordinary',
      '--json',
      '--assistant-request-id', 'assistant.feishu.om_ordinary',
      '--assistant-source-id', 'om_ordinary',
      '--block-queue-until-idle',
      '--content', '[Feishu DM] Sender said: ordinary chat',
    ],
  );
});

test('recognizes only the explicit text protocol and leaves ordinary chat on the original C4 path', () => {
  assert.equal(
    isExplicitTaskProtocolMessage({
      messageType: 'text',
      text: '/zylos-task action {"action":"start","context":"token"}',
    }),
    true,
  );
  assert.equal(
    isExplicitTaskProtocolMessage({
      messageType: 'text',
      text: 'Please remember to follow up with this customer.',
    }),
    false,
  );
  assert.equal(
    isExplicitTaskProtocolMessage({
      messageType: 'text',
      text: '/zylos-taskish create something',
    }),
    false,
  );
  assert.equal(
    isExplicitTaskProtocolMessage({
      messageType: 'text',
      text: '/zylos-task\ncreate {"title":"Task"}',
    }),
    true,
  );
  assert.equal(
    isExplicitTaskProtocolMessage({
      messageType: 'interactive',
      text: '/zylos-task create {"title":"Not a text command"}',
    }),
    false,
  );
  assert.equal(
    parseExplicitTaskMessage({
      messageType: 'text',
      text: 'Please create a task to follow up with this customer.',
      messageId: 'om_ordinary',
      actorId: 'ou_sender',
    }),
    null,
  );
  assert.deepEqual(
    buildC4ReceiveArgs({
      receiverPath: '/opt/zylos/c4-receive.js',
      source: 'feishu',
      endpoint: 'oc_chat|type:p2p|msg:om_ordinary',
      content: '[Feishu DM] Sender said: ordinary chat',
    }),
    [
      '/opt/zylos/c4-receive.js',
      '--channel', 'feishu',
      '--endpoint', 'oc_chat|type:p2p|msg:om_ordinary',
      '--json',
      '--content', '[Feishu DM] Sender said: ordinary chat',
    ],
  );
});

test('passes a channel-neutral WorkIntake envelope to C4 without a task envelope', () => {
  const workIntakeEnvelope = {
    source: {
      channel: 'feishu',
      messageId: 'om_natural',
      conversationId: 'oc_natural',
      conversationType: 'direct',
      threadId: null,
    },
    sender: { id: 'ou_sender', kind: 'human' },
    text: '请玥然整理客户记录',
    intentRevision: 1,
    receivedAt: null,
    timeZone: 'Asia/Shanghai',
    people: [],
  };
  assert.deepEqual(buildC4ReceiveArgs({
    receiverPath: '/opt/zylos/c4-receive.js',
    source: 'feishu',
    endpoint: 'oc_natural|type:p2p|msg:om_natural',
    content: '[Feishu DM] Sender said: natural task',
    workIntakeEnvelope,
  }), [
    '/opt/zylos/c4-receive.js',
    '--channel', 'feishu',
    '--endpoint', 'oc_natural|type:p2p|msg:om_natural',
    '--json',
    '--work-intake-envelope-json', JSON.stringify(workIntakeEnvelope),
    '--content', '[Feishu DM] Sender said: natural task',
  ]);

  assert.throws(() => buildC4ReceiveArgs({
    receiverPath: '/opt/zylos/c4-receive.js',
    source: 'feishu',
    endpoint: 'oc_natural',
    content: 'invalid dual route',
    taskEnvelope: { idempotencyKey: 'task' },
    workIntakeEnvelope,
  }), /mutually exclusive/);
});

test('passes a confirmation choice to the Core-owned WorkIntake resolver', () => {
  const confirmationRequest = {
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'create_task',
    actorId: 'ou_sender',
  };
  const args = buildC4ReceiveArgs({
    receiverPath: '/opt/zylos/c4-receive.js',
    source: 'feishu',
    endpoint: 'oc_chat|type:p2p|msg:om_confirm',
    content: '[WorkIntake confirmation]',
    workIntakeConfirmation: confirmationRequest,
  });
  assert.deepEqual(args.slice(-4), [
    '--work-intake-confirmation-json', JSON.stringify(confirmationRequest),
    '--content', '[WorkIntake confirmation]',
  ]);
});

test('passes a delivered confirmation effect to the Core-owned effect acknowledger', () => {
  const effect = {
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'edit',
    actorId: 'ou_sender',
    effectKey: 'feishu:om_confirm:work-intake:r1:edit-guidance',
    capability: 'wic1.payload.signature',
  };
  const args = buildC4ReceiveArgs({
    receiverPath: '/opt/zylos/c4-receive.js',
    source: 'feishu',
    endpoint: 'oc_chat|type:p2p|msg:om_confirm',
    content: '[WorkIntake confirmation effect]',
    workIntakeConfirmationEffect: effect,
  });
  assert.deepEqual(args.slice(-4), [
    '--work-intake-confirmation-effect-json', JSON.stringify(effect),
    '--content', '[WorkIntake confirmation effect]',
  ]);
});

test('verifies an explicit complete action and binds the trusted event actor before invoking Core', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-action-1',
    expectedVersion: 3,
    expiresAt: NOW + 60_000,
  });
  const route = parseExplicitTaskMessage({
    messageType: 'text',
    text: `/zylos-task action ${JSON.stringify({ action: 'complete', context })}`,
    messageId: 'om_task_action_1',
    actorId: 'ou_verified_actor',
  }, {
    verifyTaskActionContext: (token) => contexts.verify(token),
  });

  assert.deepEqual(route, {
    kind: 'task-action',
    command: {
      type: 'SubmitForReview',
      taskId: 'task-action-1',
      actorId: 'ou_verified_actor',
      idempotencyKey: 'feishu:om_task_action_1:task-command',
    },
    expectedVersion: 3,
  });
  assert.deepEqual(buildZylosTaskCommandArgs(route), [
    'task', 'submit', 'task-action-1',
    '--actor', 'ou_verified_actor',
    '--expected-version', '3',
    '--idempotency-key', 'feishu:om_task_action_1:task-command',
    '--json',
  ]);
});

test('fails closed for malformed protocols, untrusted action fields, and invalid contexts', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const validContext = contexts.issue({
    taskId: 'task-secure',
    expectedVersion: 2,
    expiresAt: NOW + 60_000,
  });
  const base = {
    messageType: 'text',
    messageId: 'om_invalid',
    actorId: 'ou_verified_actor',
  };
  const invalidMessages = [
    '/zylos-task',
    '/zylos-task delete {}',
    '/zylos-task create {not-json',
    '/zylos-task create []',
    '/zylos-task create {"title":"Task","ownerId":"ou_spoofed"}',
    '/zylos-task action {"action":"start"}',
    `/zylos-task action ${JSON.stringify({
      action: 'start',
      context: validContext,
      actorId: 'ou_spoofed',
    })}`,
  ];

  for (const text of invalidMessages) {
    assert.throws(
      () => parseExplicitTaskMessage(
        { ...base, text },
        { verifyTaskActionContext: (token) => contexts.verify(token) },
      ),
      TypeError,
    );
  }

  const tamperedContext = `${validContext.slice(0, -1)}${validContext.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => parseExplicitTaskMessage(
    {
      ...base,
      text: `/zylos-task action ${JSON.stringify({
        action: 'start',
        context: tamperedContext,
      })}`,
    },
    { verifyTaskActionContext: (token) => contexts.verify(token) },
  ));
  assert.throws(() => parseExplicitTaskMessage({
    ...base,
    text: `/zylos-task action ${JSON.stringify({
      action: 'start',
      context: validContext,
    })}`,
  }), TypeError);
});

test('fails closed before building an unsupported or malformed Core task command', () => {
  const valid = {
    command: {
      type: 'StartTask',
      taskId: 'task-1',
      actorId: 'ou_actor',
      idempotencyKey: 'feishu:om_1:task-command',
    },
    expectedVersion: 1,
  };

  const invalidRoutes = [
    { ...valid, command: { ...valid.command, type: 'DeleteTask' } },
    { ...valid, command: { ...valid.command, taskId: '' } },
    { ...valid, command: { ...valid.command, actorId: '   ' } },
    { ...valid, command: { ...valid.command, idempotencyKey: '' } },
    { ...valid, expectedVersion: 0 },
    { ...valid, expectedVersion: 1.5 },
  ];

  for (const route of invalidRoutes) {
    assert.throws(() => buildZylosTaskCommandArgs(route), TypeError);
  }
});
