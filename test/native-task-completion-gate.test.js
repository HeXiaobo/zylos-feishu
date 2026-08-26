import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import Database from 'better-sqlite3';

import { evaluateNativeTaskCompletionClosure } from '../src/lib/native-task-completion-gate.js';
import { createSdkNativeTaskGateReader } from '../src/lib/native-task-closure-gate-remote.js';

const APP_ID = 'cli_task_gateway';

function createFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-completion-gate-'));
  const coreDbPath = path.join(directory, 'commitments.db');
  const statusInboxDbPath = path.join(directory, 'status-inbox.db');
  const core = new Database(coreDbPath);
  core.exec(`
    CREATE TABLE commitment_tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE commitment_external_links (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, backend TEXT NOT NULL, external_id TEXT NOT NULL
    );
    CREATE TABLE commitment_commands (
      idempotency_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, result_json TEXT NOT NULL
    );
    CREATE TABLE commitment_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, task_id TEXT NOT NULL
    );
  `);
  core.prepare('INSERT INTO commitment_tasks VALUES (?, ?, ?, ?)')
    .run('core-task-1', 'Completion closure canary', 'review', 3);
  core.prepare('INSERT INTO commitment_external_links VALUES (?, ?, ?, ?)')
    .run('link-1', 'core-task-1', 'feishu-task-v2', 'task-guid-1');
  core.prepare('INSERT INTO commitment_commands VALUES (?, ?, ?)').run(
    'feishu-task-v2:status-event-1:start',
    'core-task-1',
    JSON.stringify({ event: { type: 'TaskStarted' }, task: { state: 'in_progress' } }),
  );
  core.prepare('INSERT INTO commitment_commands VALUES (?, ?, ?)').run(
    'feishu-task-v2:status-event-1:task-command',
    'core-task-1',
    JSON.stringify({ event: { type: 'TaskSubmittedForReview' }, task: { state: 'review' } }),
  );
  core.prepare('INSERT INTO commitment_events VALUES (?, ?, ?)')
    .run('core-start-event', 'TaskStarted', 'core-task-1');
  core.prepare('INSERT INTO commitment_events VALUES (?, ?, ?)')
    .run('core-submit-event', 'TaskSubmittedForReview', 'core-task-1');
  core.close();

  const status = new Database(statusInboxDbPath);
  status.exec(`
    CREATE TABLE task_v2_status_events (
      event_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      event_types_json TEXT,
      status TEXT NOT NULL,
      result_json TEXT,
      settled_at INTEGER
    );
  `);
  status.prepare('INSERT INTO task_v2_status_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'status-event-1',
    'task-guid-1',
    APP_ID,
    JSON.stringify(['task_completed_update']),
    'acknowledged',
    JSON.stringify({
      status: 'submitted_for_review',
      taskId: 'core-task-1',
      taskGuid: 'task-guid-1',
      commands: ['StartTask', 'SubmitForReview'],
      submissionIdempotencyKey: 'feishu-task-v2:status-event-1:task-command',
      state: 'review',
    }),
    Date.parse('2026-08-26T10:00:03.000Z'),
  );
  status.close();

  return {
    coreDbPath,
    statusInboxDbPath,
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

function injectedReader(overrides = {}) {
  return {
    async getTask() {
      return {
        kind: 'found',
        task: {
          guid: 'task-guid-1',
          summary: 'Completion closure canary',
          coreTaskId: 'core-task-1',
          completedAt: '1787709600000',
        },
      };
    },
    ...overrides,
  };
}

function liveReader({ completedAt = '1787709600000' } = {}) {
  return createSdkNativeTaskGateReader({
    client: {
      task: { v2: {
        task: {
          async get() {
            return { code: 0, data: { task: {
              guid: 'task-guid-1',
              summary: 'Completion closure canary',
              completed_at: completedAt,
              extra: JSON.stringify({
                schema: 'zylos.task-v2-projection/v1',
                coreTaskId: 'core-task-1',
              }),
            } } };
          },
          async list() { return { code: 0, data: { items: [], has_more: false } }; },
        },
        comment: {
          async get() { throw new Error('completion gate must not read comments'); },
          async list() { throw new Error('completion gate must not list comments'); },
          async create() { throw new Error('completion gate must not write comments'); },
        },
      } },
    },
  });
}

function evaluateFixture(fixture, overrides = {}) {
  return evaluateNativeTaskCompletionClosure({
    coreDbPath: fixture.coreDbPath,
    statusInboxDbPath: fixture.statusInboxDbPath,
    appId: APP_ID,
    cases: [{ taskGuid: 'task-guid-1', eventId: 'status-event-1' }],
    remoteReader: injectedReader(),
    clock: () => '2026-08-26T10:00:05.000Z',
    ...overrides,
  });
}

test('completion gate validates exact SQLite, Core review, and remote completion evidence', async () => {
  const fixture = createFixture();
  try {
    const report = await evaluateFixture(fixture);
    assert.equal(report.schema, 'zylos.native-task-completion-gate/v1');
    assert.equal(report.validationPassed, true);
    assert.equal(report.passed, false);
    assert.deepEqual(report.attestationFailureCodes, ['NON_LIVE_EVIDENCE']);
    assert.equal(report.cases[0].core.state, 'review');
    assert.deepEqual(report.cases[0].core.eventCounts, {
      started: 1, submitted: 1, accepted: 0,
    });
    assert.deepEqual(report.cases[0].core.commandReceipts, [
      'feishu-task-v2:status-event-1:start',
      'feishu-task-v2:status-event-1:task-command',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('only the SDK-assembled Reader can attest a completion closure PASS', async () => {
  const fixture = createFixture();
  try {
    const report = await evaluateFixture(fixture, { remoteReader: liveReader() });
    assert.equal(report.evidenceMode, 'live');
    assert.equal(report.attestable, true);
    assert.equal(report.passed, true);
    assert.deepEqual(report.failureCodes, []);
    assert.deepEqual(report.attestationFailureCodes, []);
  } finally {
    fixture.cleanup();
  }
});

test('a different or missing status event cannot satisfy the canary', async () => {
  const fixture = createFixture();
  try {
    const report = await evaluateFixture(fixture, {
      cases: [{ taskGuid: 'task-guid-1', eventId: 'status-event-other' }],
    });
    assert.deepEqual(report.failureCodes, ['STATUS_EVENT_MISSING']);
  } finally {
    fixture.cleanup();
  }
});

test('an acknowledged non-completion event cannot satisfy completion closure', async () => {
  const fixture = createFixture();
  try {
    const status = new Database(fixture.statusInboxDbPath);
    status.prepare('UPDATE task_v2_status_events SET event_types_json = ?')
      .run(JSON.stringify(['task_updated']));
    status.close();
    const report = await evaluateFixture(fixture);
    assert.deepEqual(report.failureCodes, ['STATUS_EVENT_NOT_COMPLETION']);
  } finally {
    fixture.cleanup();
  }
});

test('already-in-review settlement cannot impersonate the canary submission', async () => {
  const fixture = createFixture();
  try {
    const status = new Database(fixture.statusInboxDbPath);
    status.prepare('UPDATE task_v2_status_events SET result_json = ?')
      .run(JSON.stringify({
        status: 'already_in_review', taskId: 'core-task-1', taskGuid: 'task-guid-1',
        commands: [], state: 'review',
      }));
    status.close();
    const report = await evaluateFixture(fixture);
    assert.deepEqual(report.failureCodes, ['STATUS_RESULT_NOT_REVIEW_SUBMISSION']);
  } finally {
    fixture.cleanup();
  }
});

test('completion fails when the exact Core submit receipt is absent', async () => {
  const fixture = createFixture();
  try {
    const core = new Database(fixture.coreDbPath);
    core.prepare('DELETE FROM commitment_commands WHERE idempotency_key LIKE ?')
      .run('%:task-command');
    core.close();
    const report = await evaluateFixture(fixture);
    assert.deepEqual(report.failureCodes, ['CORE_SUBMIT_RECEIPT_MISSING']);
  } finally {
    fixture.cleanup();
  }
});

test('Core acceptance or duplicate review submission fails the closure', async () => {
  const fixture = createFixture();
  try {
    const core = new Database(fixture.coreDbPath);
    core.prepare('UPDATE commitment_tasks SET state = ?').run('done');
    core.prepare('INSERT INTO commitment_events VALUES (?, ?, ?)')
      .run('core-accept-event', 'TaskAccepted', 'core-task-1');
    core.close();
    const report = await evaluateFixture(fixture);
    assert.deepEqual(report.failureCodes, ['CORE_REVIEW_CLOSURE_INVALID']);
    assert.equal(report.cases[0].failures[0].details.counts.accepted, 1);
  } finally {
    fixture.cleanup();
  }
});

test('remote Task must still prove completion for the same linked Core Task', async () => {
  const fixture = createFixture();
  try {
    const report = await evaluateFixture(fixture, {
      remoteReader: injectedReader({
        async getTask() {
          return { kind: 'found', task: {
            guid: 'task-guid-1', summary: 'Completion closure canary',
            coreTaskId: 'core-task-1', completedAt: '0',
          } };
        },
      }),
    });
    assert.deepEqual(report.failureCodes, ['REMOTE_TASK_NOT_COMPLETED']);
  } finally {
    fixture.cleanup();
  }
});

test('production completion CLI rejects fixture-style arguments before credentials', () => {
  const fixture = createFixture();
  try {
    const inputPath = path.join(path.dirname(fixture.coreDbPath), 'input.json');
    writeFileSync(inputPath, '{}');
    const command = spawnSync(process.execPath, [
      path.resolve('scripts/native-task-completion-gate.js'),
      '--input', inputPath,
      '--remote-fixture', 'fixture.json',
    ], { cwd: path.resolve('.'), encoding: 'utf8' });
    assert.equal(command.status, 2);
    assert.equal(command.stdout, '');
    assert.match(JSON.parse(command.stderr).error.message, /usage/);
  } finally {
    fixture.cleanup();
  }
});
