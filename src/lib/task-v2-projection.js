import { createHash } from 'node:crypto';

export const TASK_V2_PROJECTION = 'feishu-task-v2';
export const TASK_V2_LINK_BACKEND = 'feishu-task-v2';

const PERMANENT_LINK_ERRORS = new Set([
  'EXTERNAL_LINK_CONFLICT',
  'FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'TASK_NOT_FOUND',
]);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stableClientToken(parts) {
  return `zt2_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
}

export class TaskV2ProjectionError extends Error {
  constructor(message, { retryable = true, cause } = {}) {
    super(message, { cause });
    this.name = 'TaskV2ProjectionError';
    this.retryable = retryable;
  }
}

function permanentFailure(message, cause) {
  return new TaskV2ProjectionError(message, { retryable: false, cause });
}

function requireDeliveries(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('deliveries must be a non-empty array');
  }
  for (const [index, delivery] of value.entries()) {
    requireRecord(delivery, `deliveries[${index}]`);
    if (delivery.projection !== TASK_V2_PROJECTION) {
      throw new TypeError(`deliveries[${index}].projection must be ${TASK_V2_PROJECTION}`);
    }
  }
  return value;
}

function validateRemoteTask(value, operation) {
  const task = requireRecord(value, `${operation} result`);
  return Object.freeze({
    guid: requireText(task.guid, `${operation} result.guid`),
    url: requireText(task.url, `${operation} result.url`),
  });
}

function linkRemoteTask(core, task, remote) {
  try {
    return core.externalLinks.link({
      taskId: task.id,
      actorId: task.ownerId,
      backend: TASK_V2_LINK_BACKEND,
      externalId: remote.guid,
      idempotencyKey: `zylos:feishu-task-v2:link:${task.id}:${remote.guid}`,
    });
  } catch (error) {
    if (error instanceof TypeError || PERMANENT_LINK_ERRORS.has(error?.code)) {
      throw permanentFailure(
        `Task v2 GUID cannot be linked to Core task ${task.id}: ${error.message}`,
        error,
      );
    }
    throw error;
  }
}

/**
 * Deep Card-independent Task v2 projection Module.
 *
 * Its one worker Interface is publishBatch. Permanent identity comes from the
 * Core ExternalLink; client_token only protects the short remote create/link
 * window. Before creating without a link, the Module searches the App-owned
 * marker so a delayed replay can adopt an already-created Task GUID.
 */
export function createTaskV2Projection({ core, gateway, memberMapper } = {}) {
  if (
    !core || typeof core.query !== 'function'
    || typeof core.externalLinks?.query !== 'function'
    || typeof core.externalLinks?.link !== 'function'
  ) {
    throw new TypeError('core must provide query and externalLinks Interfaces');
  }
  const remote = requireRecord(gateway, 'gateway');
  for (const operation of ['createTask', 'updateTask', 'findTasksByCoreTaskId']) {
    if (typeof remote[operation] !== 'function') {
      throw new TypeError(`gateway.${operation} must be a function`);
    }
  }
  if (!memberMapper || typeof memberMapper.map !== 'function') {
    throw new TypeError('memberMapper.map must be a function');
  }

  async function update(task, taskGuid, members) {
    return validateRemoteTask(await remote.updateTask({
      taskGuid,
      task,
      members,
      clientToken: stableClientToken(['update', task.id, task.version]),
    }), 'gateway.updateTask');
  }

  async function publishOne(delivery) {
    const taskId = requireText(delivery.event?.taskId, 'delivery.event.taskId');
    const task = core.query({ taskId });
    if (!task) throw permanentFailure(`Core task not found: ${taskId}`);
    let members;
    try {
      members = memberMapper.map(task);
    } catch (error) {
      throw permanentFailure(`Task v2 member mapping failed for ${taskId}: ${error.message}`, error);
    }

    const links = core.externalLinks.query({ taskId, backend: TASK_V2_LINK_BACKEND });
    if (links.length > 1) throw permanentFailure(`multiple Task v2 links found for ${taskId}`);
    if (links.length === 1) {
      const updated = await update(task, links[0].externalId, members);
      return Object.freeze({
        taskId,
        taskGuid: updated.guid,
        url: updated.url,
        created: false,
        recovered: false,
      });
    }

    const discovered = await remote.findTasksByCoreTaskId(taskId);
    if (!Array.isArray(discovered)) {
      throw new TypeError('gateway.findTasksByCoreTaskId must return an array');
    }
    if (discovered.length > 1) {
      const guids = discovered.map(item => item?.guid).filter(Boolean).join(', ');
      throw permanentFailure(`duplicate Task v2 GUIDs found for ${taskId}: ${guids}`);
    }
    if (discovered.length === 1) {
      const found = validateRemoteTask(discovered[0], 'gateway.findTasksByCoreTaskId');
      linkRemoteTask(core, task, found);
      const updated = await update(task, found.guid, members);
      return Object.freeze({
        taskId,
        taskGuid: updated.guid,
        url: updated.url,
        created: false,
        recovered: true,
      });
    }

    const created = validateRemoteTask(await remote.createTask({
      task,
      members,
      clientToken: stableClientToken(['create', task.id]),
    }), 'gateway.createTask');
    linkRemoteTask(core, task, created);
    return Object.freeze({
      taskId,
      taskGuid: created.guid,
      url: created.url,
      created: true,
      recovered: false,
    });
  }

  return Object.freeze({
    async publishBatch({ deliveries } = {}) {
      const receipts = [];
      for (const delivery of requireDeliveries(deliveries)) {
        receipts.push(await publishOne(delivery));
      }
      return Object.freeze(receipts);
    },
  });
}
