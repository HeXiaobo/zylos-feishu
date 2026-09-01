const REQUEST_FIELDS = new Set([
  'requestId',
  'turnId',
  'sourceKey',
  'source',
  'actor',
  'actorAssertion',
  'origin',
  'originEffectId',
  'capability',
  'intent',
]);
const SOURCE_FIELDS = new Set(['adapterId', 'accountRef', 'eventType', 'eventId', 'messageId']);
const ACTOR_FIELDS = new Set(['provider', 'tenantRef', 'externalId', 'provenance']);
const CREATE_FIELDS = new Set([
  'command',
  'title',
  'description',
  'dueAt',
  'reminderMinutesBeforeDue',
]);
const COMMAND_FIELDS = new Set([
  'taskId',
  'command',
  'expectedVersion',
  'reminderMinutesBeforeDue',
]);
const ORIGINS = new Set(['assistant_tool', 'structured_action', 'native_task_projection']);
const COMMAND_CAPABILITIES = Object.freeze({
  CreateTask: 'task.create',
  StartTask: 'task.start',
  SubmitForReview: 'task.submit_for_review',
  AcceptTask: 'task.accept',
  RequestChanges: 'task.request_changes',
  CancelTask: 'task.cancel',
  ReopenTask: 'task.reopen',
  UpdateTaskReminder: 'task.update',
});

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

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

function rejectUnknownFields(value, allowed, field) {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new TypeError(`unsupported ${field} field: ${unknown}`);
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('task intent.expectedVersion must be a positive integer');
  }
  return value;
}

function normalizeSource(value) {
  const source = requireRecord(value, 'task command source');
  rejectUnknownFields(source, SOURCE_FIELDS, 'task command source');
  const normalized = {};
  for (const field of SOURCE_FIELDS) normalized[field] = requireText(source[field], `source.${field}`);
  if (normalized.adapterId !== 'feishu') {
    throw domainError('UNSUPPORTED_CAPABILITY', 'TaskCommandPort supports only Feishu task capability');
  }
  return normalized;
}

function normalizeActor(value) {
  const actor = requireRecord(value, 'task command actor');
  rejectUnknownFields(actor, ACTOR_FIELDS, 'task command actor');
  if (actor.provenance !== 'verified_channel_actor') {
    throw domainError('UNVERIFIED_ACTOR', 'actor provenance is not verified_channel_actor');
  }
  return {
    provider: requireText(actor.provider, 'actor.provider'),
    tenantRef: requireText(actor.tenantRef, 'actor.tenantRef'),
    externalId: requireText(actor.externalId, 'actor.externalId'),
    provenance: 'verified_channel_actor',
  };
}

function normalizeIntent(value) {
  const intent = requireRecord(value, 'task intent');
  const command = requireText(intent.command, 'task intent.command');
  const fields = command === 'CreateTask' ? CREATE_FIELDS : COMMAND_FIELDS;
  rejectUnknownFields(intent, fields, 'task intent');
  const requiredCapability = COMMAND_CAPABILITIES[command];
  if (!requiredCapability) throw domainError('INVALID_COMMAND', `unsupported task command: ${command}`);
  if (command === 'CreateTask') {
    return {
      intent: structuredClone(intent),
      command,
      requiredCapability,
      taskId: null,
      expectedVersion: 0,
    };
  }
  return {
    intent: structuredClone(intent),
    command,
    requiredCapability,
    taskId: requireText(intent.taskId, 'task intent.taskId'),
    expectedVersion: requireVersion(intent.expectedVersion),
  };
}

/**
 * Feishu's one TaskCommandPort. It accepts verified channel provenance and a
 * channel-neutral task intent, issues a trusted Core assertion through an
 * injected authority, and hides Core's two application operations from every
 * WorkIntake/tool/native-task caller.
 */
export function createFeishuTaskCommandPort({ taskCore } = {}) {
  if (!taskCore || typeof taskCore.acceptIntent !== 'function'
      || typeof taskCore.executeCommand !== 'function') {
    throw new TypeError('taskCore must provide acceptIntent and executeCommand');
  }
  return Object.freeze({
    submit(input) {
      const request = requireRecord(input, 'TaskCommandPort request');
      rejectUnknownFields(request, REQUEST_FIELDS, 'TaskCommandPort request');
      const requestId = requireText(request.requestId, 'requestId');
      const turnId = requireText(request.turnId, 'turnId');
      const sourceKey = requireText(request.sourceKey, 'sourceKey');
      const source = normalizeSource(request.source);
      const actor = normalizeActor(request.actor);
      const assertion = request.actorAssertion;
      if (!assertion || (typeof assertion !== 'object' && typeof assertion !== 'function')) {
        throw domainError('UNVERIFIED_ACTOR', 'actorAssertion must come from the trusted authority');
      }
      const origin = requireText(request.origin, 'origin');
      if (!ORIGINS.has(origin)) throw domainError('INVALID_ORIGIN', `unsupported origin: ${origin}`);
      const normalized = normalizeIntent(request.intent);
      const capability = requireText(request.capability, 'capability');
      if (capability !== normalized.requiredCapability) {
        throw domainError('CAPABILITY_MISMATCH', 'capability does not match task command');
      }
      const originEffectId = request.originEffectId === undefined || request.originEffectId === null
        ? null
        : requireText(request.originEffectId, 'originEffectId');
      if ((origin === 'native_task_projection') !== (originEffectId !== null)) {
        throw domainError(
          'INVALID_ORIGIN',
          'native_task_projection requires originEffectId and other origins forbid it',
        );
      }
      if (normalized.command === 'CreateTask') {
        return taskCore.acceptIntent(requestId, turnId, sourceKey, assertion, normalized.intent);
      }
      const command = normalized.command === 'UpdateTaskReminder'
        ? {
          type: normalized.command,
          reminderMinutesBeforeDue: normalized.intent.reminderMinutesBeforeDue,
        }
        : normalized.command;
      return taskCore.executeCommand(
        requestId,
        turnId,
        sourceKey,
        assertion,
        normalized.taskId,
        command,
        normalized.expectedVersion,
        capability,
      );
    },
  });
}
