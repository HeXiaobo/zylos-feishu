import { createHash } from 'node:crypto';

import {
  createTaskReviewCardRenderer,
  parseTaskReviewCardAction,
} from './task-review-card.js';

const SENDER_OPTION_FIELDS = Object.freeze([
  'sendMessage',
  'issueTaskActionContext',
  'clock',
  'actionContextTtlMs',
]);
const SEND_INPUT_FIELDS = Object.freeze(['receiveId', 'receiveIdType', 'task']);
const RECEIVE_ID_TYPES = new Set(['chat_id', 'open_id', 'user_id', 'union_id']);
const ACTION_RUNTIME_OPTION_FIELDS = Object.freeze([
  'verifyTaskActionContext',
  'executeTaskAction',
]);
const EVENT_HANDLER_OPTION_FIELDS = Object.freeze([
  'handleTaskCardAction',
  'onError',
]);
const MAX_ACTION_IDENTITY_BYTES = 8_192;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (
    keys.length !== fields.length
    || !fields.every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function canonicalJson(value, seen = new Set()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError('card action value must contain JSON values only');
  }
  if (seen.has(value)) {
    throw new TypeError('card action value must not contain cycles');
  }
  seen.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
  } else {
    const keys = Object.keys(value).sort();
    serialized = `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`
    )).join(',')}}`;
  }
  seen.delete(value);
  return serialized;
}

function cardActionEventId({ messageId, actorId, action }) {
  const value = canonicalJson(action.value);
  if (
    Buffer.byteLength(value, 'utf8') > MAX_ACTION_IDENTITY_BYTES
  ) {
    throw new TypeError('card action value exceeds the identity size limit');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([messageId, actorId, action.tag, value]))
    .digest('base64url');
  return `card-${digest}`;
}

function normalizeCardActionEvent(input) {
  const raw = requireRecord(input, 'Feishu card action event');
  const event = raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event)
    ? raw.event
    : raw;
  const isV2 = Object.hasOwn(event, 'operator') || Object.hasOwn(event, 'context');
  const messageId = requireText(
    isV2 ? event.context?.open_message_id : event.open_message_id,
    'Feishu card action message ID',
  );
  const actorId = requireText(
    isV2 ? event.operator?.open_id : event.open_id,
    'Feishu card action operator open ID',
  );
  const rawAction = requireRecord(event.action, 'Feishu card action');
  const action = {
    tag: rawAction.tag,
    value: rawAction.value,
  };
  return {
    eventId: cardActionEventId({ messageId, actorId, action }),
    actorId,
    action,
  };
}

/**
 * Create the runtime Adapter that publishes strict Commitment Core task
 * snapshots through zylos-feishu's existing message sender.
 */
export function createTaskCardSender(input) {
  const options = requireRecord(input, 'task card sender options');
  requireExactFields(options, SENDER_OPTION_FIELDS, 'task card sender options');
  if (typeof options.sendMessage !== 'function') {
    throw new TypeError('sendMessage must be a function');
  }
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: options.issueTaskActionContext,
    clock: options.clock,
    actionContextTtlMs: options.actionContextTtlMs,
  });

  return Object.freeze({
    async send(input) {
      const request = requireRecord(input, 'task card send input');
      requireExactFields(request, SEND_INPUT_FIELDS, 'task card send input');
      const receiveId = requireText(request.receiveId, 'receiveId');
      if (!RECEIVE_ID_TYPES.has(request.receiveIdType)) {
        throw new TypeError('receiveIdType is unsupported');
      }
      const card = renderer.render(request.task);
      return options.sendMessage(
        receiveId,
        card,
        request.receiveIdType,
        'interactive',
      );
    },
  });
}

/**
 * Create the runtime Adapter that turns an authenticated Feishu
 * `card.action.trigger` callback into the existing Commitment Core command
 * route. Transport authentication is deliberately outside this module; the
 * actor is read only from the callback operator fields populated by Feishu.
 */
export function createTaskCardActionRuntime(input) {
  const options = requireRecord(input, 'task card action runtime options');
  requireExactFields(
    options,
    ACTION_RUNTIME_OPTION_FIELDS,
    'task card action runtime options',
  );
  if (typeof options.verifyTaskActionContext !== 'function') {
    throw new TypeError('verifyTaskActionContext must be a function');
  }
  if (typeof options.executeTaskAction !== 'function') {
    throw new TypeError('executeTaskAction must be a function');
  }

  return Object.freeze({
    async handle(input) {
      const route = parseTaskReviewCardAction(
        normalizeCardActionEvent(input),
        { verifyTaskActionContext: options.verifyTaskActionContext },
      );
      const coreResult = await options.executeTaskAction(route);
      return { route, coreResult };
    },
  });
}

/**
 * Build the exact handler map consumed by Feishu's EventDispatcher. The same
 * callback can be reused after the webhook transport has verified/decrypted
 * an event, keeping both transports on one runtime path.
 */
export function createTaskCardEventHandlers(input) {
  const options = requireRecord(input, 'task card event handler options');
  requireExactFields(
    options,
    EVENT_HANDLER_OPTION_FIELDS,
    'task card event handler options',
  );
  if (typeof options.handleTaskCardAction !== 'function') {
    throw new TypeError('handleTaskCardAction must be a function');
  }
  if (typeof options.onError !== 'function') {
    throw new TypeError('onError must be a function');
  }

  return Object.freeze({
    'card.action.trigger': async (event) => {
      try {
        const result = await options.handleTaskCardAction(event);
        return {
          toast: result?.toast || { type: 'success', content: '任务操作已处理' },
        };
      } catch (error) {
        options.onError(error);
        throw error;
      }
    },
  });
}

/**
 * Preserve the durable-before-ack invariant for a card callback that has
 * already passed webhook verification and decryption.
 */
export async function handleVerifiedTaskCardWebhook(event, handleCardAction) {
  requireRecord(event, 'verified task card webhook event');
  if (typeof handleCardAction !== 'function') {
    throw new TypeError('handleCardAction must be a function');
  }
  try {
    const body = await handleCardAction(event);
    return {
      statusCode: body?.toast?.type === 'success' ? 200 : 503,
      body,
    };
  } catch {
    return {
      statusCode: 503,
      body: {
        toast: { type: 'error', content: '任务操作失败，请刷新任务后重试' },
      },
    };
  }
}

/**
 * Select the acknowledgement strategy after the webhook transport has
 * verified its token and decrypted the envelope. Ordinary events are
 * immediate-ack; task-card actions cross the durable-before-ack path above.
 */
export async function routeVerifiedWebhookEvent(envelope, handleCardAction) {
  const event = requireRecord(envelope, 'verified webhook envelope');
  if (event.header?.event_type !== 'card.action.trigger') {
    return { statusCode: 200, body: { code: 0 } };
  }
  if (!event.event || typeof event.event !== 'object' || Array.isArray(event.event)) {
    return {
      statusCode: 400,
      body: { error: 'Malformed task card callback' },
    };
  }
  return handleVerifiedTaskCardWebhook(event.event, handleCardAction);
}
