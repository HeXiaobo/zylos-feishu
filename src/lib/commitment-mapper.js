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
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field);
}

function optionalTimestamp(value, field) {
  if (value === undefined || value === null) return undefined;
  const timestamp = requireText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) {
    throw new TypeError(`${field} must be an RFC 3339 timestamp`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be an RFC 3339 timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

const COMMAND_TYPE_BY_ACTION = Object.freeze({
  start: 'StartTask',
  submit: 'SubmitForReview',
  complete: 'SubmitForReview',
  accept: 'AcceptTask',
  request_changes: 'RequestChanges',
  cancel: 'CancelTask',
  reopen: 'ReopenTask',
});

/**
 * Map an already-authorized and already-classified Feishu task intent to the
 * channel-neutral SourceEnvelope consumed by Commitment Core.
 *
 * Intent detection and I/O deliberately stay outside this Adapter.
 */
export function mapFeishuTaskIntent(input) {
  const {
    messageId: rawMessageId,
    senderId: rawSenderId,
    title: rawTitle,
    description: rawDescription,
    ownerId: rawOwnerId,
    acceptorId: rawAcceptorId,
    assigneeId: rawAssigneeId,
    dueAt: rawDueAt,
    reminderMinutesBeforeDue: rawReminderMinutesBeforeDue,
  } = requireRecord(input, 'task intent');
  const messageId = requireText(rawMessageId, 'messageId');
  const senderId = requireText(rawSenderId, 'senderId');
  const title = requireText(rawTitle, 'title');
  const description = optionalText(rawDescription, 'description');
  const ownerId = requireText(rawOwnerId, 'ownerId');
  const acceptorId = optionalText(rawAcceptorId, 'acceptorId') ?? ownerId;
  const assigneeId = optionalText(rawAssigneeId, 'assigneeId');
  const dueAt = optionalTimestamp(rawDueAt, 'dueAt');
  const reminderMinutesBeforeDue = optionalNonNegativeInteger(
    rawReminderMinutesBeforeDue,
    'reminderMinutesBeforeDue',
  );
  if (reminderMinutesBeforeDue !== undefined && dueAt === undefined) {
    throw new TypeError('reminderMinutesBeforeDue requires dueAt');
  }

  return {
    idempotencyKey: `feishu:${messageId}:task-intent`,
    source: {
      channel: 'feishu',
      externalId: messageId,
      senderId,
    },
    task: {
      title,
      description,
      ownerId,
      acceptorId,
      assigneeId,
      ...(dueAt === undefined ? {} : { dueAt }),
      ...(reminderMinutesBeforeDue === undefined ? {} : { reminderMinutesBeforeDue }),
    },
  };
}

/**
 * Map a normalized Feishu task interaction to a channel-neutral Core command.
 */
export function mapFeishuTaskAction(input) {
  const {
    eventId: rawEventId,
    action: rawAction,
    taskId: rawTaskId,
    actorId: rawActorId,
    expectedVersion: rawExpectedVersion,
  } = requireRecord(input, 'task action');
  const eventId = requireText(rawEventId, 'eventId');
  const action = requireText(rawAction, 'action');
  if (!Object.hasOwn(COMMAND_TYPE_BY_ACTION, action)) {
    throw new TypeError(`action is not supported: ${action}`);
  }
  const taskId = requireText(rawTaskId, 'taskId');
  const actorId = requireText(rawActorId, 'actorId');
  const expectedVersion = requirePositiveInteger(rawExpectedVersion, 'expectedVersion');

  return {
    command: {
      type: COMMAND_TYPE_BY_ACTION[action],
      taskId,
      actorId,
      idempotencyKey: `feishu:${eventId}:task-command`,
    },
    expectedVersion,
  };
}
