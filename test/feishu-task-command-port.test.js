import assert from 'node:assert/strict';
import test from 'node:test';

import { createFeishuTaskCommandPort } from '../src/lib/feishu-task-command-port.js';

function request(origin, overrides = {}) {
  return {
    requestId: `req-${origin}`,
    turnId: `turn:req-${origin}:1`,
    sourceKey: `feishu:acct-1:${origin}:evt-1`,
    source: {
      adapterId: 'feishu',
      accountRef: 'acct-1',
      eventType: 'task.action_v1',
      eventId: `evt-${origin}`,
      messageId: 'msg-1',
    },
    actor: {
      provider: 'feishu',
      tenantRef: 'tenant-1',
      externalId: 'user-1',
      provenance: 'verified_channel_actor',
    },
    actorAssertion: Object.freeze({ authority: `gateway-${origin}` }),
    origin,
    capability: 'task.submit_for_review',
    intent: {
      taskId: 'task-1',
      command: 'SubmitForReview',
      expectedVersion: 7,
    },
    ...overrides,
  };
}

test('assistant tool and structured task action use one TaskCommandPort with verified identity', () => {
  const assertions = [];
  const executions = [];
  const port = createFeishuTaskCommandPort({
    taskCore: {
      acceptIntent() {
        throw new Error('existing-task commands must use executeCommand');
      },
      executeCommand(...args) {
        assertions.push(args[3]);
        executions.push(args);
        return { accepted: true, task: { id: 'task-1', version: 8, state: 'review' } };
      },
    },
  });

  for (const origin of ['assistant_tool', 'structured_action']) {
    assert.equal(port.submit(request(origin)).accepted, true);
  }

  assert.deepEqual(assertions, [
    request('assistant_tool').actorAssertion,
    request('structured_action').actorAssertion,
  ]);
  assert.deepEqual(executions.map(args => args.slice(4)), [
    ['task-1', 'SubmitForReview', 7, 'task.submit_for_review'],
    ['task-1', 'SubmitForReview', 7, 'task.submit_for_review'],
  ]);
});

test('AI intent cannot inject actor, source, capability, or database authority', () => {
  const port = createFeishuTaskCommandPort({
    taskCore: {
      acceptIntent() {
        throw new Error('must not dispatch');
      },
      executeCommand() {
        throw new Error('must not dispatch');
      },
    },
  });

  for (const injected of [
    { actor: { externalId: 'attacker' } },
    { source: { adapterId: 'hxa' } },
    { capability: 'task.accept' },
    { ownerId: 'attacker' },
  ]) {
    assert.throws(
      () => port.submit(request('assistant_tool', {
        intent: { ...request('assistant_tool').intent, ...injected },
      })),
      /unsupported task intent field/,
    );
  }
});

test('create task uses the same port while channels without Task capability fail explicitly', () => {
  const calls = [];
  const port = createFeishuTaskCommandPort({
    taskCore: {
      acceptIntent(...args) {
        calls.push(args);
        return { accepted: true, task: { id: 'task-created', version: 1 } };
      },
      executeCommand() {
        throw new Error('create must not use executeCommand');
      },
    },
  });
  const create = request('assistant_tool', {
    capability: 'task.create',
    intent: { command: 'CreateTask', title: 'Use the shared port' },
  });
  assert.equal(port.submit(create).task.id, 'task-created');
  assert.deepEqual(calls[0].slice(0, 3), [
    create.requestId,
    create.turnId,
    create.sourceKey,
  ]);
  assert.deepEqual(calls[0][4], create.intent);

  assert.throws(
    () => port.submit({
      ...create,
      source: { ...create.source, adapterId: 'hxa-connect' },
    }),
    error => error?.code === 'UNSUPPORTED_CAPABILITY',
  );
  assert.throws(
    () => port.submit({ ...create, actorAssertion: null }),
    error => error?.code === 'UNVERIFIED_ACTOR',
  );
});
