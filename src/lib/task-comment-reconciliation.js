import {
  createReconciliationDeleteEvent,
  createReconciliationInboxEvent,
  normalizeFeishuTimestamp,
} from './task-comment-event.js';

const ACTIVE_INTERVAL_MIN_MS = 5 * 60_000;
const ACTIVE_INTERVAL_MAX_MS = 10 * 60_000;
const GRACE_MIN_MS = 24 * 60 * 60_000;
const GRACE_MAX_MS = 72 * 60 * 60_000;
const TERMINAL_STATES = new Set(['done', 'cancelled']);

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

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function millisecondsBetween(later, earlier) {
  return new Date(later).valueOf() - new Date(earlier).valueOf();
}

function normalizeMapping(rawMapping) {
  const mapping = requireRecord(rawMapping, 'reconciliation Task mapping');
  const state = requireText(mapping.state, 'reconciliation Task mapping.state');
  return {
    taskId: requireText(mapping.taskId, 'reconciliation Task mapping.taskId'),
    taskGuid: requireText(mapping.taskGuid, 'reconciliation Task mapping.taskGuid'),
    state,
    updatedAt: normalizeFeishuTimestamp(
      mapping.updatedAt,
      'reconciliation Task mapping.updatedAt',
    ),
    eventCoverage: mapping.eventCoverage === undefined
      ? 'app'
      : requireText(mapping.eventCoverage, 'reconciliation Task mapping.eventCoverage'),
  };
}

export function createTaskCommentReconciler({
  appId,
  store,
  commentApi,
  taskMapping,
  clock = () => new Date().toISOString(),
  activeIntervalMs = 7.5 * 60_000,
  completedGraceMs = 48 * 60 * 60_000,
}) {
  const normalizedAppId = requireText(appId, 'reconciler appId');
  requireFunction(store?.enqueue, 'task comment store.enqueue');
  requireFunction(
    store?.getLastReconciledAt,
    'task comment store.getLastReconciledAt',
  );
  requireFunction(store?.listObserved, 'task comment store.listObserved');
  requireFunction(store?.markReconciled, 'task comment store.markReconciled');
  requireFunction(commentApi?.listComments, 'commentApi.listComments');
  requireFunction(taskMapping?.list, 'taskMapping.list');
  boundedInteger(
    activeIntervalMs,
    'activeIntervalMs',
    ACTIVE_INTERVAL_MIN_MS,
    ACTIVE_INTERVAL_MAX_MS,
  );
  boundedInteger(completedGraceMs, 'completedGraceMs', GRACE_MIN_MS, GRACE_MAX_MS);

  return Object.freeze({
    async runOnce({ limit = 50 } = {}) {
      boundedInteger(limit, 'reconciliation limit', 1, 100);
      const now = normalizeFeishuTimestamp(clock(), 'reconciliation clock');
      const rawMappings = await taskMapping.list({ appId: normalizedAppId, limit });
      if (!Array.isArray(rawMappings)) {
        throw new TypeError('taskMapping.list must return an array');
      }
      const result = {
        considered: 0,
        reconciled: 0,
        skippedInterval: 0,
        skippedGrace: 0,
        enqueued: 0,
        businessDuplicates: 0,
      };
      for (const rawMapping of rawMappings.slice(0, limit)) {
        const mapping = normalizeMapping(rawMapping);
        result.considered += 1;
        if (
          TERMINAL_STATES.has(mapping.state)
          && millisecondsBetween(now, mapping.updatedAt) > completedGraceMs
        ) {
          result.skippedGrace += 1;
          continue;
        }
        const lastReconciledAt = store.getLastReconciledAt({
          appId: normalizedAppId,
          taskGuid: mapping.taskGuid,
        });
        if (
          lastReconciledAt
          && millisecondsBetween(now, lastReconciledAt) < activeIntervalMs
        ) {
          result.skippedInterval += 1;
          continue;
        }
        const comments = await commentApi.listComments({ taskGuid: mapping.taskGuid });
        if (!Array.isArray(comments)) throw new TypeError('commentApi.listComments must return an array');
        const currentIds = new Set();
        for (const comment of comments) {
          const event = createReconciliationInboxEvent({
            appId: normalizedAppId,
            taskGuid: mapping.taskGuid,
            comment,
            now,
          });
          currentIds.add(event.commentId);
          const receipt = store.enqueue(event);
          if (receipt.accepted) result.enqueued += 1;
          else result.businessDuplicates += 1;
        }
        for (const observed of store.listObserved({
          appId: normalizedAppId,
          taskGuid: mapping.taskGuid,
        })) {
          if (currentIds.has(observed.commentId)) continue;
          const receipt = store.enqueue(createReconciliationDeleteEvent({
            appId: normalizedAppId,
            taskGuid: mapping.taskGuid,
            commentId: observed.commentId,
            now,
          }));
          if (receipt.accepted) result.enqueued += 1;
          else result.businessDuplicates += 1;
        }
        store.markReconciled({ appId: normalizedAppId, taskGuid: mapping.taskGuid });
        result.reconciled += 1;
      }
      return result;
    },
  });
}
