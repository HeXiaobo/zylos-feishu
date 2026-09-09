import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROGRESS_COMMENT_HEADER,
  TASK_PROGRESS_PROJECTION,
  createTaskProgressProjector,
  createTaskProgressTargetResolver,
  initializeTaskProgressProjection,
  renderTaskProgressComment,
} from '../src/lib/task-progress-projection.js';
import { openTaskCommentStore } from '../src/lib/task-comment-store.js';
import { createSdkTaskV2CommentApi } from '../src/lib/task-v2-comment-api.js';

const APP_ID = 'cli_task_gateway';
const TASK_ID = 'task-core-1';
const TASK_GUID = 'task-guid-1';

function progressEvent(overrides = {}) {
  return {
    id: 'evt-progress-1',
    type: 'TaskProgressReported',
    taskId: TASK_ID,
    actorId: 'ou_owner',
    fromState: 'in_progress',
    toState: 'in_progress',
    version: 7,
    occurredAt: '2026-09-09T01:02:03.000Z',
    payload: { message: '已完成为期三天的联调，剩余回归测试。' },
    ...overrides,
  };
}

function delivery(event, overrides = {}) {
  return {
    projection: TASK_PROGRESS_PROJECTION,
    eventId: event.id,
    status: 'leased',
    attempt: 1,
    totalAttempts: 1,
    version: 3,
    workerId: 'worker-a',
    leaseExpiresAt: '2026-09-09T01:02:33.000Z',
    event,
    ...overrides,
  };
}

function linkedCore({ links = [{ taskId: TASK_ID, backend: 'feishu-task-v2', externalId: TASK_GUID }] } = {}) {
  return {
    externalLinks: {
      query({ taskId, backend }) {
        return links.filter(
          (link) => (taskId === undefined || link.taskId === taskId)
            && (backend === undefined || link.backend === backend),
        );
      },
    },
  };
}

function fakeOutbox(deliveries) {
  const calls = { claim: [], ack: [], fail: [] };
  const state = { queue: [...deliveries] };
  return {
    calls,
    get queue() {
      return state.queue;
    },
    set queue(value) {
      state.queue = [...value];
    },
    claim(request) {
      calls.claim.push(request);
      const batch = state.queue;
      state.queue = [];
      return batch;
    },
    ack(request, expectedVersion) {
      calls.ack.push({ request, expectedVersion });
      return { ...request, status: 'acknowledged' };
    },
    fail(request, expectedVersion) {
      calls.fail.push({ request, expectedVersion });
      return {
        ...request,
        status: request.retryAfterMs === undefined ? 'dead_letter' : 'retry_wait',
      };
    },
  };
}

function fakeCommentApi() {
  const created = [];
  return {
    created,
    async createComment({ taskGuid, content }) {
      created.push({ taskGuid, content });
      return {
        id: `comment-${created.length}`,
        content,
        creator: { id: APP_ID, type: 'app' },
        replyToCommentId: null,
        createdAt: '2026-09-09T01:02:04.000Z',
        updatedAt: '2026-09-09T01:02:04.000Z',
        resourceType: 'task',
        resourceId: taskGuid,
      };
    },
  };
}

function createProjectorHarness({
  event = progressEvent(),
  links,
  core = linkedCore({ links }),
  commentApi = fakeCommentApi(),
  store = openTaskCommentStore({ dbPath: ':memory:' }),
} = {}) {
  const outbox = fakeOutbox(event === null ? [] : [delivery(event)]);
  const projectionCore = { ...core, outbox };
  const projector = createTaskProgressProjector({
    appId: APP_ID,
    core: projectionCore,
    store,
    commentApi,
    workerId: 'worker-progress-1',
  });
  return {
    projector,
    store,
    outbox,
    commentApi,
    cleanup() {
      store.close();
    },
  };
}

test('progress comments carry a Zylos header and never truncate the message', () => {
  const message = '完成了联调，进入回归。';
  assert.equal(renderTaskProgressComment(message), `${PROGRESS_COMMENT_HEADER}\n${message}`);

  const longMessage = '进'.repeat(20_000);
  assert.equal(renderTaskProgressComment(longMessage), longMessage);
  assert.throws(() => renderTaskProgressComment(' '.repeat(20_001)), TypeError);
  assert.throws(() => renderTaskProgressComment('   '), TypeError);
});

test('TaskProgressReported is projected once as a top-level task comment and acked', async () => {
  const harness = createProjectorHarness();
  try {
    const summary = await harness.projector.processOnce({ limit: 10 });

    assert.deepEqual(harness.commentApi.created, [{
      taskGuid: TASK_GUID,
      content: `${PROGRESS_COMMENT_HEADER}\n已完成为期三天的联调，剩余回归测试。`,
    }]);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.commented, 1);
    assert.equal(summary.alreadySent, 0);
    assert.equal(summary.notApplicable, 0);
    assert.equal(summary.retryWaiting, 0);
    assert.equal(summary.deadLettered, 0);

    const outbound = harness.store.queryOutbound({
      appId: APP_ID,
      idempotencyKey: 'task-progress:evt-progress-1',
    });
    assert.equal(outbound.status, 'sent');
    assert.equal(outbound.taskGuid, TASK_GUID);
    assert.equal(outbound.replyToCommentId, null);
    assert.equal(outbound.commentId, 'comment-1');

    assert.equal(harness.outbox.calls.claim.length, 1);
    assert.equal(harness.outbox.calls.claim[0].projection, TASK_PROGRESS_PROJECTION);
    assert.equal(harness.outbox.calls.ack.length, 1);
    assert.equal(harness.outbox.calls.ack[0].request.projection, TASK_PROGRESS_PROJECTION);
    assert.equal(harness.outbox.calls.ack[0].request.eventId, 'evt-progress-1');
    assert.match(harness.outbox.calls.ack[0].request.idempotencyKey, /^task-progress-projection:/);
    assert.equal(harness.outbox.calls.ack[0].expectedVersion, 3);
    assert.deepEqual(harness.outbox.calls.fail, []);
  } finally {
    harness.cleanup();
  }
});

test('redelivered progress events reuse the outbound ledger and post no second comment', async () => {
  const harness = createProjectorHarness();
  try {
    const first = await harness.projector.processOnce();
    assert.equal(first.commented, 1);

    // Simulate Core redelivering the same event (claim/ack race or replay).
    harness.outbox.calls.claim.length = 0;
    harness.outbox.calls.ack.length = 0;
    harness.outbox.queue = [delivery(progressEvent())];
    const second = await harness.projector.processOnce();

    assert.equal(harness.commentApi.created.length, 1);
    assert.equal(second.commented, 0);
    assert.equal(second.alreadySent, 1);
    assert.equal(harness.outbox.calls.ack.length, 1);
    assert.equal(harness.outbox.calls.ack[0].request.eventId, 'evt-progress-1');
  } finally {
    harness.cleanup();
  }
});

test('non-progress outbox events are acknowledged without any comment write', async () => {
  const harness = createProjectorHarness({
    event: progressEvent({
      id: 'evt-created-1',
      type: 'TaskCreated',
      fromState: null,
      toState: 'ready',
      payload: undefined,
    }),
  });
  try {
    const summary = await harness.projector.processOnce();
    assert.equal(summary.notApplicable, 1);
    assert.equal(summary.commented, 0);
    assert.deepEqual(harness.commentApi.created, []);
    assert.equal(harness.outbox.calls.ack.length, 1);
    assert.deepEqual(harness.outbox.calls.fail, []);
  } finally {
    harness.cleanup();
  }
});

test('a Core task without a Task v2 link fails retryably and posts nothing', async () => {
  const harness = createProjectorHarness({ links: [] });
  try {
    const summary = await harness.projector.processOnce();
    assert.equal(summary.retryWaiting, 1);
    assert.equal(summary.commented, 0);
    assert.deepEqual(harness.commentApi.created, []);
    assert.equal(harness.outbox.calls.fail.length, 1);
    assert.equal(harness.outbox.calls.fail[0].request.retryAfterMs, 5_000);
    assert.match(harness.outbox.calls.fail[0].request.error, /no Feishu Task v2 link/);
  } finally {
    harness.cleanup();
  }
});

test('ambiguous links and malformed payloads fail permanently without retry', async () => {
  const ambiguous = createProjectorHarness({
    links: [
      { taskId: TASK_ID, backend: 'feishu-task-v2', externalId: 'guid-a' },
      { taskId: TASK_ID, backend: 'feishu-task-v2', externalId: 'guid-b' },
    ],
  });
  const malformed = createProjectorHarness({
    event: progressEvent({ payload: {} }),
  });
  try {
    const ambiguousSummary = await ambiguous.projector.processOnce();
    assert.equal(ambiguousSummary.deadLettered, 1);
    assert.equal(ambiguous.outbox.calls.fail[0].request.retryAfterMs, undefined);
    assert.equal(ambiguous.commentApi.created.length, 0);

    const malformedSummary = await malformed.projector.processOnce();
    assert.equal(malformedSummary.deadLettered, 1);
    assert.equal(malformed.outbox.calls.fail[0].request.retryAfterMs, undefined);
    assert.match(malformed.outbox.calls.fail[0].request.error, /payload\.message/);
  } finally {
    ambiguous.cleanup();
    malformed.cleanup();
  }
});

test('comment create failures dead-letter the ledger row and block blind retries', async () => {
  const store = openTaskCommentStore({ dbPath: ':memory:' });
  const commentApi = fakeCommentApi();
  commentApi.createComment = async () => {
    throw new Error('Feishu Task v2 comment create failed');
  };
  const outbox = fakeOutbox([delivery(progressEvent()), delivery(progressEvent({ id: 'evt-progress-2' }))]);
  const projector = createTaskProgressProjector({
    appId: APP_ID,
    core: { ...linkedCore(), outbox },
    store,
    commentApi,
    workerId: 'worker-progress-1',
  });
  try {
    const summary = await projector.processOnce({ limit: 2 });

    assert.equal(commentApi.created.length, 0);
    assert.equal(summary.commented, 0);
    assert.equal(outbox.calls.fail.length, 2);
    assert.equal(outbox.calls.fail[0].request.retryAfterMs, 5_000);

    const outbound = store.queryOutbound({
      appId: APP_ID,
      idempotencyKey: 'task-progress:evt-progress-1',
    });
    assert.equal(outbound.status, 'dead_letter');
  } finally {
    store.close();
  }
});

test('a confirmed SDK rejection retries successfully and then deduplicates replay', async () => {
  let requests = 0;
  const commentApi = createSdkTaskV2CommentApi({ client: { task: { v2: { comment: {
    async get() {},
    async list() {},
    async create({ data }) {
      requests += 1;
      if (requests === 1) return { code: 99991400, msg: 'rate limited' };
      return { code: 0, data: { comment: {
        id: 'comment-recovered', content: data.content,
        creator: { id: APP_ID, type: 'app' }, created_at: '1788915724000',
      } } };
    },
  } } } } });
  const harness = createProjectorHarness({ commentApi });
  try {
    assert.equal((await harness.projector.processOnce()).retryWaiting, 1);
    harness.outbox.queue = [delivery(progressEvent(), { version: 5 })];
    assert.equal((await harness.projector.processOnce()).commented, 1);
    harness.outbox.queue = [delivery(progressEvent(), { version: 7 })];
    assert.equal((await harness.projector.processOnce()).alreadySent, 1);
    assert.equal(requests, 2);
    const row = harness.store.queryOutbound({ appId: APP_ID, idempotencyKey: 'task-progress:evt-progress-1' });
    assert.equal(row.status, 'sent');
    assert.equal(row.attempt, 2);
  } finally {
    harness.cleanup();
  }
});

for (const failure of ['timeout', 'malformed response', 'malformed success']) {
  test(`${failure} keeps SDK delivery uncertain and blocks automatic resend`, async () => {
    let requests = 0;
    const commentApi = createSdkTaskV2CommentApi({ client: { task: { v2: { comment: {
      async get() {},
      async list() {},
      async create() {
        requests += 1;
        if (failure === 'timeout') throw new Error('timeout after possible send');
        return failure === 'malformed response' ? {} : { code: 0, data: {} };
      },
    } } } } });
    const harness = createProjectorHarness({ commentApi });
    try {
      await harness.projector.processOnce();
      harness.outbox.queue = [delivery(progressEvent(), { version: 5 })];
      await harness.projector.processOnce();
      assert.equal(requests, 1);
      assert.match(harness.outbox.calls.fail.at(-1).request.error, /uncertain/);
    } finally {
      harness.cleanup();
    }
  });
}

test('the target resolver distinguishes missing links from ambiguous ones', () => {
  const resolver = createTaskProgressTargetResolver({ core: linkedCore() });
  assert.equal(resolver.resolve({ taskId: TASK_ID }), TASK_GUID);

  const missing = createTaskProgressTargetResolver({ core: linkedCore({ links: [] }) });
  assert.throws(() => missing.resolve({ taskId: TASK_ID }), (error) => {
    assert.equal(error.code, 'TASK_PROGRESS_TARGET_UNLINKED');
    return true;
  });

  const ambiguous = createTaskProgressTargetResolver({
    core: linkedCore({
      links: [
        { taskId: TASK_ID, backend: 'feishu-task-v2', externalId: 'guid-a' },
        { taskId: TASK_ID, backend: 'feishu-task-v2', externalId: 'guid-b' },
      ],
    }),
  });
  assert.throws(() => ambiguous.resolve({ taskId: TASK_ID }), /multiple Task v2 links/);
});

test('projection registration validates the bootstrap policy and registers once', () => {
  const registrations = [];
  const core = {
    outbox: {
      register(request) {
        registrations.push(request);
        return { created: true, registration: request };
      },
    },
    close() {},
  };
  let opened = 0;
  const result = initializeTaskProgressProjection({
    bootstrapPolicy: 'from_now',
    openCore() {
      opened += 1;
      return core;
    },
  });
  assert.equal(result.created, true);
  assert.equal(opened, 1);
  assert.deepEqual(registrations, [{
    projection: TASK_PROGRESS_PROJECTION,
    bootstrapPolicy: 'from_now',
    actorId: 'commitment-feishu-task-progress-projection',
    idempotencyKey: `${TASK_PROGRESS_PROJECTION}:register:from_now:v1`,
  }]);

  assert.throws(() => initializeTaskProgressProjection({
    bootstrapPolicy: 'whenever',
    openCore() { return core; },
  }), TypeError);
});
