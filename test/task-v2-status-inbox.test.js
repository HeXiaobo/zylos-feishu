import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createTaskV2StatusInbox,
  processTaskV2StatusInboxOnce,
} from '../src/lib/task-v2-status-inbox.js';

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
