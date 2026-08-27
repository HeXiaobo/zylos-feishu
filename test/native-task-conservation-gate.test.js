import assert from 'node:assert/strict';
import test from 'node:test';

import { auditNativeTaskConservation } from '../src/lib/native-task-conservation-gate.js';

const APP_ID = 'cli_a9f4963828b89bdf';
const AGENT_ID = 'agent:yueran';

function coreTask(id, state) {
  return {
    id,
    title: id,
    state,
    assigneeId: AGENT_ID,
    updatedAt: '2026-08-27T03:00:00.000Z',
  };
}

function coreInventory(tasks) {
  return {
    schema: 'zylos.native-task-core-inventory/v1',
    capturedAt: '2026-08-27T03:00:01.000Z',
    snapshot: {
      stable: true,
      strategy: 'double-read-fingerprint',
      fingerprint: 'a'.repeat(64),
    },
    identity: { agentId: AGENT_ID },
    activeStates: ['ready', 'in_progress', 'review'],
    tasks,
    externalLinks: tasks.map(task => ({
      taskId: task.id,
      backend: 'feishu-task-v2',
      externalId: `guid-${task.id}`,
    })),
  };
}

function nativeTask(coreId, status) {
  return {
    guid: `guid-${coreId}`,
    summary: coreId,
    description: `Zylos Core Task: ${coreId}`,
    extra: JSON.stringify({
      schema: 'zylos.task-v2-projection/v1',
      coreTaskId: coreId,
      coreTaskVersion: 1,
    }),
    status,
    completed_at: status === 'done' ? '1787799600000' : '0',
    creator: { id: APP_ID, type: 'app' },
    members: [{ id: APP_ID, type: 'app', role: 'assignee' }],
    updated_at: '1787799600000',
  };
}

function stableRemote(tasks) {
  return {
    async capture() {
      return { identity: { kind: 'app', appId: APP_ID }, tasks };
    },
  };
}

async function audit({ tasks, nativeTasks, inventory, deployment } = {}) {
  return auditNativeTaskConservation({
    coreInventory: inventory ?? coreInventory(tasks),
    remote: stableRemote(nativeTasks),
    deployment: deployment ?? {
      agentId: AGENT_ID,
      appId: APP_ID,
      agentAppIds: { [AGENT_ID]: APP_ID },
    },
  });
}

test('conserves every active Agent task with todo for work and done for review', async () => {
  const tasks = [
    coreTask('task-ready', 'ready'),
    coreTask('task-progress', 'in_progress'),
    coreTask('task-review', 'review'),
  ];
  const report = await auditNativeTaskConservation({
    coreInventory: coreInventory(tasks),
    remote: stableRemote([
      nativeTask('task-ready', 'todo'),
      nativeTask('task-progress', 'todo'),
      nativeTask('task-review', 'done'),
    ]),
    deployment: {
      agentId: AGENT_ID,
      appId: APP_ID,
      agentAppIds: { [AGENT_ID]: APP_ID },
    },
  });

  assert.equal(report.schema, 'zylos.native-task-conservation-gate/v1');
  assert.equal(report.passed, true);
  assert.deepEqual(report.failureCodes, []);
  assert.deepEqual(report.counts, {
    coreTasks: 3,
    activeAgentTasks: 3,
    persistentLinks: 3,
    remoteTasks: 3,
    scopedRemoteTasks: 3,
  });
  assert.equal(Object.isFrozen(report), true);
});

test('fails an open App card that has a projection marker but no persistent link', async () => {
  const task = coreTask('task-unlinked', 'ready');
  const inventory = coreInventory([task]);
  inventory.externalLinks = [];

  const report = await audit({
    tasks: [task],
    inventory,
    nativeTasks: [nativeTask(task.id, 'todo')],
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureCodes, [
    'CORE_TASK_LINK_CARDINALITY_MISMATCH',
    'REMOTE_CARD_LINK_CARDINALITY_MISMATCH',
  ]);
});

test('fails a persistent link whose card is absent', async () => {
  const task = coreTask('task-missing-card', 'in_progress');
  const report = await audit({ tasks: [task], nativeTasks: [] });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureCodes, ['PERSISTENT_LINK_CARD_CARDINALITY_MISMATCH']);
});

test('fails description, extra and persistent-link disagreement without guessing', async () => {
  const task = coreTask('task-canonical', 'ready');
  const card = nativeTask(task.id, 'todo');
  card.description = 'Zylos Core Task: task-description';
  card.extra = JSON.stringify({
    schema: 'zylos.task-v2-projection/v1',
    coreTaskId: 'task-extra',
    coreTaskVersion: 1,
  });

  const report = await audit({ tasks: [task], nativeTasks: [card] });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureCodes, [
    'DESCRIPTION_EXTRA_CORE_TASK_MISMATCH',
    'MARKER_LINK_CORE_TASK_MISMATCH',
  ]);
});

test('fails one card containing two description markers', async () => {
  const task = coreTask('task-two-markers', 'ready');
  const card = nativeTask(task.id, 'todo');
  card.description = [
    `Zylos Core Task: ${task.id}`,
    'Zylos Core Task: task-other',
  ].join('\n');

  const report = await audit({ tasks: [task], nativeTasks: [card] });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureCodes, ['DESCRIPTION_MARKER_CARDINALITY_MISMATCH']);
});

test('fails duplicate cards for one Core task even when one card has no link', async () => {
  const task = coreTask('task-duplicate', 'ready');
  const duplicate = nativeTask(task.id, 'todo');
  duplicate.guid = 'guid-duplicate-card';

  const report = await audit({
    tasks: [task],
    nativeTasks: [nativeTask(task.id, 'todo'), duplicate],
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureCodes, [
    'CORE_TASK_CARDINALITY_MISMATCH',
    'REMOTE_CARD_LINK_CARDINALITY_MISMATCH',
  ]);
});

test('does not put terminal tasks in the denominator but fails their open cards', async () => {
  const done = coreTask('task-terminal-done-card', 'done');
  const doneInventory = coreInventory([done]);
  doneInventory.externalLinks = [];
  const doneReport = await audit({
    tasks: [done], inventory: doneInventory, nativeTasks: [nativeTask(done.id, 'done')],
  });
  assert.equal(doneReport.passed, true);
  assert.equal(doneReport.counts.activeAgentTasks, 0);

  const open = coreTask('task-terminal-open-card', 'done');
  const openReport = await audit({ tasks: [open], nativeTasks: [nativeTask(open.id, 'todo')] });
  assert.equal(openReport.passed, false);
  assert.deepEqual(openReport.failureCodes, ['TERMINAL_CORE_HAS_OPEN_CARD']);

  const unlinkedInventory = coreInventory([open]);
  unlinkedInventory.externalLinks = [];
  const unlinkedReport = await audit({
    tasks: [open],
    inventory: unlinkedInventory,
    nativeTasks: [nativeTask(open.id, 'todo')],
  });
  assert.equal(unlinkedReport.failureCodes.includes('TERMINAL_CORE_HAS_OPEN_CARD'), true);
});

test('ignores an unknown completed historical marker with no persistent link', async () => {
  const report = await audit({
    tasks: [],
    nativeTasks: [nativeTask('task-unknown-history', 'done')],
  });

  assert.equal(report.passed, true);
  assert.deepEqual(report.failureCodes, []);
});

test('requires assignees on active Core tasks but does not force human tasks into App scope', async () => {
  const missing = coreTask('task-no-assignee', 'ready');
  missing.assigneeId = null;
  const missingInventory = coreInventory([missing]);
  missingInventory.externalLinks = [];
  const missingReport = await audit({
    tasks: [missing], inventory: missingInventory, nativeTasks: [],
  });
  assert.deepEqual(missingReport.failureCodes, ['ACTIVE_CORE_TASK_ASSIGNEE_MISSING']);

  const human = coreTask('task-human', 'ready');
  human.assigneeId = 'ou_human';
  const humanInventory = coreInventory([human]);
  humanInventory.externalLinks = [];
  const humanReport = await audit({
    tasks: [human], inventory: humanInventory, nativeTasks: [],
  });
  assert.equal(humanReport.passed, true);
  assert.equal(humanReport.counts.activeAgentTasks, 0);
});

test('fails an Agent scope that maps to another App inventory', async () => {
  const task = coreTask('task-other-agent', 'ready');
  task.assigneeId = 'agent:other';
  const inventory = coreInventory([task]);
  inventory.externalLinks = [];

  const report = await audit({
    tasks: [task],
    inventory,
    nativeTasks: [],
    deployment: {
      agentId: AGENT_ID,
      appId: APP_ID,
      agentAppIds: { [AGENT_ID]: APP_ID, 'agent:other': 'cli_other' },
    },
  });

  assert.deepEqual(report.failureCodes, ['UNVALIDATED_AGENT_SCOPE']);
});

test('fails closed on malformed remote identity/status and an unstable live snapshot', async () => {
  const task = coreTask('task-malformed', 'ready');
  const malformed = nativeTask(task.id, 'todo');
  malformed.status = 'unknown';
  await assert.rejects(
    audit({ tasks: [task], nativeTasks: [malformed] }),
    /status is unsupported/,
  );

  await assert.rejects(
    auditNativeTaskConservation({
      coreInventory: coreInventory([task]),
      remote: {
        async capture() {
          return { identity: { kind: 'user', appId: APP_ID }, tasks: [] };
        },
      },
      deployment: { agentId: AGENT_ID, appId: APP_ID, agentAppIds: { [AGENT_ID]: APP_ID } },
    }),
    /identity.kind must be app/,
  );

  let scan = 0;
  const unstable = await auditNativeTaskConservation({
    coreInventory: coreInventory([task]),
    remote: {
      async capture() {
        scan += 1;
        return {
          identity: { kind: 'app', appId: APP_ID },
          tasks: scan === 1 ? [] : [nativeTask(task.id, 'todo')],
        };
      },
    },
    deployment: { agentId: AGENT_ID, appId: APP_ID, agentAppIds: { [AGENT_ID]: APP_ID } },
  });
  assert.equal(unstable.failureCodes.includes('SNAPSHOT_UNSTABLE'), true);
  assert.equal(unstable.inventory.remoteSnapshot.stable, false);
  assert.deepEqual(unstable.inventory.remoteSnapshot.first.tasks, []);
  assert.equal(unstable.inventory.remoteSnapshot.second.tasks.length, 1);
});

test('emits the same complete report regardless of input ordering', async () => {
  const tasks = [coreTask('task-b', 'review'), coreTask('task-a', 'ready')];
  const first = await audit({
    tasks,
    nativeTasks: [nativeTask('task-b', 'done'), nativeTask('task-a', 'todo')],
  });
  const inventory = coreInventory([...tasks].reverse());
  inventory.externalLinks.reverse();
  const second = await audit({
    tasks,
    inventory,
    nativeTasks: [nativeTask('task-a', 'todo'), nativeTask('task-b', 'done')],
  });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
