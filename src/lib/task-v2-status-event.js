import { TASK_V2_LINK_BACKEND } from './task-v2-projection.js';

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

export function normalizeTaskV2StatusEvent(eventInput) {
  const input = requireRecord(eventInput, 'Task v2 status event');
  const payload = input.event === undefined
    ? input
    : requireRecord(input.event, 'Task v2 status event.event');
  const header = input.header === undefined
    ? {}
    : requireRecord(input.header, 'Task v2 status event.header');
  return Object.freeze({
    event_id: requireText(payload.event_id ?? header.event_id, 'event.event_id'),
    task_id: requireText(payload.task_id, 'event.task_id'),
    app_id: requireText(payload.app_id ?? header.app_id, 'event.app_id'),
  });
}

function taskCommand(core, task, type, eventId, phase) {
  return core.command({
    type,
    taskId: task.id,
    actorId: task.assigneeId ?? task.ownerId,
    idempotencyKey: `feishu-task-v2:${eventId}:${phase}`,
  }, task.version);
}

export function createTaskV2StatusEventIngestor({ inbox, appId } = {}) {
  if (!inbox || typeof inbox.enqueue !== 'function') {
    throw new TypeError('inbox.enqueue must be a function');
  }
  const expectedAppId = requireText(appId, 'appId');
  return Object.freeze({
    handle(eventInput) {
      const event = normalizeTaskV2StatusEvent(eventInput);
      if (event.app_id !== expectedAppId) {
        throw new TypeError('Task v2 status event belongs to another App');
      }
      const queued = inbox.enqueue(event);
      return Object.freeze({
        status: 'queued',
        created: queued.created,
        eventId: event.event_id,
        taskGuid: event.task_id,
      });
    },
  });
}

/**
 * Convert an App-owned Task status event back into Core commands.
 *
 * Feishu's binary completion signal can start an untouched task and submit it
 * for review, but this Module never constructs AcceptTask. Uncompletion is a
 * projection drift repaired from Core, not a RequestChanges shortcut.
 */
export function createTaskV2StatusEventHandler({ core, gateway, appId } = {}) {
  if (
    !core || typeof core.query !== 'function' || typeof core.command !== 'function'
    || typeof core.externalLinks?.query !== 'function'
  ) {
    throw new TypeError('core must provide query, command, and externalLinks Interfaces');
  }
  if (!gateway || typeof gateway.getTask !== 'function') {
    throw new TypeError('gateway.getTask must be a function');
  }
  const expectedAppId = requireText(appId, 'appId');

  return Object.freeze({
    async handle(eventInput) {
      const event = normalizeTaskV2StatusEvent(eventInput);
      const eventId = event.event_id;
      const taskGuid = event.task_id;
      if (event.app_id !== expectedAppId) {
        throw new TypeError('Task v2 status event belongs to another App');
      }
      const link = core.externalLinks.query({
        backend: TASK_V2_LINK_BACKEND,
        externalId: taskGuid,
      });
      if (!link) return Object.freeze({ status: 'unlinked', taskGuid });

      const remoteTask = await gateway.getTask(taskGuid);
      if (remoteTask.completedAt === null || remoteTask.completedAt === '0') {
        return Object.freeze({ status: 'ignored_uncompleted', taskId: link.taskId, taskGuid });
      }
      let task = core.query({ taskId: link.taskId });
      if (!task) throw new Error(`Core task not found for Task v2 GUID: ${taskGuid}`);
      const commands = [];
      if (task.state === 'ready') {
        const started = taskCommand(core, task, 'StartTask', eventId, 'start');
        commands.push('StartTask');
        task = started.task;
      }
      if (task.state === 'in_progress') {
        const submitted = taskCommand(core, task, 'SubmitForReview', eventId, 'submit-for-review');
        commands.push('SubmitForReview');
        task = submitted.task;
      }
      if (task.state === 'review') {
        return Object.freeze({
          status: commands.length > 0 ? 'submitted_for_review' : 'already_in_review',
          taskId: task.id,
          taskGuid,
          commands: Object.freeze(commands),
          state: task.state,
        });
      }
      return Object.freeze({
        status: 'terminal_ignored',
        taskId: task.id,
        taskGuid,
        commands: Object.freeze(commands),
        state: task.state,
      });
    },
  });
}
