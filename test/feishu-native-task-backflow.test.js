import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createFeishuNativeTaskBackflow,
} from '../src/lib/feishu-native-task-backflow.js';
import {
  createTaskV2StatusInbox,
  processTaskV2StatusInboxOnce,
} from '../src/lib/task-v2-status-inbox.js';

function nativeEvent(overrides = {}) {
  return {
    eventId: 'evt-native-complete',
    appId: 'cli-app',
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    externalTaskId: 'guid-task-1',
    actorId: 'user-1',
    action: 'completed',
    externalVersion: 7,
    effectId: 'effect-task-1-v7',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...overrides,
  };
}

function projection(overrides = {}) {
  return {
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    externalTaskId: 'guid-task-1',
    taskId: 'task-1',
    coreVersion: 7,
    effectId: 'effect-task-1-v7',
    payloadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...overrides,
  };
}

test('native completion is durable before handling and maps only to SubmitForReview', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-native-task-backflow-'));
  const submitted = [];
  try {
    let inbox = createTaskV2StatusInbox({ directory, clock: () => 1_788_000_000_000 });
    const backflow = createFeishuNativeTaskBackflow({
      inbox,
      identity: { appId: 'cli-app', tenantRef: 'tenant-1', accountRef: 'acct-1' },
      resolveProjection: async () => projection(),
      verifyActor: async () => ({
        actor: {
          provider: 'feishu', tenantRef: 'tenant-1', externalId: 'user-1',
          provenance: 'verified_channel_actor',
        },
        assertion: Object.freeze({ trusted: true }),
      }),
      taskCommandPort: {
        submit(command) {
          submitted.push(command);
          return { accepted: true, suppressed: false, task: { id: 'task-1', version: 8 } };
        },
      },
    });
    assert.equal(backflow.ingest(nativeEvent()).status, 'queued');
    inbox.close();

    inbox = createTaskV2StatusInbox({ directory, clock: () => 1_788_000_001_000 });
    const recovered = createFeishuNativeTaskBackflow({
      inbox,
      identity: { appId: 'cli-app', tenantRef: 'tenant-1', accountRef: 'acct-1' },
      resolveProjection: async () => projection(),
      verifyActor: async () => ({
        actor: {
          provider: 'feishu', tenantRef: 'tenant-1', externalId: 'user-1',
          provenance: 'verified_channel_actor',
        },
        assertion: Object.freeze({ trusted: true }),
      }),
      taskCommandPort: { submit: command => (submitted.push(command), { accepted: true }) },
    });
    const summary = await processTaskV2StatusInboxOnce({
      inbox,
      handler: recovered,
      workerId: 'native-task-worker',
      leaseMs: 5_000,
    });
    assert.equal(summary.acknowledged, 1);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].intent.command, 'SubmitForReview');
    assert.equal(submitted[0].intent.expectedVersion, 7);
    assert.equal(submitted[0].capability, 'task.submit_for_review');
    assert.equal(submitted[0].origin, 'native_task_projection');
    assert.equal(submitted[0].originEffectId, 'effect-task-1-v7');
    assert.equal(Object.hasOwn(submitted[0].intent, 'AcceptTask'), false);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native task backflow rejects unauthorized actors and repairs version or unsupported drift', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-native-task-policy-'));
  const submitted = [];
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_788_000_000_000 });
    const make = overrides => createFeishuNativeTaskBackflow({
      inbox,
      identity: { appId: 'cli-app', tenantRef: 'tenant-1', accountRef: 'acct-1' },
      resolveProjection: async () => projection(overrides?.projection),
      verifyActor: async ({ actorId }) => (actorId === 'attacker' ? null : {
        actor: {
          provider: 'feishu', tenantRef: 'tenant-1', externalId: actorId,
          provenance: 'verified_channel_actor',
        },
        assertion: Object.freeze({ trusted: true }),
      }),
      taskCommandPort: { submit: command => (submitted.push(command), { accepted: true }) },
    });

    const unauthorized = make();
    unauthorized.ingest(nativeEvent({ eventId: 'evt-unauthorized', actorId: 'attacker' }));
    const [unauthorizedWork] = inbox.claim({ workerId: 'w1', leaseMs: 5_000, limit: 1 });
    assert.deepEqual(await unauthorized.handle(unauthorizedWork.event), {
      status: 'rejected',
      code: 'UNAUTHORIZED_ACTOR',
      repair: 'reproject',
    });
    inbox.ack({ receipt: unauthorizedWork.receipt, result: { status: 'rejected' } });

    const stale = make();
    stale.ingest(nativeEvent({ eventId: 'evt-stale', externalVersion: 6 }));
    const [staleWork] = inbox.claim({ workerId: 'w2', leaseMs: 5_000, limit: 1 });
    assert.deepEqual(await stale.handle(staleWork.event), {
      status: 'rejected',
      code: 'VERSION_DRIFT',
      repair: 'reproject',
    });
    inbox.ack({ receipt: staleWork.receipt, result: { status: 'rejected' } });

    const unsupported = make();
    unsupported.ingest(nativeEvent({ eventId: 'evt-unsupported', action: 'delete' }));
    const [unsupportedWork] = inbox.claim({ workerId: 'w3', leaseMs: 5_000, limit: 1 });
    assert.deepEqual(await unsupported.handle(unsupportedWork.event), {
      status: 'rejected',
      code: 'UNSUPPORTED_CHANGE',
      repair: 'reproject',
    });
    assert.equal(submitted.length, 0);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed projection markers reject before actor verification or Core command I/O', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-native-task-marker-'));
  const submitted = [];
  let verifiedActors = 0;
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_788_000_000_000 });
    let markerOverride;
    const backflow = createFeishuNativeTaskBackflow({
      inbox,
      identity: { appId: 'cli-app', tenantRef: 'tenant-1', accountRef: 'acct-1' },
      resolveProjection: async () => projection(markerOverride),
      verifyActor: async () => {
        verifiedActors += 1;
        return null;
      },
      taskCommandPort: { submit: command => (submitted.push(command), { accepted: true }) },
    });
    backflow.ingest(nativeEvent({ eventId: 'evt-malformed-marker' }));
    const [event] = inbox.pending({ limit: 1 });
    const variants = [
      ['taskId=missing', { taskId: undefined }],
      ['taskId=whitespace', { taskId: ' task-1' }],
      ['coreVersion=null', { coreVersion: null }],
      ['coreVersion=string', { coreVersion: '7' }],
      ['coreVersion=zero', { coreVersion: 0 }],
      ['coreVersion=negative', { coreVersion: -1 }],
      ['coreVersion=fractional', { coreVersion: 7.5 }],
      ['coreVersion=NaN', { coreVersion: Number.NaN }],
      ['coreVersion=Infinity', { coreVersion: Number.POSITIVE_INFINITY }],
      ['coreVersion=unsafe', { coreVersion: Number.MAX_SAFE_INTEGER + 1 }],
      ['tenantRef=missing', { tenantRef: undefined }],
      ['effectId=whitespace', { effectId: ' effect-task-1-v7' }],
      ['payloadHash=padded', {
        payloadHash: ' sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }],
      ['legacy identity', {
        tenantRef: null, accountRef: null, effectId: null, payloadHash: null,
      }],
    ];
    for (const [name, override] of variants) {
      markerOverride = override;
      assert.deepEqual(await backflow.handle(event), {
        status: 'rejected',
        code: 'PROJECTION_IDENTITY_DRIFT',
        repair: 'reproject',
      }, name);
    }
    assert.equal(verifiedActors, 0);
    assert.equal(submitted.length, 0);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('supported start/submit/reject/accept/update backflow commands preserve capability and loop suppression', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-native-task-actions-'));
  const submitted = [];
  try {
    const inbox = createTaskV2StatusInbox({ directory, clock: () => 1_788_000_000_000 });
    const backflow = createFeishuNativeTaskBackflow({
      inbox,
      identity: { appId: 'cli-app', tenantRef: 'tenant-1', accountRef: 'acct-1' },
      resolveProjection: async () => projection(),
      verifyActor: async ({ actorId }) => ({
        actor: {
          provider: 'feishu', tenantRef: 'tenant-1', externalId: actorId,
          provenance: 'verified_channel_actor',
        },
        assertion: Object.freeze({ trusted: true }),
      }),
      taskCommandPort: {
        submit(command) {
          submitted.push(command);
          return {
            accepted: true,
            suppressed: command.intent.command === 'StartTask',
            task: { version: 8 },
          };
        },
      },
    });
    const cases = [
      ['start', 'StartTask', 'task.start'],
      ['completed', 'SubmitForReview', 'task.submit_for_review'],
      ['reject', 'RequestChanges', 'task.request_changes'],
      ['accept', 'AcceptTask', 'task.accept'],
      ['update_reminder', 'UpdateTaskReminder', 'task.update'],
    ];
    for (const [index, [action, command, capability]] of cases.entries()) {
      backflow.ingest(nativeEvent({
        eventId: `evt-action-${index}`,
        action,
        ...(action === 'update_reminder' ? { reminderMinutesBeforeDue: 15 } : {}),
      }));
      const event = inbox.pending({ limit: 20 }).find(row => row.event_id === `evt-action-${index}`);
      const result = await backflow.handle(event);
      assert.equal(submitted.at(-1).intent.command, command);
      assert.equal(submitted.at(-1).capability, capability);
      if (action === 'start') assert.equal(result.status, 'suppressed');
    }
    assert.equal(submitted.at(-1).intent.reminderMinutesBeforeDue, 15);
    inbox.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
