import { TASK_V2_LINK_BACKEND } from './task-v2-projection.js';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function projectionStateFromCore(task) {
  return ['review', 'done', 'cancelled'].includes(task.state) ? 'completed' : 'open';
}

function projectionStateFromRemote(task) {
  return task.completedAt === null || task.completedAt === '0' ? 'open' : 'completed';
}

/** Collect platform-shaped inputs for Core's generic reconcileProjection Module. */
export async function collectTaskV2ReconciliationSnapshot({ core, gateway, tasks } = {}) {
  if (!core || typeof core.query !== 'function' || typeof core.externalLinks?.query !== 'function') {
    throw new TypeError('core must provide query and externalLinks Interfaces');
  }
  if (!gateway || typeof gateway.findTasksByCoreTaskId !== 'function') {
    throw new TypeError('gateway.findTasksByCoreTaskId must be a function');
  }
  const coreTasks = tasks ?? core.query({ limit: 100 });
  if (!Array.isArray(coreTasks)) throw new TypeError('tasks must be an array');

  const expected = [];
  const actual = [];
  const missingLinks = [];
  const linkMismatches = [];
  for (const [index, taskValue] of coreTasks.entries()) {
    const task = requireRecord(taskValue, `tasks[${index}]`);
    expected.push({ key: task.id, state: projectionStateFromCore(task) });
    const links = core.externalLinks.query({ taskId: task.id, backend: TASK_V2_LINK_BACKEND });
    if (links.length === 0) missingLinks.push({ taskId: task.id });
    const discovered = await gateway.findTasksByCoreTaskId(task.id);
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
  });
}
