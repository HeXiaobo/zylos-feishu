import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import {
  createTaskV2StatusInbox,
  processTaskV2StatusInboxOnce,
} from '../src/lib/task-v2-status-inbox.js';
import { createTaskV2StatusEventIngestor } from '../src/lib/task-v2-status-event.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function payloadHash(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

test('status inbox rejects a reused logical hash for different canonical payload', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-forged-hash-'));
  const firstPayload = { action: 'SubmitForReview', expectedVersion: 7 };
  const first = {
    event_id: 'evt-first',
    task_id: 'guid-forged',
    app_id: 'cli_app',
    logical_key: 'acct-1:guid-forged:SubmitForReview:v7',
    payload_hash: payloadHash(firstPayload),
    payload: firstPayload,
  };
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_787_900_000_000 });
    assert.equal(inbox.enqueue(first).created, true);
    assert.throws(
      () => inbox.enqueue({
        ...first,
        event_id: 'evt-second',
        payload: { action: 'AcceptTask', expectedVersion: 7 },
      }),
      error => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox rejects a whitespace-padded supplied hash before persistence', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-hash-whitespace-'));
  const payload = { action: 'SubmitForReview', expectedVersion: 7 };
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_787_900_000_000 });
    assert.throws(
      () => inbox.enqueue({
        event_id: 'evt-whitespace-hash',
        task_id: 'guid-whitespace-hash',
        app_id: 'cli_app',
        logical_key: 'acct-1:guid-whitespace-hash:SubmitForReview:v7',
        payload_hash: ` ${payloadHash(payload)}`,
        payload,
      }),
      /canonical sha256/,
    );
    assert.deepEqual(inbox.pending({ limit: 10 }), []);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox deduplicates transport and logical native task identities independently', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-dual-identity-'));
  const payload = {
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    actorId: 'user-1',
    action: 'SubmitForReview',
    expectedVersion: 7,
  };
  const base = {
    task_id: 'guid-dual',
    app_id: 'cli_app',
    event_types: ['task_completed_update'],
    logical_key: 'acct-1:guid-dual:SubmitForReview:v7',
    payload_hash: payloadHash(payload),
    payload,
  };
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_787_900_000_000 });
    assert.equal(inbox.enqueue({ ...base, event_id: 'evt-websocket' }).created, true);
    const logicalReplay = inbox.enqueue({ ...base, event_id: 'evt-webhook' });
    assert.equal(logicalReplay.created, false);
    assert.equal(logicalReplay.event.event_id, 'evt-websocket');
    assert.deepEqual(inbox.pending({ limit: 10 }), [{ ...base, event_id: 'evt-websocket' }]);
    assert.throws(
      () => inbox.enqueue({
        ...base,
        event_id: 'evt-conflict',
        payload_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
      error => error?.code === 'IDEMPOTENCY_CONFLICT',
    );
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status inbox persists only structured redacted failure metadata', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-redacted-error-'));
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_787_900_000_000 });
    inbox.enqueue({ event_id: 'evt-redacted', task_id: 'guid-redacted', app_id: 'cli_app' });
    const [claim] = inbox.claim({ workerId: 'worker-redacted', leaseMs: 5_000 });
    const failure = new Error('access_token=secret; message body: private task text');
    failure.code = 'PLATFORM_REJECTED';
    failure.retryable = false;
    inbox.fail({ receipt: claim.receipt, error: failure, retryAfterMs: 1_000, maxAttempts: 5 });
    const persisted = inbox.query({ eventId: 'evt-redacted' }).error;
    assert.deepEqual(JSON.parse(persisted), {
      code: 'PLATFORM_REJECTED',
      retryable: false,
    });
    assert.doesNotMatch(persisted, /secret|private task text|access_token/);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test('two concurrent first opens converge on one legacy migration result', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-concurrent-migration-'));
  const records = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
    event: {
      event_id: `evt-legacy-${index}`,
      task_id: `guid-legacy-${index}`,
      app_id: 'cli_app',
    },
    enqueuedAt: 1_787_900_000_000 + index,
  })).join('\n');
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const signal = new Int32Array(barrier);
  const moduleUrl = new URL('../src/lib/task-v2-status-inbox.js', import.meta.url).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const signal = new Int32Array(workerData.barrier);
      const { createTaskV2StatusInbox } = await import(workerData.moduleUrl);
      Atomics.add(signal, 0, 1);
      Atomics.notify(signal, 0);
      Atomics.wait(signal, 1, 0);
      try {
        const inbox = createTaskV2StatusInbox({ directory: workerData.directory });
        const status = inbox.query({ eventId: 'evt-legacy-0' }).status;
        inbox.close();
        parentPort.postMessage({ ok: true, status });
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error.message });
      }
    })();
  `;
  const open = () => {
    const worker = new Worker(source, {
      eval: true,
      workerData: { barrier, directory, moduleUrl },
    });
    return new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
  };
  try {
    writeFileSync(path.join(directory, 'events.ndjson'), `${records}\n`);
    const openings = [open(), open()];
    while (Atomics.load(signal, 0) < 2) {
      const observed = Atomics.load(signal, 0);
      Atomics.wait(signal, 0, observed, 5_000);
    }
    Atomics.store(signal, 1, 1);
    Atomics.notify(signal, 1, 2);

    assert.deepEqual(await Promise.all(openings), [
      { ok: true, status: 'pending' },
      { ok: true, status: 'pending' },
    ]);
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
    const [claimed] = first.claim({ workerId: 'worker-a', leaseMs: 5_000 });
    first.ack({ receipt: claimed.receipt, result: { status: 'submitted_for_review' } });

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

test('two status inbox connections atomically claim one event for only one worker', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-claim-'));
  const event = { event_id: 'evt-claim', task_id: 'guid-claim', app_id: 'cli_app' };
  try {
    const first = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    const second = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    first.enqueue(event);

    const claimed = first.claim({ workerId: 'worker-a', leaseMs: 5_000, limit: 10 });
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0].event, event);
    assert.deepEqual(claimed[0].receipt, {
      eventId: event.event_id,
      workerId: 'worker-a',
      version: 2,
    });
    assert.deepEqual(second.claim({ workerId: 'worker-b', leaseMs: 5_000, limit: 10 }), []);

    second.close();
    first.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired status lease is recovered and fences stale acknowledgement and failure', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-takeover-'));
  const event = { event_id: 'evt-takeover', task_id: 'guid-takeover', app_id: 'cli_app' };
  let now = 1_787_900_000_000;
  try {
    const first = createTaskV2StatusInbox({ directory, clock: () => now });
    const second = createTaskV2StatusInbox({ directory, clock: () => now });
    first.enqueue(event);
    const [stale] = first.claim({ workerId: 'worker-a', leaseMs: 1_000 });

    now += 1_000;
    const [recovered] = second.claim({ workerId: 'worker-b', leaseMs: 1_000 });
    assert.equal(recovered.receipt.eventId, stale.receipt.eventId);
    assert.equal(recovered.receipt.version, stale.receipt.version + 1);
    assert.equal(second.ack({
      receipt: recovered.receipt,
      result: { status: 'submitted_for_review' },
    }).status, 'acknowledged');
    assert.throws(
      () => first.ack({ receipt: stale.receipt, result: { status: 'stale' } }),
      error => error.code === 'LEASE_LOST',
    );
    assert.throws(
      () => first.fail({
        receipt: stale.receipt,
        error: new Error('stale failure'),
        retryAfterMs: 1_000,
        maxAttempts: 3,
      }),
      error => error.code === 'LEASE_LOST',
    );
    assert.deepEqual(first.query({ eventId: event.event_id }).result, {
      status: 'submitted_for_review',
    });

    second.close();
    first.close();
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
    const [firstAttempt] = inbox.claim({ workerId: 'worker-a', leaseMs: 5_000, limit: 1 });
    inbox.fail({
      receipt: firstAttempt.receipt,
      error: new Error('temporary Core outage'),
      retryAfterMs: 1_000,
      maxAttempts: 2,
    });
    assert.deepEqual(inbox.pending({ limit: 10 }), [healthy]);

    now += 1_000;
    assert.deepEqual(inbox.pending({ limit: 10 }), [poison, healthy]);
    const [secondAttempt] = inbox.claim({ workerId: 'worker-b', leaseMs: 5_000, limit: 1 });
    inbox.fail({
      receipt: secondAttempt.receipt,
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
      workerId: 'status-worker',
      leaseMs: 5_000,
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

test('concurrent status worker cycles do not process the same event twice', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-status-concurrent-workers-'));
  const event = { event_id: 'evt-once', task_id: 'guid-once', app_id: 'cli_app' };
  try {
    const first = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    const second = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    first.enqueue(event);
    const handled = [];
    const handler = {
      async handle(work) {
        handled.push(work.event_id);
        await Promise.resolve();
        return { status: 'submitted_for_review' };
      },
    };

    const summaries = await Promise.all([
      processTaskV2StatusInboxOnce({
        inbox: first,
        handler,
        workerId: 'once-worker',
        leaseMs: 5_000,
      }),
      processTaskV2StatusInboxOnce({
        inbox: second,
        handler,
        workerId: 'pm2-worker',
        leaseMs: 5_000,
      }),
    ]);

    assert.deepEqual(handled, [event.event_id]);
    assert.deepEqual(summaries.map(summary => summary.claimed).sort(), [0, 1]);
    assert.equal(first.query({ eventId: event.event_id }).status, 'acknowledged');
    second.close();
    first.close();
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
      workerId: 'status-worker',
      leaseMs: 5_000,
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

test('two status inbox connections atomically claim one reconciliation for only one worker', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-reconciliation-claim-'));
  const event = {
    event_id: 'evt-reconciliation-claim',
    task_id: 'guid-reconciliation-claim',
    app_id: 'cli_app',
    event_types: ['task_summary_update'],
  };
  try {
    const first = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    const second = createTaskV2StatusInbox({
      directory,
      clock: () => 1_787_900_000_000,
    });
    first.enqueue(event);
    const [status] = first.claim({ workerId: 'status-worker', leaseMs: 5_000 });
    first.ack({
      receipt: status.receipt,
      result: {
        status: 'reconciliation_required',
        taskGuid: event.task_id,
        eventTypes: event.event_types,
      },
    });

    const claimed = first.claimReconciliations({
      workerId: 'worker-a',
      leaseMs: 5_000,
      limit: 10,
    });
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0].event, event);
    assert.deepEqual(claimed[0].receipt, {
      eventId: event.event_id,
      workerId: 'worker-a',
      version: 2,
    });
    assert.deepEqual(second.claimReconciliations({
      workerId: 'worker-b',
      leaseMs: 5_000,
      limit: 10,
    }), []);

    second.close();
    first.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired reconciliation lease is recovered and fences stale acknowledgement and failure', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-task-v2-reconciliation-takeover-'));
  const event = {
    event_id: 'evt-reconciliation-takeover',
    task_id: 'guid-reconciliation-takeover',
    app_id: 'cli_app',
    event_types: ['task_summary_update'],
  };
  let now = 1_787_900_000_000;
  try {
    const first = createTaskV2StatusInbox({ directory, clock: () => now });
    const second = createTaskV2StatusInbox({ directory, clock: () => now });
    first.enqueue(event);
    const [status] = first.claim({ workerId: 'status-worker', leaseMs: 5_000 });
    first.ack({
      receipt: status.receipt,
      result: {
        status: 'reconciliation_required',
        taskGuid: event.task_id,
        eventTypes: event.event_types,
      },
    });
    const [stale] = first.claimReconciliations({ workerId: 'worker-a', leaseMs: 1_000 });

    now += 1_000;
    const [recovered] = second.claimReconciliations({ workerId: 'worker-b', leaseMs: 1_000 });
    assert.equal(recovered.receipt.version, stale.receipt.version + 1);
    assert.equal(second.ackReconciliation({
      receipt: recovered.receipt,
      result: { status: 'reconciled' },
    }).status, 'acknowledged');
    assert.throws(
      () => first.ackReconciliation({
        receipt: stale.receipt,
        result: { status: 'stale' },
      }),
      error => error.code === 'LEASE_LOST',
    );
    assert.throws(
      () => first.failReconciliation({
        receipt: stale.receipt,
        error: new Error('stale failure'),
        retryAfterMs: 1_000,
        maxAttempts: 3,
      }),
      error => error.code === 'LEASE_LOST',
    );
    assert.deepEqual(first.queryReconciliation({ eventId: event.event_id }).result, {
      status: 'reconciled',
    });

    second.close();
    first.close();
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
    const [claimed] = inbox.claim({ workerId: 'status-worker', leaseMs: 5_000 });
    assert.throws(() => inbox.ack({
      receipt: claimed.receipt,
      result: {
        status: 'reconciliation_required',
        eventTypes: event.event_types,
        invalidOversizedEvidence: 'x'.repeat(1024 * 1024),
      },
    }), /status result exceeds/);
    assert.equal(inbox.query({ eventId: event.event_id }).status, 'leased');
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
      workerId: 'status-worker',
      leaseMs: 5_000,
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
      workerId: 'status-worker-1',
      leaseMs: 5_000,
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
      workerId: 'status-worker-2',
      leaseMs: 5_000,
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
