import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskActionContextSigner } from '../src/lib/task-action-context.js';
import { buildZylosTaskCommandArgs } from '../src/lib/task-entry.js';
import {
  createTaskReviewCardRenderer,
  parseTaskReviewCardAction,
} from '../src/lib/task-review-card.js';

const NOW = 1_700_000_000_000;
const EXPIRES_AT = NOW + 10 * 60_000;
const SECRET = 'feishu-card-context-secret-32-bytes';

function task(overrides = {}) {
  return {
    id: 'task-123',
    title: 'Review the customer proposal',
    description: 'Confirm scope and price.',
    state: 'review',
    ownerId: 'ou_owner',
    acceptorId: 'ou_acceptor',
    assigneeId: 'agent:yueran',
    version: 4,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-25T10:00:00.000Z',
    ...overrides,
  };
}

test('renders review tasks with signed accept and request-changes actions', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  const card = renderer.render(task());
  const buttons = card.body.elements.filter((element) => element.tag === 'button');

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(Object.hasOwn(card.config, 'wide_screen_mode'), false);
  assert.equal(card.body.elements.some((element) => element.tag === 'action'), false);
  assert.equal(card.header.title.tag, 'plain_text');
  assert.deepEqual(
    buttons.map((button) => button.behaviors[0].value.action),
    ['accept', 'request_changes'],
  );
  for (const button of buttons) {
    assert.deepEqual(button.behaviors.map(({ type }) => type), ['callback']);
    assert.deepEqual(contexts.verify(button.behaviors[0].value.context), {
      taskId: 'task-123',
      expectedVersion: 4,
      expiresAt: EXPIRES_AT,
    });
    assert.equal(Object.hasOwn(button.behaviors[0].value, 'actorId'), false);
  }
});

test('renders only the allowed action semantics for each Core task state', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const expectedActions = {
    ready: ['start', 'cancel'],
    in_progress: ['submit', 'cancel'],
    review: ['accept', 'request_changes'],
    done: [],
    cancelled: [],
  };

  for (const [state, expected] of Object.entries(expectedActions)) {
    const card = renderer.render(task({
      state,
      ...(['ready', 'in_progress'].includes(state)
        ? { assigneeId: 'ou_acceptor' }
        : {}),
    }));
    const actual = card.body.elements
      .filter((element) => element.tag === 'button')
      .map((button) => button.behaviors[0].value.action);

    assert.deepEqual(actual, expected, state);
    assert.equal(actual.includes('complete'), false, state);
    assert.equal(actual.includes('done'), false, state);
    assert.equal(actual.includes('reopen'), false, state);
  }
});

test('hides Start from the acceptor DM when another assignee owns execution', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  const card = renderer.render(task({
    state: 'ready',
    acceptorId: 'ou_human_acceptor',
    assigneeId: 'agent:yueran',
  }));
  const actions = card.body.elements
    .filter((element) => element.tag === 'button')
    .map((button) => button.behaviors[0].value.action);

  assert.deepEqual(actions, ['cancel']);
});

test('hides Submit from the acceptor DM when another assignee owns execution', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });

  const card = renderer.render(task({
    state: 'in_progress',
    acceptorId: 'ou_human_acceptor',
    assigneeId: 'agent:yueran',
  }));
  const actions = card.body.elements
    .filter((element) => element.tag === 'button')
    .map((button) => button.behaviors[0].value.action);

  assert.deepEqual(actions, ['cancel']);
});

test('shows execution actions through Core owner fallback only when owner is the acceptor', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const actions = (state, ownerId, acceptorId) => renderer.render(task({
    state,
    ownerId,
    acceptorId,
    assigneeId: null,
  })).body.elements
    .filter((element) => element.tag === 'button')
    .map((button) => button.behaviors[0].value.action);

  assert.deepEqual(
    actions('ready', 'ou_same_person', 'ou_same_person'),
    ['start', 'cancel'],
  );
  assert.deepEqual(actions('ready', 'ou_owner', 'ou_acceptor'), ['cancel']);
  assert.deepEqual(
    actions('in_progress', 'ou_same_person', 'ou_same_person'),
    ['submit', 'cancel'],
  );
  assert.deepEqual(actions('in_progress', 'ou_owner', 'ou_acceptor'), ['cancel']);
});

test('fails closed for unknown states, extra fields, and malformed Core snapshots', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const valid = task();
  const invalidSnapshots = [
    undefined,
    null,
    [],
    { ...valid, state: 'blocked' },
    { ...valid, actorId: 'ou_untrusted_actor' },
    { ...valid, id: '' },
    { ...valid, id: 'x'.repeat(257) },
    { ...valid, title: 'x'.repeat(257) },
    { ...valid, description: '' },
    { ...valid, description: 'x'.repeat(4_001) },
    { ...valid, ownerId: '   ' },
    { ...valid, assigneeId: '' },
    { ...valid, version: 0 },
    { ...valid, version: 1.5 },
    { ...valid, createdAt: 'yesterday' },
  ];

  for (const snapshot of invalidSnapshots) {
    assert.throws(() => renderer.render(snapshot), TypeError);
  }
});

test('uses state-specific headers and plain-text fields for untrusted task content', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const hostileTitle = '<at id=all>everyone</at> **approve**';
  const hostileDescription = '[click](javascript:alert(1))\nsecond line';
  const expectedHeaders = {
    ready: '任务待开始',
    in_progress: '任务执行中',
    review: '任务待验收',
    done: '任务已完成',
    cancelled: '任务已取消',
  };

  for (const [state, expectedHeader] of Object.entries(expectedHeaders)) {
    const card = renderer.render(task({
      state,
      title: hostileTitle,
      description: hostileDescription,
    }));
    const serialized = JSON.stringify(card);

    assert.equal(card.header.title.content, expectedHeader);
    assert.equal(serialized.includes('lark_md'), false);
    assert.equal(serialized.includes(hostileTitle), true);
    assert.equal(
      card.body.elements.some((element) => element.text?.content.includes(hostileDescription)),
      true,
    );
    assert.equal(Buffer.byteLength(serialized, 'utf8') <= 30_000, true);
    for (const element of card.body.elements) {
      if (element.text) assert.equal(element.text.tag, 'plain_text');
      if (element.tag === 'button') assert.equal(element.text.tag, 'plain_text');
    }
  }
});

test('fails closed for invalid renderer configuration, clock results, and signer failures', () => {
  const validOptions = {
    issueTaskActionContext: () => 'v1.payload.signature',
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  };
  const invalidOptions = [
    undefined,
    null,
    {},
    { ...validOptions, issueTaskActionContext: null },
    { ...validOptions, clock: null },
    { ...validOptions, actionContextTtlMs: 0 },
    { ...validOptions, actionContextTtlMs: 1.5 },
    { ...validOptions, actionContextTtlMs: 24 * 60 * 60_000 + 1 },
    { ...validOptions, extra: true },
  ];

  for (const options of invalidOptions) {
    assert.throws(() => createTaskReviewCardRenderer(options), TypeError);
  }

  for (const invalidNow of [Number.NaN, -1, Number.MAX_SAFE_INTEGER]) {
    const renderer = createTaskReviewCardRenderer({
      ...validOptions,
      clock: () => invalidNow,
    });
    assert.throws(() => renderer.render(task()), TypeError);
  }

  const signerError = new Error('signer unavailable');
  const brokenSignerRenderer = createTaskReviewCardRenderer({
    ...validOptions,
    issueTaskActionContext() {
      throw signerError;
    },
  });
  assert.throws(() => brokenSignerRenderer.render(task()), signerError);

  for (const invalidToken of ['', '   ', null, 'x'.repeat(4_097)]) {
    const renderer = createTaskReviewCardRenderer({
      ...validOptions,
      issueTaskActionContext: () => invalidToken,
    });
    assert.throws(() => renderer.render(task()), TypeError);
  }
});

test('maps a signed card action to the existing Core route with the trusted callback actor', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: (claims) => contexts.issue(claims),
    clock: () => NOW,
    actionContextTtlMs: 10 * 60_000,
  });
  const card = renderer.render(task({
    state: 'ready',
    acceptorId: 'ou_trusted_callback_actor',
    assigneeId: 'ou_trusted_callback_actor',
  }));
  const startValue = card.body.elements
    .find((element) => (
      element.tag === 'button'
      && element.behaviors[0].value.action === 'start'
    ))
    .behaviors[0].value;

  const route = parseTaskReviewCardAction({
    eventId: 'card-action-event-1',
    actorId: 'ou_trusted_callback_actor',
    action: {
      tag: 'button',
      value: startValue,
    },
  }, {
    verifyTaskActionContext: (token) => contexts.verify(token),
  });

  assert.deepEqual(route, {
    kind: 'task-action',
    command: {
      type: 'StartTask',
      taskId: 'task-123',
      actorId: 'ou_trusted_callback_actor',
      idempotencyKey: 'feishu:card-action-event-1:task-command',
    },
    expectedVersion: 4,
  });
  assert.deepEqual(buildZylosTaskCommandArgs(route), [
    'task', 'start', 'task-123',
    '--actor', 'ou_trusted_callback_actor',
    '--expected-version', '4',
    '--idempotency-key', 'feishu:card-action-event-1:task-command',
    '--json',
  ]);
});

test('fails closed for malformed card callbacks, untrusted actor fields, and invalid contexts', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const context = contexts.issue({
    taskId: 'task-card-action',
    expectedVersion: 2,
    expiresAt: EXPIRES_AT,
  });
  const valid = {
    eventId: 'card-action-event-secure',
    actorId: 'ou_trusted_callback_actor',
    action: {
      tag: 'button',
      value: { action: 'accept', context },
    },
  };
  const invalidPayloads = [
    undefined,
    null,
    [],
    { ...valid, extra: true },
    { ...valid, eventId: '' },
    { ...valid, actorId: '   ' },
    { ...valid, action: { ...valid.action, extra: true } },
    { ...valid, action: { ...valid.action, tag: 'select_static' } },
    { ...valid, action: { ...valid.action, value: null } },
    {
      ...valid,
      action: {
        ...valid.action,
        value: { ...valid.action.value, actorId: 'ou_button_supplied_actor' },
      },
    },
    {
      ...valid,
      action: { ...valid.action, value: { ...valid.action.value, action: 'complete' } },
    },
    {
      ...valid,
      action: { ...valid.action, value: { ...valid.action.value, action: 'reopen' } },
    },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => parseTaskReviewCardAction(payload, {
        verifyTaskActionContext: (token) => contexts.verify(token),
      }),
      TypeError,
    );
  }

  assert.throws(() => parseTaskReviewCardAction(valid), TypeError);
  assert.throws(() => parseTaskReviewCardAction(valid, {
    verifyTaskActionContext: null,
  }), TypeError);
  assert.throws(() => parseTaskReviewCardAction(valid, {
    verifyTaskActionContext: () => ({
      taskId: 'task-card-action',
      expectedVersion: 2,
      expiresAt: EXPIRES_AT,
      actorId: 'ou_context_supplied_actor',
    }),
  }), TypeError);

  const tampered = `${context.slice(0, -1)}${context.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => parseTaskReviewCardAction({
    ...valid,
    action: {
      ...valid.action,
      value: { ...valid.action.value, context: tampered },
    },
  }, {
    verifyTaskActionContext: (token) => contexts.verify(token),
  }));
});
