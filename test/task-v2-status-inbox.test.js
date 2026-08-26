import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTaskV2StatusInbox,
  processTaskV2StatusInboxOnce,
} from '../src/lib/task-v2-status-inbox.js';
import { createTaskV2StatusEventIngestor } from '../src/lib/task-v2-status-event.js';

test('status inbox atomically migrates legacy NDJSON evidence into its durable store', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-migration-'));
  const event = {
    event_id: 'evt-legacy',
    task_id: 'guid-legacy',
    app_id: 'cli_app',
    event_types: ['task_completed_update'],
  };
  const eventsPath = path.join(directory, 'events.ndjson');
  const settlementsPath = path.join(directory, 'settlements.ndjson');
  try {
    writeFileSync(eventsPath, `${JSON.stringify({ event, enqueuedAt: 1_787_900_000_000 })}\n`);
    writeFileSync(settlementsPath, `${JSON.stringify({
      type: 'ack',
      eventId: event.event_id,
      result: { status: 'submitted_for_review' },
      settledAt: 1_787_900_000_500,
    })}\n`);

    const inbox = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_001_000,
    });
    assert.deepEqual(inbox.query({ eventId: event.event_id }), {
      event,
      status: 'acknowledged',
      attempts: 0,
      nextAttemptAt: null,
      error: null,
      result: { status: 'submitted_for_review' },
    });
    const legacyEvents = readFileSync(eventsPath, 'utf8');
    const legacySettlements = readFileSync(settlementsPath, 'utf8');
    inbox.enqueue({ event_id: 'evt-sqlite', task_id: 'guid-sqlite', app_id: 'cli_app' });
    assert.equal(readFileSync(eventsPath, 'utf8'), legacyEvents);
    assert.equal(readFileSync(settlementsPath, 'utf8'), legacySettlements);
    inbox.close();

    const reopened = createTaskV2StatusInbox({ directory });
    assert.equal(reopened.query({ eventId: 'evt-sqlite' }).status, 'pending');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox fails closed when a legacy writer changes evidence after migration', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-dual-write-'));
  const eventsPath = path.join(directory, 'events.ndjson');
  try {
    writeFileSync(eventsPath, '');
    const migrated = createTaskV2StatusInbox({ directory });
    writeFileSync(eventsPath, `${JSON.stringify({
      event: { event_id: 'evt-late', task_id: 'guid-late', app_id: 'cli_app' },
      enqueuedAt: 1_787_900_000_000,
    })}\n`);

    assert.throws(
      () => migrated.pending({ limit: 10 }),
      /legacy status inbox evidence changed after SQLite migration/,
    );
    migrated.close();
    assert.throws(
      () => createTaskV2StatusInbox({ directory }),
      /legacy status inbox evidence changed after SQLite migration/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox rejects semantically inconsistent legacy retry evidence', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-corrupt-'));
  try {
    writeFileSync(path.join(directory, 'events.ndjson'), `${JSON.stringify({
      event: { event_id: 'evt-corrupt', task_id: 'guid-1', app_id: 'cli_app' },
      enqueuedAt: 1_787_900_000_000,
    })}\n`);
    writeFileSync(path.join(directory, 'settlements.ndjson'), `${JSON.stringify({
      type: 'fail',
      eventId: 'evt-corrupt',
      error: 'temporary outage',
      attempts: 2,
      failedAt: 1_787_900_000_100,
      nextAttemptAt: 1_787_900_001_100,
      deadLettered: false,
    })}\n`);

    assert.throws(
      () => createTaskV2StatusInbox({ directory }),
      /legacy status settlement attempts do not match history/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native Task v2 envelope is durably normalized before acknowledgement', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-native-event-'));
  try {
    const inbox = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    const ingestor = createTaskV2StatusEventIngestor({
      appId: 'cli_app',
      inbox,
    });

    const nativeEvent = {
      header: { event_id: 'evt-native-1', app_id: 'cli_app' },
      event: {
        task_guid: 'guid-native-1',
        event_types: ['task_completed_update', 'task_summary_update'],
      },
    };
    assert.deepEqual(ingestor.handle(nativeEvent), {
      status: 'queued',
      created: true,
      eventId: 'evt-native-1',
      taskGuid: 'guid-native-1',
    });
    assert.equal(ingestor.handle(nativeEvent).created, false);

    const reopened = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_001_000,
    });
    assert.deepEqual(reopened.pending({ limit: 10 }), [{
      event_id: 'evt-native-1',
      task_id: 'guid-native-1',
      app_id: 'cli_app',
      event_types: ['task_completed_update', 'task_summary_update'],
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox durably deduplicates events and preserves acknowledgement across reopen', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-inbox-'));
  const event = {
    event_id: 'evt-complete-1',
    task_id: 'guid-1',
    app_id: 'cli_zylos_yueran',
  };
  try {
    const first = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    assert.deepEqual(first.enqueue(event), { created: true, event });
    assert.deepEqual(first.enqueue(event), { created: false, event });
    assert.deepEqual(first.pending({ limit: 10 }), [event]);
    first.ack({ eventId: event.event_id, result: { status: 'submitted_for_review' } });

    const reopened = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_001_000,
    });
    assert.deepEqual(reopened.pending({ limit: 10 }), []);
    assert.equal(reopened.query({ eventId: event.event_id }).status, 'acknowledged');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox schedules retry and dead-letters one poison event without hiding others', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-retry-'));
  let now = 1_787_900_000_000;
  const poison = { event_id: 'evt-poison', task_id: 'guid-1', app_id: 'cli_app' };
  const healthy = { event_id: 'evt-healthy', task_id: 'guid-2', app_id: 'cli_app' };
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => now });
    inbox.enqueue(poison);
    inbox.enqueue(healthy);
    inbox.fail({
      eventId: poison.event_id,
      error: new Error('temporary Core outage'),
      retryAfterMs: 1_000,
      maxAttempts: 2,
    });
    assert.deepEqual(inbox.pending({ limit: 10 }), [healthy]);

    now += 1_000;
    assert.deepEqual(inbox.pending({ limit: 10 }), [poison, healthy]);
    inbox.fail({
      eventId: poison.event_id,
      error: new Error('still unavailable'),
      retryAfterMs: 1_000,
      maxAttempts: 2,
    });

    assert.equal(inbox.query({ eventId: poison.event_id }).status, 'dead_letter');
    assert.deepEqual(inbox.pending({ limit: 10 }), [healthy]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox worker settles each event independently and continues past poison input', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-worker-'));
  const poison = { event_id: 'evt-poison', task_id: 'guid-1', app_id: 'cli_app' };
  const healthy = { event_id: 'evt-healthy', task_id: 'guid-2', app_id: 'cli_app' };
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_787_900_000_000 });
    inbox.enqueue(poison);
    inbox.enqueue(healthy);

    const summary = await processTaskV2StatusInboxOnce({
      inbox,
      limit: 10,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      handler: {
        async handle(event) {
          if (event.event_id === poison.event_id) {
            const error = new Error('invalid linked task');
            error.retryable = false;
            throw error;
          }
          return { status: 'submitted_for_review' };
        },
      },
    });

    assert.deepEqual(summary, {
      claimed: 2,
      acknowledged: 1,
      retryWaiting: 0,
      deadLettered: 1,
    });
    assert.equal(inbox.query({ eventId: poison.event_id }).status, 'dead_letter');
    assert.equal(inbox.query({ eventId: healthy.event_id }).status, 'acknowledged');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('acknowledging a non-completion status durably schedules reconciliation work', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-reconcile-'));
  const event = {
    event_id: 'evt-summary',
    task_id: 'guid-1',
    app_id: 'cli_app',
    event_types: ['task_summary_update'],
  };
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_787_900_000_000 });
    inbox.enqueue(event);
    await processTaskV2StatusInboxOnce({
      inbox,
      handler: {
        async handle() {
          return {
            status: 'reconciliation_required',
            taskGuid: event.task_id,
            eventTypes: event.event_types,
          };
        },
      },
    });
    inbox.close();

    const reopened = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_001_000,
    });
    assert.deepEqual(reopened.pendingReconciliations({ limit: 10 }), [event]);
    assert.equal(reopened.query({ eventId: event.event_id }).status, 'acknowledged');
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status acknowledgement and reconciliation enqueue commit atomically', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-atomic-'));
  const event = {
    event_id: 'evt-atomic',
    task_id: 'guid-1',
    app_id: 'cli_app',
    event_types: ['task_summary_update'],
  };
  try {
    const inbox = createTaskV2StatusInbox({ directory });
    inbox.enqueue(event);
    assert.throws(() => inbox.ack({
      eventId: event.event_id,
      result: {
        status: 'reconciliation_required',
        eventTypes: event.event_types,
        invalidOversizedEvidence: 'x'.repeat(1024 * 1024),
      },
    }), /status result exceeds/);
    assert.equal(inbox.query({ eventId: event.event_id }).status, 'pending');
    assert.deepEqual(inbox.pendingReconciliations({ limit: 10 }), []);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mixed completion schedules only its non-completion commit types for reconciliation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-mixed-'));
  const event = {
    event_id: 'evt-complete-summary',
    task_id: 'guid-1',
    app_id: 'cli_app',
    event_types: ['task_completed_update', 'task_summary_update'],
  };
  try {
    const inbox = createTaskV2StatusInbox({ directory });
    inbox.enqueue(event);
    await processTaskV2StatusInboxOnce({
      inbox,
      handler: {
        async handle() {
          return {
            status: 'submitted_for_review',
            taskGuid: event.task_id,
            reconciliationEventTypes: ['task_summary_update'],
          };
        },
      },
    });

    assert.deepEqual(inbox.pendingReconciliations({ limit: 10 }), [{
      ...event,
      event_types: ['task_summary_update'],
    }]);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconciliation work is consumed with durable retry independent of status acknowledgement', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-reconciliation-retry-'));
  let now = 1_787_900_000_000;
  const event = {
    event_id: 'evt-members',
    task_id: 'guid-1',
    app_id: 'cli_app',
    event_types: ['task_members_update'],
  };
  try {
    let inbox = createTaskV2StatusInbox({ directory, clock: () => now });
    inbox.enqueue(event);
    const first = await processTaskV2StatusInboxOnce({
      inbox,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      handler: {
        async handle() {
          return {
            status: 'reconciliation_required',
            taskGuid: event.task_id,
            eventTypes: event.event_types,
          };
        },
      },
      reconciler: {
        async handle() { throw new Error('temporary Task v2 outage'); },
      },
    });
    assert.deepEqual(first.reconciliation, {
      claimed: 1,
      acknowledged: 0,
      retryWaiting: 1,
      deadLettered: 0,
    });
    assert.equal(inbox.queryReconciliation({ eventId: event.event_id }).status, 'retry_wait');
    inbox.close();

    now += 1_000;
    inbox = createTaskV2StatusInbox({ directory, clock: () => now });
    const repaired = [];
    const second = await processTaskV2StatusInboxOnce({
      inbox,
      retryAfterMs: 1_000,
      maxAttempts: 3,
      handler: { async handle() { throw new Error('settled status must not replay'); } },
      reconciler: {
        async handle(work) {
          repaired.push(work);
          return { status: 'reconciled' };
        },
      },
    });
    assert.deepEqual(second.reconciliation, {
      claimed: 1,
      acknowledged: 1,
      retryWaiting: 0,
      deadLettered: 0,
    });
    assert.deepEqual(repaired, [event]);
    assert.equal(
      inbox.queryReconciliation({ eventId: event.event_id }).status,
      'acknowledged',
    );
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
