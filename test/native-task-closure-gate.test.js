import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import Database from 'better-sqlite3';

import { evaluateNativeTaskClosure } from '../src/lib/native-task-closure-gate.js';

const APP_ID = 'cli_task_gateway';

function createFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-gate-'));
  const coreDbPath = path.join(directory, 'commitments.db');
  const taskCommentsDbPath = path.join(directory, 'task-comments.db');
  const core = new Database(coreDbPath);
  core.exec(`
    CREATE TABLE commitment_tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE commitment_external_links (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      backend TEXT NOT NULL,
      external_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  core.prepare('INSERT INTO commitment_tasks (id, title) VALUES (?, ?)')
    .run('core-task-1', 'Unique closure canary');
  core.prepare(`
    INSERT INTO commitment_external_links (
      id, task_id, actor_id, backend, external_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'link-1',
    'core-task-1',
    'ou_owner',
    'feishu-task-v2',
    'task-guid-1',
    '2026-08-26T09:59:00.000Z',
  );
  core.close();

  const comments = new Database(taskCommentsDbPath);
  comments.exec(`
    CREATE TABLE feishu_task_comment_inbox (
      app_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      task_guid TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE TABLE feishu_task_comment_outbound (
      app_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      task_guid TEXT NOT NULL,
      reply_to_comment_id TEXT,
      status TEXT NOT NULL,
      comment_id TEXT
    );
    CREATE TABLE feishu_task_notifications (
      dedupe_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  comments.prepare(`
    INSERT INTO feishu_task_comment_inbox (
      app_id, event_id, task_guid, comment_id, occurred_at, source, status, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    APP_ID,
    'feishu-comment-event-1',
    'task-guid-1',
    'comment-human-1',
    '2026-08-26T10:00:00.000Z',
    'event',
    'processed',
    '2026-08-26T10:00:02.000Z',
  );
  comments.prepare(`
    INSERT INTO feishu_task_comment_outbound (
      app_id, idempotency_key, task_guid, reply_to_comment_id, status, comment_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    APP_ID,
    'agent-reply-1',
    'task-guid-1',
    'comment-human-1',
    'sent',
    'comment-agent-1',
  );
  comments.prepare(`
    INSERT INTO feishu_task_notifications (
      dedupe_key, event_id, task_id, recipient_id, status, sent_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'notification-1',
    'core-comment-event-1',
    'core-task-1',
    'ou_owner',
    'sent',
    '2026-08-26T10:00:04.000Z',
    '2026-08-26T10:00:03.000Z',
  );
  comments.close();

  return {
    coreDbPath,
    taskCommentsDbPath,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createRemoteReader() {
  return {
    async getTask() {
      return {
        kind: 'found',
        task: {
          guid: 'task-guid-1',
          summary: 'Unique closure canary',
          coreTaskId: 'core-task-1',
        },
      };
    },
    async findTasksBySummary() {
      return [{ guid: 'task-guid-1', summary: 'Unique closure canary' }];
    },
    async getComment({ commentId }) {
      const comment = commentId === 'comment-human-1'
        ? {
            id: 'comment-human-1',
            resourceType: 'task',
            resourceId: 'task-guid-1',
            replyToCommentId: null,
          }
        : {
            id: 'comment-agent-1',
            resourceType: 'task',
            resourceId: 'task-guid-1',
            replyToCommentId: 'comment-human-1',
          };
      return { kind: 'found', comment };
    },
  };
}

function evaluateFixture(fixture, overrides = {}) {
  return evaluateNativeTaskClosure({
    coreDbPath: fixture.coreDbPath,
    taskCommentsDbPath: fixture.taskCommentsDbPath,
    appId: APP_ID,
    cases: [{
      taskGuid: 'task-guid-1',
      commentId: 'comment-human-1',
      notification: {
        eventId: 'core-comment-event-1',
        recipientIds: ['ou_owner'],
      },
    }],
    remoteReader: createRemoteReader(),
    clock: () => '2026-08-26T10:00:05.000Z',
    maxInboundLatencyMs: 5_000,
    ...overrides,
  });
}

function addSecondClosure(fixture) {
  const core = new Database(fixture.coreDbPath);
  core.prepare('INSERT INTO commitment_tasks (id, title) VALUES (?, ?)')
    .run('core-task-2', 'Second closure canary');
  core.prepare(`
    INSERT INTO commitment_external_links (
      id, task_id, actor_id, backend, external_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'link-2',
    'core-task-2',
    'ou_owner',
    'feishu-task-v2',
    'task-guid-2',
    '2026-08-26T09:59:01.000Z',
  );
  core.close();

  const comments = new Database(fixture.taskCommentsDbPath);
  comments.prepare(`
    INSERT INTO feishu_task_comment_inbox (
      app_id, event_id, task_guid, comment_id, occurred_at, source, status, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    APP_ID,
    'feishu-comment-event-2',
    'task-guid-2',
    'comment-human-2',
    '2026-08-26T10:00:00.000Z',
    'event',
    'processed',
    '2026-08-26T10:00:02.000Z',
  );
  comments.prepare(`
    INSERT INTO feishu_task_comment_outbound (
      app_id, idempotency_key, task_guid, reply_to_comment_id, status, comment_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    APP_ID,
    'agent-reply-2',
    'task-guid-2',
    'comment-human-2',
    'sent',
    'comment-agent-2',
  );
  comments.prepare(`
    INSERT INTO feishu_task_notifications (
      dedupe_key, event_id, task_id, recipient_id, status, sent_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'notification-2',
    'core-comment-event-2',
    'core-task-2',
    'ou_owner',
    'sent',
    '2026-08-26T10:00:04.000Z',
    '2026-08-26T10:00:03.000Z',
  );
  comments.close();
}

test('a uniquely managed Task comment proves the complete native closure through the public gate', async () => {
  const fixture = createFixture();
  try {
    const report = await evaluateFixture(fixture);

    assert.equal(report.schema, 'zylos.native-task-closure-gate/v1');
    assert.equal(report.passed, true);
    assert.deepEqual(report.failureCodes, []);
    assert.deepEqual(report.totals, { cases: 1, passed: 1, failed: 0 });
    assert.equal(report.cases[0].coreTaskId, 'core-task-1');
    assert.equal(report.cases[0].inbound.latencyMs, 2_000);
    assert.equal(report.cases[0].outbound.commentId, 'comment-agent-1');
    assert.deepEqual(report.cases[0].notifications.recipients, ['ou_owner']);
    assert.deepEqual(report.cases[0].notifications.receipts, [{
      dedupeKey: 'notification-1',
      recipientId: 'ou_owner',
      status: 'sent',
      sentAt: '2026-08-26T10:00:04.000Z',
    }]);
  } finally {
    fixture.cleanup();
  }
});

test('an unlinked Task GUID fails closed with a stable machine-readable code', async () => {
  const fixture = createFixture();
  try {
    const core = new Database(fixture.coreDbPath);
    core.prepare('DELETE FROM commitment_external_links WHERE external_id = ?')
      .run('task-guid-1');
    core.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['CORE_LINK_MISSING']);
    assert.deepEqual(report.totals, { cases: 1, passed: 0, failed: 1 });
    assert.deepEqual(report.cases[0].failures.map(({ code }) => code), [
      'CORE_LINK_MISSING',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('duplicate Core ownership of one Task GUID is rejected instead of choosing a row', async () => {
  const fixture = createFixture();
  try {
    const core = new Database(fixture.coreDbPath);
    core.prepare('INSERT INTO commitment_tasks (id, title) VALUES (?, ?)')
      .run('core-task-2', 'Unique closure canary');
    core.prepare(`
      INSERT INTO commitment_external_links (
        id, task_id, actor_id, backend, external_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'link-2',
      'core-task-2',
      'ou_owner',
      'feishu-task-v2',
      'task-guid-1',
      '2026-08-26T09:59:01.000Z',
    );
    core.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['CORE_LINK_NOT_UNIQUE']);
    assert.equal(report.cases[0].failures[0].details.matches, 2);
  } finally {
    fixture.cleanup();
  }
});

test('one Core Task cannot own a second Task v2 GUID behind the requested link', async () => {
  const fixture = createFixture();
  try {
    const core = new Database(fixture.coreDbPath);
    core.prepare(`
      INSERT INTO commitment_external_links (
        id, task_id, actor_id, backend, external_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'link-shadow',
      'core-task-1',
      'ou_owner',
      'feishu-task-v2',
      'task-guid-shadow',
      '2026-08-26T09:59:01.000Z',
    );
    core.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['CORE_TASK_LINK_NOT_UNIQUE']);
    assert.deepEqual(report.cases[0].failures[0].details.observedTaskGuids, [
      'task-guid-1',
      'task-guid-shadow',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a comment ledger row from another Task GUID cannot satisfy the requested case', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare(`
      UPDATE feishu_task_comment_inbox SET task_guid = ? WHERE comment_id = ?
    `).run('task-guid-other', 'comment-human-1');
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['COMMENT_TASK_MISMATCH']);
    assert.deepEqual(report.cases[0].failures[0].details.observedTaskGuids, [
      'task-guid-other',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a comment absent from the inbound ledger has a distinct missing code', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare('DELETE FROM feishu_task_comment_inbox').run();
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['INBOUND_COMMENT_MISSING']);
  } finally {
    fixture.cleanup();
  }
});

test('a reconciliation-only intake cannot prove the realtime comment path', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare(`
      UPDATE feishu_task_comment_inbox SET source = ? WHERE comment_id = ?
    `).run('reconciliation', 'comment-human-1');
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['INBOUND_SOURCE_NOT_REALTIME']);
    assert.equal(report.cases[0].failures[0].details.observedSource, 'reconciliation');
  } finally {
    fixture.cleanup();
  }
});

test('an unprocessed realtime intake fails with its durable ledger status', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare(`
      UPDATE feishu_task_comment_inbox SET status = ? WHERE comment_id = ?
    `).run('dead_letter', 'comment-human-1');
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['INBOUND_NOT_PROCESSED']);
    assert.equal(report.cases[0].failures[0].details.observedStatus, 'dead_letter');
  } finally {
    fixture.cleanup();
  }
});

test('realtime intake latency above the configured SLO fails closed', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare(`
      UPDATE feishu_task_comment_inbox SET received_at = ? WHERE comment_id = ?
    `).run('2026-08-26T10:00:10.000Z', 'comment-human-1');
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['INBOUND_LATENCY_EXCEEDED']);
    assert.deepEqual(report.cases[0].failures[0].details, {
      latencyMs: 10_000,
      maxInboundLatencyMs: 5_000,
    });
  } finally {
    fixture.cleanup();
  }
});

test('invalid or negative ledger timestamps cannot pass the intake latency check', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare(`
      UPDATE feishu_task_comment_inbox SET received_at = ? WHERE comment_id = ?
    `).run('not-an-instant', 'comment-human-1');
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['INBOUND_LATENCY_INVALID']);
  } finally {
    fixture.cleanup();
  }
});

test('a processed inbound comment without an exact sent Agent reply fails closed', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare('DELETE FROM feishu_task_comment_outbound').run();
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['OUTBOUND_REPLY_MISSING']);
  } finally {
    fixture.cleanup();
  }
});

test('an exact reply without a sent receipt reports its outbound ledger status', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare('UPDATE feishu_task_comment_outbound SET status = ?')
      .run('dead_letter');
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['OUTBOUND_REPLY_NOT_SENT']);
    assert.deepEqual(report.cases[0].failures[0].details.statuses, ['dead_letter']);
  } finally {
    fixture.cleanup();
  }
});

test('multiple sent replies to one inbound comment fail as a duplicate closure', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare(`
      INSERT INTO feishu_task_comment_outbound (
        app_id, idempotency_key, task_guid, reply_to_comment_id, status, comment_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      APP_ID,
      'agent-reply-duplicate',
      'task-guid-1',
      'comment-human-1',
      'sent',
      'comment-agent-duplicate',
    );
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['OUTBOUND_REPLY_NOT_UNIQUE']);
    assert.equal(report.cases[0].failures[0].details.sentReplies, 2);
  } finally {
    fixture.cleanup();
  }
});

test('every expected human recipient must have an exact sent notification receipt', async () => {
  const fixture = createFixture();
  try {
    const comments = new Database(fixture.taskCommentsDbPath);
    comments.prepare('DELETE FROM feishu_task_notifications').run();
    comments.close();

    const report = await evaluateFixture(fixture);

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['NOTIFICATION_RECEIPT_MISSING']);
    assert.deepEqual(report.cases[0].failures[0].details.missingRecipientIds, [
      'ou_owner',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a deleted remote Task fails closed even when every local ledger looks green', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.getTask = async () => ({ kind: 'missing' });

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_MISSING']);
  } finally {
    fixture.cleanup();
  }
});

test('an unreadable remote Task becomes a fail-closed read error', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.getTask = async () => {
      throw new Error('Feishu permission denied');
    };

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_READ_ERROR']);
    assert.equal(report.cases[0].failures[0].details.error, 'Feishu permission denied');
  } finally {
    fixture.cleanup();
  }
});

test('an explicit remote unreadable result fails closed without throwing', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.getTask = async () => ({ kind: 'forbidden' });

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_UNREADABLE']);
    assert.equal(report.cases[0].failures[0].details.kind, 'forbidden');
  } finally {
    fixture.cleanup();
  }
});

test('the remote Task marker must identify the linked Core Task', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.getTask = async () => ({
      kind: 'found',
      task: {
        guid: 'task-guid-1',
        summary: 'Unique closure canary',
        coreTaskId: 'core-task-other',
      },
    });

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_CORE_MISMATCH']);
    assert.equal(report.cases[0].failures[0].details.observedCoreTaskId, 'core-task-other');
  } finally {
    fixture.cleanup();
  }
});

test('a same-name remote Task with a different GUID cannot satisfy the case', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.getTask = async () => ({
      kind: 'found',
      task: {
        guid: 'task-guid-lookalike',
        summary: 'Unique closure canary',
        coreTaskId: 'core-task-1',
      },
    });

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_GUID_MISMATCH']);
    assert.deepEqual(report.cases[0].failures[0].details, {
      expectedTaskGuid: 'task-guid-1',
      observedTaskGuid: 'task-guid-lookalike',
    });
  } finally {
    fixture.cleanup();
  }
});

test('a second remote Task with the same title blocks an ambiguous acceptance test', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.findTasksBySummary = async () => [
      { guid: 'task-guid-1', summary: 'Unique closure canary' },
      { guid: 'task-guid-lookalike', summary: 'Unique closure canary' },
    ];

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_TITLE_COLLISION']);
    assert.deepEqual(report.cases[0].failures[0].details.observedTaskGuids, [
      'task-guid-1',
      'task-guid-lookalike',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('a remote inbound comment from another Task GUID fails closed', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    const originalGetComment = remoteReader.getComment;
    remoteReader.getComment = async (request) => {
      const result = await originalGetComment(request);
      if (request.commentId !== 'comment-human-1') return result;
      return {
        kind: 'found',
        comment: { ...result.comment, resourceId: 'task-guid-other' },
      };
    };

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_COMMENT_TASK_MISMATCH']);
    assert.equal(report.cases[0].failures[0].details.observedTaskGuid, 'task-guid-other');
  } finally {
    fixture.cleanup();
  }
});

test('the remote Agent reply must point to the exact inbound comment', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    const originalGetComment = remoteReader.getComment;
    remoteReader.getComment = async (request) => {
      const result = await originalGetComment(request);
      if (request.commentId !== 'comment-agent-1') return result;
      return {
        kind: 'found',
        comment: { ...result.comment, replyToCommentId: 'comment-human-other' },
      };
    };

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['REMOTE_REPLY_PARENT_MISMATCH']);
    assert.equal(
      report.cases[0].failures[0].details.observedReplyToCommentId,
      'comment-human-other',
    );
  } finally {
    fixture.cleanup();
  }
});

test('one remote Adapter failure does not prevent a second closure case from being evaluated', async () => {
  const fixture = createFixture();
  try {
    addSecondClosure(fixture);
    const tasks = {
      'task-guid-1': {
        guid: 'task-guid-1', summary: 'Unique closure canary', coreTaskId: 'core-task-1',
      },
      'task-guid-2': {
        guid: 'task-guid-2', summary: 'Second closure canary', coreTaskId: 'core-task-2',
      },
    };
    const comments = {
      'comment-human-1': {
        id: 'comment-human-1', resourceType: 'task', resourceId: 'task-guid-1',
        replyToCommentId: null,
      },
      'comment-agent-1': {
        id: 'comment-agent-1', resourceType: 'task', resourceId: 'task-guid-1',
        replyToCommentId: 'comment-human-1',
      },
      'comment-human-2': {
        id: 'comment-human-2', resourceType: 'task', resourceId: 'task-guid-2',
        replyToCommentId: null,
      },
      'comment-agent-2': {
        id: 'comment-agent-2', resourceType: 'task', resourceId: 'task-guid-2',
        replyToCommentId: 'comment-human-2',
      },
    };
    const report = await evaluateNativeTaskClosure({
      coreDbPath: fixture.coreDbPath,
      taskCommentsDbPath: fixture.taskCommentsDbPath,
      appId: APP_ID,
      cases: [
        {
          taskGuid: 'task-guid-1',
          commentId: 'comment-human-1',
          notification: { eventId: 'core-comment-event-1', recipientIds: ['ou_owner'] },
        },
        {
          taskGuid: 'task-guid-2',
          commentId: 'comment-human-2',
          notification: { eventId: 'core-comment-event-2', recipientIds: ['ou_owner'] },
        },
      ],
      remoteReader: {
        async getTask({ taskGuid }) {
          return { kind: 'found', task: tasks[taskGuid] };
        },
        async findTasksBySummary({ summary }) {
          if (summary === 'Unique closure canary') throw new Error('Task list unavailable');
          return Object.values(tasks).filter(task => task.summary === summary);
        },
        async getComment({ commentId }) {
          return { kind: 'found', comment: comments[commentId] };
        },
      },
      clock: () => '2026-08-26T10:00:05.000Z',
    });

    assert.equal(report.passed, false);
    assert.deepEqual(report.totals, { cases: 2, passed: 1, failed: 1 });
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_SEARCH_ERROR']);
    assert.deepEqual(report.cases.map(item => item.passed), [false, true]);
  } finally {
    fixture.cleanup();
  }
});

test('an unexpected per-case read failure is contained in a machine-readable result', async () => {
  const fixture = createFixture();
  try {
    const remoteReader = createRemoteReader();
    remoteReader.getTask = async () => new Proxy({ kind: 'found' }, {
      get(target, property) {
        if (property === 'task') throw new Error('malformed Adapter task payload');
        return target[property];
      },
    });

    const report = await evaluateFixture(fixture, { remoteReader });

    assert.equal(report.passed, false);
    assert.deepEqual(report.failureCodes, ['GATE_CASE_READ_ERROR']);
    assert.equal(report.cases[0].failures[0].details.error, 'malformed Adapter task payload');
  } finally {
    fixture.cleanup();
  }
});

test('CLI prints the gate report as JSON and exposes pass or fail through its exit code', () => {
  const fixture = createFixture();
  try {
    const directory = path.dirname(fixture.coreDbPath);
    const inputPath = path.join(directory, 'gate-input.json');
    const remoteFixturePath = path.join(directory, 'remote-fixture.json');
    writeFileSync(inputPath, JSON.stringify({
      coreDbPath: fixture.coreDbPath,
      taskCommentsDbPath: fixture.taskCommentsDbPath,
      appId: APP_ID,
      maxInboundLatencyMs: 5_000,
      cases: [{
        taskGuid: 'task-guid-1',
        commentId: 'comment-human-1',
        notification: {
          eventId: 'core-comment-event-1',
          recipientIds: ['ou_owner'],
        },
      }],
    }));
    writeFileSync(remoteFixturePath, JSON.stringify({
      tasks: [{
        guid: 'task-guid-1',
        summary: 'Unique closure canary',
        coreTaskId: 'core-task-1',
      }],
      comments: [
        {
          id: 'comment-human-1',
          resourceType: 'task',
          resourceId: 'task-guid-1',
          replyToCommentId: null,
        },
        {
          id: 'comment-agent-1',
          resourceType: 'task',
          resourceId: 'task-guid-1',
          replyToCommentId: 'comment-human-1',
        },
      ],
    }));

    const command = spawnSync(process.execPath, [
      path.resolve('scripts/native-task-closure-gate.js'),
      '--input',
      inputPath,
      '--remote-fixture',
      remoteFixturePath,
    ], { cwd: path.resolve('.'), encoding: 'utf8' });

    assert.equal(command.status, 0, command.stderr);
    assert.equal(command.stderr, '');
    const report = JSON.parse(command.stdout);
    assert.equal(report.schema, 'zylos.native-task-closure-gate/v1');
    assert.equal(report.passed, true);
  } finally {
    fixture.cleanup();
  }
});
