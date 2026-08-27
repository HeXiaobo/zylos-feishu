import { TASK_V2_LINK_BACKEND } from './task-v2-projection.js';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Task v2 reconciliation snapshot aborted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

function projectionStateFromCore(task) {
  return ['review', 'done', 'cancelled'].includes(task.state) ? 'completed' : 'open';
}

function projectionStateFromRemote(task) {
  return task.completedAt === null || task.completedAt === '0' ? 'open' : 'completed';
}

function queryAllCoreTasks(core, signal) {
  const tasks = [];
  let cursor;
  while (true) {
    throwIfAborted(signal);
    const page = core.query({ limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page)) throw new TypeError('Core task query must return an array');
    tasks.push(...page);
    if (page.length < 100) return tasks;
    const last = requireRecord(page.at(-1), 'Core task page tail');
    const nextCursor = { updatedAt: last.updatedAt, taskId: last.id };
    if (cursor?.updatedAt === nextCursor.updatedAt && cursor?.taskId === nextCursor.taskId) {
      throw new TypeError('Core task query cursor did not advance');
    }
    cursor = nextCursor;
  }
}

/** Collect platform-shaped inputs for Core's generic reconcileProjection Module. */
export async function collectTaskV2ReconciliationSnapshot({
  core,
  gateway,
  tasks,
  signal,
} = {}) {
  if (!core || typeof core.query !== 'function' || typeof core.externalLinks?.query !== 'function') {
    throw new TypeError('core must provide query and externalLinks Interfaces');
  }
  if (
    !gateway
    || (
      typeof gateway.listManagedTasks !== 'function'
      && typeof gateway.findTasksByCoreTaskId !== 'function'
    )
  ) {
    throw new TypeError('gateway must provide listManagedTasks or findTasksByCoreTaskId');
  }
  throwIfAborted(signal);
  const coreTasks = tasks ?? queryAllCoreTasks(core, signal);
  if (!Array.isArray(coreTasks)) throw new TypeError('tasks must be an array');

  let managedTasksByCoreId = null;
  if (typeof gateway.listManagedTasks === 'function') {
    const managedTasks = await gateway.listManagedTasks({ signal });
    if (!Array.isArray(managedTasks)) {
      throw new TypeError('gateway.listManagedTasks must return an array');
    }
    managedTasksByCoreId = new Map();
    for (const [index, remoteValue] of managedTasks.entries()) {
      const remote = requireRecord(remoteValue, `managedTasks[${index}]`);
      if (typeof remote.coreTaskId !== 'string' || remote.coreTaskId.trim() === '') {
        throw new TypeError(`managedTasks[${index}].coreTaskId must be a non-empty string`);
      }
      const coreTaskId = remote.coreTaskId.trim();
      const matches = managedTasksByCoreId.get(coreTaskId) ?? [];
      matches.push(remote);
      managedTasksByCoreId.set(coreTaskId, matches);
    }
  }

  const expected = [];
  const actual = [];
  const missingLinks = [];
  const linkMismatches = [];
  const reminderDrifts = [];
  const statusRepairCandidates = [];
  for (const [index, taskValue] of coreTasks.entries()) {
    throwIfAborted(signal);
    const task = requireRecord(taskValue, `tasks[${index}]`);
    expected.push({ key: task.id, state: projectionStateFromCore(task) });
    const links = core.externalLinks.query({ taskId: task.id, backend: TASK_V2_LINK_BACKEND });
    if (links.length === 0) missingLinks.push({ taskId: task.id });
    const discovered = managedTasksByCoreId === null
      ? await gateway.findTasksByCoreTaskId(task.id, { signal })
      : (managedTasksByCoreId.get(task.id) ?? []);
    if (!Array.isArray(discovered)) {
      throw new TypeError('gateway.findTasksByCoreTaskId must return an array');
    }
    const discoveredGuids = new Set();
    for (const remoteValue of discovered) {
      const remote = requireRecord(remoteValue, 'Task v2 snapshot');
      discoveredGuids.add(remote.guid);
      actual.push({
        key: task.id,
        state: projectionStateFromRemote(remote),
        externalId: remote.guid,
        url: remote.url,
      });
      const expectedReminder = task.reminderMinutesBeforeDue ?? null;
      const actualReminder = remote.reminderMinutesBeforeDue ?? null;
      if (expectedReminder !== actualReminder) {
        reminderDrifts.push({
          taskId: task.id,
          taskGuid: remote.guid,
          expectedMinutesBeforeDue: expectedReminder,
          actualMinutesBeforeDue: actualReminder,
        });
      }
      if (
        projectionStateFromCore(task) === 'open'
        && projectionStateFromRemote(remote) === 'completed'
        && links.some(link => link.externalId === remote.guid)
      ) {
        statusRepairCandidates.push({
          taskId: task.id,
          taskGuid: remote.guid,
          completedAt: remote.completedAt,
        });
      }
    }
    for (const link of links) {
      if (!discoveredGuids.has(link.externalId)) {
        linkMismatches.push({ taskId: task.id, externalId: link.externalId });
      }
    }
  }
  return Object.freeze({
    expected: Object.freeze(expected),
    actual: Object.freeze(actual),
    missingLinks: Object.freeze(missingLinks),
    linkMismatches: Object.freeze(linkMismatches),
    reminderDrifts: Object.freeze(reminderDrifts),
    statusRepairCandidates: Object.freeze(statusRepairCandidates),
  });
}
