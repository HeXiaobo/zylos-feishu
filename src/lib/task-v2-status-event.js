import { TASK_V2_LINK_BACKEND, TASK_V2_PROJECTION } from './task-v2-projection.js';

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

function normalizeEventTypes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('event.event_types must be a non-empty array');
  }
  const eventTypes = value.map((eventType, index) => (
    requireText(eventType, `event.event_types[${index}]`)
  ));
  if (new Set(eventTypes).size !== eventTypes.length) {
    throw new TypeError('event.event_types must not contain duplicates');
  }
  return Object.freeze(eventTypes);
}

export function normalizeTaskV2StatusEvent(eventInput) {
  const input = requireRecord(eventInput, 'Task v2 status event');
  const payload = input.event === undefined
    ? input
    : requireRecord(input.event, 'Task v2 status event.event');
  const header = input.header === undefined
    ? {}
    : requireRecord(input.header, 'Task v2 status event.header');
  const eventTypes = normalizeEventTypes(payload.event_types);
  return Object.freeze({
    event_id: requireText(payload.event_id ?? header.event_id, 'event.event_id'),
    task_id: requireText(payload.task_guid ?? payload.task_id, 'event.task_guid'),
    app_id: requireText(payload.app_id ?? header.app_id, 'event.app_id'),
    ...(eventTypes === undefined ? {} : { event_types: eventTypes }),
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

function withReconciliationSignal(result, eventTypes) {
  const reconciliationEventTypes = eventTypes?.filter(
    eventType => eventType !== 'task_completed_update',
  ) ?? [];
  return Object.freeze({
    ...result,
    ...(reconciliationEventTypes.length === 0
      ? {}
      : { reconciliationEventTypes: Object.freeze(reconciliationEventTypes) }),
  });
}

function permanentMapperError(message) {
  const error = new TypeError(message);
  error.retryable = false;
  return error;
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

/** Restore the canonical Core projection for a durable non-completion commit. */
export function createTaskV2StatusReconciler({ core, projection, appId } = {}) {
  if (!core || typeof core.externalLinks?.query !== 'function') {
    throw new TypeError('core.externalLinks.query must be a function');
  }
  if (!projection || typeof projection.publishBatch !== 'function') {
    throw new TypeError('projection.publishBatch must be a function');
  }
  const expectedAppId = requireText(appId, 'appId');
  return Object.freeze({
    async handle(eventInput) {
      const event = normalizeTaskV2StatusEvent(eventInput);
      if (event.app_id !== expectedAppId) {
        throw new TypeError('Task v2 reconciliation event belongs to another App');
      }
      if (!event.event_types) {
        throw new TypeError('Task v2 reconciliation event requires event_types');
      }
      const link = core.externalLinks.query({
        backend: TASK_V2_LINK_BACKEND,
        externalId: event.task_id,
      });
      if (!link) {
        return Object.freeze({
          status: 'unlinked',
          sourceEventId: event.event_id,
          taskGuid: event.task_id,
          eventTypes: event.event_types,
        });
      }
      const receipts = await projection.publishBatch({
        deliveries: [{
          projection: TASK_V2_PROJECTION,
          event: { taskId: link.taskId },
        }],
      });
      if (!Array.isArray(receipts) || receipts.length !== 1) {
        throw new TypeError('Task v2 status reconciliation requires exactly one receipt');
      }
      const receipt = requireRecord(receipts[0], 'Task v2 status reconciliation receipt');
      return Object.freeze({
        status: 'reconciled',
        sourceEventId: event.event_id,
        taskId: link.taskId,
        taskGuid: event.task_id,
        eventTypes: event.event_types,
        receipt,
      });
    },
  });
}

/**
 * Convert an App-owned Task status event back into Core commands.
 *
 * Feishu's binary completion signal can start an untouched task, then the Core
 * external Task mapper owns the review command semantics. This Module never
 * constructs AcceptTask. Uncompletion is projection drift repaired from Core,
 * not a RequestChanges shortcut.
 */
export function createTaskV2StatusEventHandler({
  core,
  gateway,
  appId,
  mapExternalTaskEvent,
} = {}) {
  if (
    !core || typeof core.query !== 'function' || typeof core.command !== 'function'
    || typeof core.externalLinks?.query !== 'function'
  ) {
    throw new TypeError('core must provide query, command, and externalLinks Interfaces');
  }
  if (!gateway || typeof gateway.getTask !== 'function') {
    throw new TypeError('gateway.getTask must be a function');
  }
  if (typeof mapExternalTaskEvent !== 'function') {
    throw new TypeError('mapExternalTaskEvent must be a function');
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
      if (event.event_types && !event.event_types.includes('task_completed_update')) {
        return Object.freeze({
          status: 'reconciliation_required',
          taskGuid,
          eventTypes: event.event_types,
        });
      }
      const link = core.externalLinks.query({
        backend: TASK_V2_LINK_BACKEND,
        externalId: taskGuid,
      });
      if (!link) return withReconciliationSignal(
        { status: 'unlinked', taskGuid },
        event.event_types,
      );

      const remoteTask = await gateway.getTask(taskGuid);
      if (remoteTask.completedAt === null || remoteTask.completedAt === '0') {
        return withReconciliationSignal(
          { status: 'ignored_uncompleted', taskId: link.taskId, taskGuid },
          event.event_types,
        );
      }
      let task = core.query({ taskId: link.taskId });
      if (!task) throw new Error(`Core task not found for Task v2 GUID: ${taskGuid}`);
      const commands = [];
      let mappedSubmission = null;
      if (task.state === 'ready' || task.state === 'in_progress') {
        const actorId = task.assigneeId ?? task.ownerId;
        const expectedVersion = task.version + (task.state === 'ready' ? 1 : 0);
        mappedSubmission = mapExternalTaskEvent({
          backend: TASK_V2_LINK_BACKEND,
          eventId,
          eventType: 'completed',
          taskId: task.id,
          actorId,
          expectedVersion,
        });
        if (mappedSubmission?.command?.type !== 'SubmitForReview') {
          throw permanentMapperError(
            'Core external Task mapper must produce only SubmitForReview',
          );
        }
        if (
          mappedSubmission.command.taskId !== task.id
          || mappedSubmission.command.actorId !== actorId
          || mappedSubmission.expectedVersion !== expectedVersion
        ) {
          throw permanentMapperError(
            'Core external Task mapper must preserve task identity, actor, and version',
          );
        }
      }
      if (task.state === 'ready') {
        const started = taskCommand(core, task, 'StartTask', eventId, 'start');
        commands.push('StartTask');
        task = started.task;
      }
      if (task.state === 'in_progress') {
        const submitted = core.command(
          mappedSubmission.command,
          mappedSubmission.expectedVersion,
        );
        commands.push('SubmitForReview');
        task = submitted.task;
      }
      if (task.state === 'review') {
        return withReconciliationSignal({
          status: commands.length > 0 ? 'submitted_for_review' : 'already_in_review',
          taskId: task.id,
          taskGuid,
          commands: Object.freeze(commands),
          state: task.state,
        }, event.event_types);
      }
      return withReconciliationSignal({
        status: 'terminal_ignored',
        taskId: task.id,
        taskGuid,
        commands: Object.freeze(commands),
        state: task.state,
      }, event.event_types);
    },
  });
}
