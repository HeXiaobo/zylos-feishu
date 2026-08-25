import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mapFeishuTaskAction,
  mapFeishuTaskIntent,
} from '../src/lib/commitment-mapper.js';

test('mapFeishuTaskIntent maps a normalized Feishu intent to a Core SourceEnvelope', () => {
  assert.deepEqual(
    mapFeishuTaskIntent({
      messageId: 'om_message_1',
      senderId: 'ou_sender_1',
      title: 'Prepare the customer follow-up report',
      description: 'Include the latest meeting notes.',
      ownerId: 'ou_owner_1',
      acceptorId: 'ou_acceptor_1',
      assigneeId: 'agent:yueran',
      dueAt: '2026-08-28T18:00:00+08:00',
    }),
    {
      idempotencyKey: 'feishu:om_message_1:task-intent',
      source: {
        channel: 'feishu',
        externalId: 'om_message_1',
        senderId: 'ou_sender_1',
      },
      task: {
        title: 'Prepare the customer follow-up report',
        description: 'Include the latest meeting notes.',
        ownerId: 'ou_owner_1',
        acceptorId: 'ou_acceptor_1',
        assigneeId: 'agent:yueran',
        dueAt: '2026-08-28T10:00:00.000Z',
      },
    },
  );
});

test('mapFeishuTaskIntent applies explicit Core defaults for optional task fields', () => {
  const envelope = mapFeishuTaskIntent({
    messageId: 'om_message_2',
    senderId: 'ou_sender_2',
    title: 'Call the customer',
    ownerId: 'ou_owner_2',
  });

  assert.deepEqual(envelope.task, {
    title: 'Call the customer',
    description: null,
    ownerId: 'ou_owner_2',
    acceptorId: 'ou_owner_2',
    assigneeId: null,
  });
});

test('Commitment mappers are deterministic and do not mutate normalized input', () => {
  const intent = Object.freeze({
    messageId: 'om_message_deterministic',
    senderId: 'ou_sender_deterministic',
    title: 'Publish the weekly summary',
    ownerId: 'ou_owner_deterministic',
  });
  const action = Object.freeze({
    eventId: 'event_deterministic',
    action: 'submit',
    taskId: 'task-deterministic',
    actorId: 'ou_actor_deterministic',
    expectedVersion: 3,
  });

  assert.deepEqual(mapFeishuTaskIntent(intent), mapFeishuTaskIntent(intent));
  assert.deepEqual(mapFeishuTaskAction(action), mapFeishuTaskAction(action));
});

test('mapFeishuTaskIntent rejects missing or blank normalized fields with TypeError', () => {
  const valid = {
    messageId: 'om_message_3',
    senderId: 'ou_sender_3',
    title: 'Draft a proposal',
    ownerId: 'ou_owner_3',
  };
  const invalidInputs = [
    undefined,
    {},
    { ...valid, messageId: '' },
    { ...valid, senderId: '   ' },
    { ...valid, title: '' },
    { ...valid, ownerId: '' },
    { ...valid, description: '' },
    { ...valid, acceptorId: '' },
    { ...valid, assigneeId: '' },
    { ...valid, dueAt: 'next Friday' },
  ];

  for (const input of invalidInputs) {
    assert.throws(() => mapFeishuTaskIntent(input), TypeError);
  }
});

test('mapFeishuTaskAction maps start to a Core StartTask command', () => {
  assert.deepEqual(
    mapFeishuTaskAction({
      eventId: 'event_start_1',
      action: 'start',
      taskId: 'task-1',
      actorId: 'ou_actor_1',
      expectedVersion: 7,
    }),
    {
      command: {
        type: 'StartTask',
        taskId: 'task-1',
        actorId: 'ou_actor_1',
        idempotencyKey: 'feishu:event_start_1:task-command',
      },
      expectedVersion: 7,
    },
  );
});

test('mapFeishuTaskAction maps every supported Feishu action to its Core command type', () => {
  const mappings = {
    start: 'StartTask',
    submit: 'SubmitForReview',
    complete: 'SubmitForReview',
    accept: 'AcceptTask',
    request_changes: 'RequestChanges',
    cancel: 'CancelTask',
    reopen: 'ReopenTask',
  };

  for (const [action, type] of Object.entries(mappings)) {
    assert.equal(
      mapFeishuTaskAction({
        eventId: `event_${action}`,
        action,
        taskId: 'task-2',
        actorId: 'ou_actor_2',
        expectedVersion: 1,
      }).command.type,
      type,
    );
  }
});

test('mapFeishuTaskAction rejects unknown actions and missing or blank fields with TypeError', () => {
  const valid = {
    eventId: 'event_valid',
    action: 'start',
    taskId: 'task-3',
    actorId: 'ou_actor_3',
    expectedVersion: 1,
  };
  const invalidInputs = [
    undefined,
    {},
    { ...valid, eventId: '' },
    { ...valid, action: '' },
    { ...valid, action: 'completed' },
    { ...valid, taskId: '' },
    { ...valid, actorId: '   ' },
    {
      eventId: valid.eventId,
      action: valid.action,
      taskId: valid.taskId,
      actorId: valid.actorId,
    },
    { ...valid, expectedVersion: 0 },
    { ...valid, expectedVersion: 1.5 },
  ];

  for (const input of invalidInputs) {
    assert.throws(() => mapFeishuTaskAction(input), TypeError);
  }
});
