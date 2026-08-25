import { mapFeishuTaskAction } from './commitment-mapper.js';

const ACTIONS_BY_STATE = Object.freeze({
  ready: Object.freeze([
    Object.freeze({ action: 'start', label: '开始执行', type: 'primary' }),
    Object.freeze({ action: 'cancel', label: '取消任务', type: 'default' }),
  ]),
  in_progress: Object.freeze([
    Object.freeze({ action: 'submit', label: '提交验收', type: 'primary' }),
    Object.freeze({ action: 'cancel', label: '取消任务', type: 'default' }),
  ]),
  review: Object.freeze([
    Object.freeze({ action: 'accept', label: '验收通过', type: 'primary' }),
    Object.freeze({ action: 'request_changes', label: '退回修改', type: 'default' }),
  ]),
  done: Object.freeze([]),
  cancelled: Object.freeze([]),
});
const TASK_FIELDS = Object.freeze([
  'id',
  'title',
  'description',
  'state',
  'ownerId',
  'acceptorId',
  'assigneeId',
  'dueAt',
  'version',
  'createdAt',
  'updatedAt',
]);
const MAX_LENGTH = Object.freeze({
  identifier: 256,
  title: 256,
  description: 4_000,
});
const RENDERER_OPTION_FIELDS = Object.freeze([
  'issueTaskActionContext',
  'clock',
  'actionContextTtlMs',
]);
const MAX_ACTION_TTL_MS = 24 * 60 * 60_000;
const MAX_CARD_BYTES = 30_000;
const ACTION_CONTEXT_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const CALLBACK_FIELDS = Object.freeze(['eventId', 'actorId', 'action']);
const CALLBACK_ACTION_FIELDS = Object.freeze(['tag', 'value']);
const CALLBACK_VALUE_FIELDS = Object.freeze(['action', 'context']);
const CALLBACK_OPTION_FIELDS = Object.freeze(['verifyTaskActionContext']);
const ACTION_CONTEXT_CLAIM_FIELDS = Object.freeze([
  'taskId',
  'expectedVersion',
  'expiresAt',
]);
const CARD_ACTIONS = new Set(
  Object.values(ACTIONS_BY_STATE)
    .flat()
    .map((definition) => definition.action),
);
const EXECUTION_ACTIONS = new Set(['start', 'submit']);
const PRESENTATION_BY_STATE = Object.freeze({
  ready: Object.freeze({ title: '任务待开始', template: 'blue', label: '待开始' }),
  in_progress: Object.freeze({ title: '任务执行中', template: 'blue', label: '执行中' }),
  review: Object.freeze({ title: '任务待验收', template: 'orange', label: '待验收' }),
  done: Object.freeze({ title: '任务已完成', template: 'green', label: '已完成' }),
  cancelled: Object.freeze({ title: '任务已取消', template: 'grey', label: '已取消' }),
});

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, allowedFields, field) {
  const keys = Object.keys(value);
  if (
    keys.length !== allowedFields.length
    || !allowedFields.every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireFieldsWithOptional(value, requiredFields, optionalFields, field) {
  const keys = Object.keys(value);
  if (
    requiredFields.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !requiredFields.includes(key) && !optionalFields.includes(key))
  ) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireBoundedText(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function optionalBoundedText(value, field, maxLength) {
  if (value === null) return null;
  return requireBoundedText(value, field, maxLength);
}

function requireTimestamp(value, field) {
  const timestamp = requireBoundedText(value, field, 40);
  try {
    if (new Date(timestamp).toISOString() !== timestamp) throw new Error();
  } catch {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function normalizeTask(input) {
  const task = requireRecord(input, 'task');
  requireFieldsWithOptional(
    task,
    TASK_FIELDS.filter((field) => field !== 'dueAt'),
    ['dueAt'],
    'task',
  );
  const state = requireBoundedText(task.state, 'task.state', 32);
  if (!Object.hasOwn(ACTIONS_BY_STATE, state)) {
    throw new TypeError('task.state is unsupported');
  }
  if (!Number.isSafeInteger(task.version) || task.version < 1) {
    throw new TypeError('task.version must be a positive integer');
  }

  return {
    id: requireBoundedText(task.id, 'task.id', MAX_LENGTH.identifier),
    title: requireBoundedText(task.title, 'task.title', MAX_LENGTH.title),
    description: optionalBoundedText(
      task.description,
      'task.description',
      MAX_LENGTH.description,
    ),
    state,
    ownerId: requireBoundedText(task.ownerId, 'task.ownerId', MAX_LENGTH.identifier),
    acceptorId: requireBoundedText(
      task.acceptorId,
      'task.acceptorId',
      MAX_LENGTH.identifier,
    ),
    assigneeId: optionalBoundedText(
      task.assigneeId,
      'task.assigneeId',
      MAX_LENGTH.identifier,
    ),
    dueAt: task.dueAt === undefined || task.dueAt === null
      ? null
      : requireTimestamp(task.dueAt, 'task.dueAt'),
    version: task.version,
    createdAt: requireTimestamp(task.createdAt, 'task.createdAt'),
    updatedAt: requireTimestamp(task.updatedAt, 'task.updatedAt'),
  };
}

function normalizeRendererOptions(input) {
  const options = requireRecord(input, 'renderer options');
  requireExactFields(options, RENDERER_OPTION_FIELDS, 'renderer options');
  if (typeof options.issueTaskActionContext !== 'function') {
    throw new TypeError('issueTaskActionContext must be a function');
  }
  if (typeof options.clock !== 'function') {
    throw new TypeError('clock must be a function');
  }
  if (
    !Number.isSafeInteger(options.actionContextTtlMs)
    || options.actionContextTtlMs < 1
    || options.actionContextTtlMs > MAX_ACTION_TTL_MS
  ) {
    throw new TypeError(`actionContextTtlMs must be between 1 and ${MAX_ACTION_TTL_MS}`);
  }
  return options;
}

function readNow(clock, ttlMs) {
  const now = clock();
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || now > Number.MAX_SAFE_INTEGER - ttlMs
  ) {
    throw new TypeError('clock must return a safe Unix epoch millisecond');
  }
  return now;
}

function requireActionContext(value) {
  if (
    typeof value !== 'string'
    || value.length > 4_096
    || !ACTION_CONTEXT_PATTERN.test(value)
  ) {
    throw new TypeError('issued task action context is invalid');
  }
  return value;
}

function normalizeVerifiedClaims(input) {
  const claims = requireRecord(input, 'verified task action context');
  requireExactFields(
    claims,
    ACTION_CONTEXT_CLAIM_FIELDS,
    'verified task action context',
  );
  if (!Number.isSafeInteger(claims.expectedVersion) || claims.expectedVersion < 1) {
    throw new TypeError('verified expectedVersion must be a positive integer');
  }
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt < 1) {
    throw new TypeError('verified expiresAt must be a positive integer');
  }
  return {
    taskId: requireBoundedText(
      claims.taskId,
      'verified taskId',
      MAX_LENGTH.identifier,
    ),
    expectedVersion: claims.expectedVersion,
    expiresAt: claims.expiresAt,
  };
}

function actionButton(definition, context) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: definition.label },
    type: definition.type,
    behaviors: [{
      type: 'callback',
      value: {
        action: definition.action,
        context,
      },
    }],
  };
}

function actionsForAcceptorDm(task) {
  const definitions = ACTIONS_BY_STATE[task.state];
  const executionActorId = task.assigneeId ?? task.ownerId;
  return definitions.filter((definition) => (
    !EXECUTION_ACTIONS.has(definition.action) || task.acceptorId === executionActorId
  ));
}

/**
 * Create a side-effect-free Feishu card renderer for strict Commitment Core
 * task snapshots. Visible actions are interaction hints only: the trusted
 * callback identity and Commitment Core remain the authorization authority.
 */
export function createTaskReviewCardRenderer(input) {
  const {
    issueTaskActionContext,
    clock,
    actionContextTtlMs,
  } = normalizeRendererOptions(input);

  return Object.freeze({
    render(input) {
      const task = normalizeTask(input);
      const expiresAt = readNow(clock, actionContextTtlMs) + actionContextTtlMs;
      const actions = actionsForAcceptorDm(task).map((definition) => {
        const context = requireActionContext(
          issueTaskActionContext({
            taskId: task.id,
            expectedVersion: task.version,
            expiresAt,
          }),
        );
        return actionButton(definition, context);
      });

      const presentation = PRESENTATION_BY_STATE[task.state];
      const elements = [
        {
          tag: 'div',
          text: { tag: 'plain_text', content: `任务：${task.title}` },
        },
      ];
      if (task.description !== null) {
        elements.push({
          tag: 'div',
          text: { tag: 'plain_text', content: `说明：${task.description}` },
        });
      }
      elements.push({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: [
            `状态：${presentation.label}`,
            `任务 ID：${task.id}`,
            `版本：${task.version}`,
            `负责人：${task.ownerId}`,
            `验收人：${task.acceptorId}`,
            `执行人：${task.assigneeId ?? '未分配'}`,
            `截止时间：${task.dueAt ?? '未设置'}`,
            `更新时间：${task.updatedAt}`,
          ].join('\n'),
        },
      });
      elements.push(...actions);

      const card = {
        schema: '2.0',
        config: { update_multi: true, width_mode: 'fill' },
        header: {
          template: presentation.template,
          title: { tag: 'plain_text', content: presentation.title },
        },
        body: { elements },
      };
      if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES) {
        throw new TypeError('rendered task card exceeds the size limit');
      }
      return card;
    },
  });
}

/**
 * Adapt a normalized, authenticated Feishu card.action callback to the same
 * Core command route used by the explicit task protocol. The caller must take
 * actorId from the verified Feishu callback, never from button value data.
 */
export function parseTaskReviewCardAction(input, options) {
  const payload = requireRecord(input, 'card action payload');
  requireExactFields(payload, CALLBACK_FIELDS, 'card action payload');
  const action = requireRecord(payload.action, 'card action payload.action');
  requireExactFields(action, CALLBACK_ACTION_FIELDS, 'card action payload.action');
  if (action.tag !== 'button') {
    throw new TypeError('card action payload.action.tag must be button');
  }
  const value = requireRecord(action.value, 'card action payload.action.value');
  requireExactFields(value, CALLBACK_VALUE_FIELDS, 'card action payload.action.value');
  const actionName = requireBoundedText(value.action, 'card action', 32);
  if (!CARD_ACTIONS.has(actionName)) {
    throw new TypeError('card action is unsupported');
  }
  const normalizedOptions = requireRecord(options, 'card action options');
  requireExactFields(normalizedOptions, CALLBACK_OPTION_FIELDS, 'card action options');
  if (typeof normalizedOptions.verifyTaskActionContext !== 'function') {
    throw new TypeError('verifyTaskActionContext must be a function');
  }
  const context = requireActionContext(value.context);
  const claims = normalizeVerifiedClaims(
    normalizedOptions.verifyTaskActionContext(context),
  );

  return {
    kind: 'task-action',
    ...mapFeishuTaskAction({
      eventId: requireBoundedText(payload.eventId, 'eventId', MAX_LENGTH.identifier),
      actorId: requireBoundedText(payload.actorId, 'actorId', MAX_LENGTH.identifier),
      action: actionName,
      taskId: claims.taskId,
      expectedVersion: claims.expectedVersion,
    }),
  };
}
