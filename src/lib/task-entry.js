import {
  mapFeishuTaskAction,
  mapFeishuTaskIntent,
} from './commitment-mapper.js';

const TASK_SUBCOMMAND_BY_COMMAND_TYPE = Object.freeze({
  StartTask: 'start',
  SubmitForReview: 'submit',
  AcceptTask: 'accept',
  RequestChanges: 'rework',
  CancelTask: 'cancel',
  ReopenTask: 'reopen',
});
const CREATE_PAYLOAD_FIELDS = Object.freeze([
  'title',
  'description',
  'acceptorId',
  'assigneeId',
  'dueAt',
  'reminderMinutesBeforeDue',
]);
const ACTION_PAYLOAD_FIELDS = Object.freeze(['action', 'context']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function parsePayload(payloadJson) {
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new TypeError('explicit task payload must be valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('explicit task payload must be an object');
  }
  return payload;
}

function requirePayloadFields(payload, allowedFields, requiredFields) {
  const keys = Object.keys(payload);
  if (keys.some((key) => !allowedFields.includes(key))) {
    throw new TypeError('explicit task payload has unsupported fields');
  }
  if (requiredFields.some((key) => !Object.hasOwn(payload, key))) {
    throw new TypeError('explicit task payload is missing required fields');
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

export function isExplicitTaskProtocolMessage({ messageType, text }) {
  if (messageType !== 'text' || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return /^\/zylos-task(?:$|\s)/.test(trimmed);
}

export function parseExplicitTaskMessage(
  { messageType, text, messageId, actorId },
  { verifyTaskActionContext } = {},
) {
  if (!isExplicitTaskProtocolMessage({ messageType, text })) return null;
  const match = text.trim().match(/^\/zylos-task\s+(create|action)\s+(.+)$/s);
  if (!match) throw new TypeError('explicit task protocol is malformed');
  const [, operation, payloadJson] = match;
  const payload = parsePayload(payloadJson);

  if (operation === 'create') {
    requirePayloadFields(payload, CREATE_PAYLOAD_FIELDS, ['title']);
    return {
      kind: 'task-intent',
      taskEnvelope: mapFeishuTaskIntent({
        messageId,
        senderId: actorId,
        title: payload.title,
        description: payload.description,
        ownerId: actorId,
        acceptorId: payload.acceptorId,
        assigneeId: payload.assigneeId,
        dueAt: payload.dueAt,
        reminderMinutesBeforeDue: payload.reminderMinutesBeforeDue,
      }),
    };
  }

  if (typeof verifyTaskActionContext !== 'function') {
    throw new TypeError('signed task actions are not configured');
  }
  requirePayloadFields(payload, ACTION_PAYLOAD_FIELDS, ACTION_PAYLOAD_FIELDS);
  const action = requireText(payload.action, 'action');
  const context = requireText(payload.context, 'context');
  const claims = verifyTaskActionContext(context);
  return {
    kind: 'task-action',
    ...mapFeishuTaskAction({
      eventId: messageId,
      action,
      taskId: claims.taskId,
      actorId,
      expectedVersion: claims.expectedVersion,
    }),
  };
}

export function buildC4ReceiveArgs({
  receiverPath,
  source,
  endpoint,
  content,
  priority,
  taskEnvelope,
  assistantRequest,
  workIntakeEnvelope,
  workIntakeConfirmation,
  workIntakeConfirmationEffect,
}) {
  if (taskEnvelope && assistantRequest) {
    throw new TypeError('taskEnvelope and assistantRequest are mutually exclusive');
  }
  const args = [
    receiverPath,
    '--channel', source,
    '--endpoint', endpoint,
    '--json',
  ];
  if (priority !== undefined) {
    if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
      throw new TypeError('priority must be an integer 1, 2, or 3');
    }
    args.push('--priority', String(priority));
  }
  if (taskEnvelope) {
    args.push('--task-envelope-json', JSON.stringify(taskEnvelope));
  }
  if (assistantRequest) {
    const request = requireRecord(assistantRequest, 'assistantRequest');
    requirePayloadFields(request, ['requestId', 'sourceId', 'requireIdle'], ['requestId', 'sourceId']);
    args.push(
      '--assistant-request-id', requireText(request.requestId, 'assistantRequest.requestId'),
      '--assistant-source-id', requireText(request.sourceId, 'assistantRequest.sourceId'),
    );
    if (request.requireIdle !== undefined && typeof request.requireIdle !== 'boolean') {
      throw new TypeError('assistantRequest.requireIdle must be a boolean');
    }
    if (request.requireIdle !== false) args.push('--block-queue-until-idle');
  }
  if (workIntakeEnvelope) {
    args.push('--work-intake-envelope-json', JSON.stringify(workIntakeEnvelope));
  }
  if (workIntakeConfirmation) {
    args.push('--work-intake-confirmation-json', JSON.stringify(workIntakeConfirmation));
  }
  if (workIntakeConfirmationEffect) {
    args.push(
      '--work-intake-confirmation-effect-json',
      JSON.stringify(workIntakeConfirmationEffect),
    );
  }
  if ([
    taskEnvelope,
    workIntakeEnvelope,
    workIntakeConfirmation,
    workIntakeConfirmationEffect,
  ].filter(Boolean).length > 1) {
    throw new TypeError('task and WorkIntake protocols are mutually exclusive');
  }
  args.push('--content', content);
  return args;
}

export function buildZylosTaskCommandArgs({ command, expectedVersion }) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('command must be an object');
  }
  const commandType = requireText(command.type, 'command.type');
  const subcommand = TASK_SUBCOMMAND_BY_COMMAND_TYPE[commandType];
  if (!subcommand) throw new TypeError('command.type is unsupported');
  const taskId = requireText(command.taskId, 'command.taskId');
  const actorId = requireText(command.actorId, 'command.actorId');
  const idempotencyKey = requireText(command.idempotencyKey, 'command.idempotencyKey');
  requirePositiveInteger(expectedVersion, 'expectedVersion');

  return [
    'task', subcommand, taskId,
    '--actor', actorId,
    '--expected-version', String(expectedVersion),
    '--idempotency-key', idempotencyKey,
    '--json',
  ];
}
