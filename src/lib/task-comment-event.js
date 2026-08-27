import { createHash } from 'node:crypto';

const EVENT_TYPE = 'task.task.comment.updated_v1';
const MAX_ID_LENGTH = 512;

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
  if (Array.from(value).length > MAX_ID_LENGTH) {
    throw new TypeError(`${field} exceeds ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field);
}

export function normalizeFeishuTimestamp(value, field) {
  const text = requireText(String(value), field);
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isSafeInteger(numeric)) throw new TypeError(`${field} is out of range`);
    const milliseconds = text.length >= 13 ? numeric : numeric * 1_000;
    const parsed = new Date(milliseconds);
    if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} is invalid`);
    return parsed.toISOString();
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} is invalid`);
  return parsed.toISOString();
}

function stableKey(prefix, values) {
  const digest = createHash('sha256').update(JSON.stringify(values)).digest('base64url');
  return `${prefix}:${digest}`;
}

export function commentEventBusinessKey({ taskGuid, commentId, parentCommentId, objType, occurredAt }) {
  return stableKey('comment-change', [
    taskGuid,
    commentId,
    parentCommentId,
    objType,
    occurredAt,
  ]);
}

export function normalizeTaskCommentEvent(rawEvent, { appId }) {
  const raw = requireRecord(rawEvent, 'Feishu task comment event');
  const event = raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event)
    ? raw.event
    : raw;
  const header = raw.header && typeof raw.header === 'object' && !Array.isArray(raw.header)
    ? raw.header
    : {};
  const expectedAppId = requireText(appId, 'configured Feishu appId');
  const eventAppId = optionalText(event.app_id ?? header.app_id, 'Feishu event app_id');
  if (eventAppId && eventAppId !== expectedAppId) {
    throw new TypeError('Feishu task comment event belongs to a different app');
  }
  const eventType = optionalText(event.event_type ?? header.event_type, 'Feishu event type');
  if (eventType && eventType !== EVENT_TYPE) {
    throw new TypeError(`unexpected Feishu event type: ${eventType}`);
  }
  const taskGuid = requireText(event.task_id, 'Feishu event task_id');
  const commentId = requireText(event.comment_id, 'Feishu event comment_id');
  const parentCommentId = optionalText(event.parent_id, 'Feishu event parent_id');
  const objType = event.obj_type === undefined || event.obj_type === null
    ? null
    : Number(event.obj_type);
  if (objType !== null && (!Number.isInteger(objType) || objType < 0 || objType > 1_000_000)) {
    throw new TypeError('Feishu event obj_type must be a non-negative integer');
  }
  const occurredAt = normalizeFeishuTimestamp(
    event.create_time ?? header.create_time ?? event.ts ?? header.ts,
    'Feishu event create_time',
  );
  const normalized = {
    appId: expectedAppId,
    eventId: requireText(event.event_id ?? header.event_id, 'Feishu event event_id'),
    taskGuid,
    commentId,
    parentCommentId,
    objType,
    occurredAt,
    source: 'event',
  };
  return {
    ...normalized,
    businessKey: commentEventBusinessKey(normalized),
  };
}

export function createTaskCommentEventHandlers({ appId, store, onError }) {
  requireText(appId, 'configured Feishu appId');
  if (!store || typeof store.enqueue !== 'function') {
    throw new TypeError('task comment store.enqueue must be a function');
  }
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');
  return Object.freeze({
    [EVENT_TYPE]: async (event) => {
      try {
        const normalized = normalizeTaskCommentEvent(event, { appId });
        const receipt = store.enqueue(normalized);
        return { code: 0, receipt };
      } catch (error) {
        onError(error);
        throw error;
      }
    },
  });
}

export function createReconciliationInboxEvent({ appId, taskGuid, comment, now }) {
  const normalizedAppId = requireText(appId, 'reconciliation appId');
  const normalizedTaskGuid = requireText(taskGuid, 'reconciliation taskGuid');
  const normalizedComment = requireRecord(comment, 'reconciliation comment');
  const commentId = requireText(normalizedComment.id, 'reconciliation comment.id');
  const occurredAt = normalizeFeishuTimestamp(
    normalizedComment.updatedAt ?? normalizedComment.createdAt,
    'reconciliation comment.updatedAt',
  );
  const parentCommentId = optionalText(
    normalizedComment.replyToCommentId,
    'reconciliation comment.replyToCommentId',
  );
  return {
    appId: normalizedAppId,
    eventId: stableKey('reconcile-comment', [normalizedAppId, normalizedTaskGuid, commentId, occurredAt]),
    businessKey: commentEventBusinessKey({
      taskGuid: normalizedTaskGuid,
      commentId,
      parentCommentId,
      objType: null,
      occurredAt,
    }),
    taskGuid: normalizedTaskGuid,
    commentId,
    parentCommentId,
    objType: null,
    occurredAt,
    source: 'reconciliation',
  };
}

export function createReconciliationDeleteEvent({ appId, taskGuid, commentId, now }) {
  const normalizedAppId = requireText(appId, 'reconciliation appId');
  const normalizedTaskGuid = requireText(taskGuid, 'reconciliation taskGuid');
  const normalizedCommentId = requireText(commentId, 'reconciliation commentId');
  const occurredAt = normalizeFeishuTimestamp(now, 'reconciliation time');
  return {
    appId: normalizedAppId,
    eventId: stableKey('reconcile-comment-delete', [
      normalizedAppId,
      normalizedTaskGuid,
      normalizedCommentId,
    ]),
    businessKey: stableKey('comment-delete', [
      normalizedAppId,
      normalizedTaskGuid,
      normalizedCommentId,
    ]),
    taskGuid: normalizedTaskGuid,
    commentId: normalizedCommentId,
    parentCommentId: null,
    objType: null,
    occurredAt,
    source: 'reconciliation',
  };
}
