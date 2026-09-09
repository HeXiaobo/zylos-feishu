import { createHash, randomUUID } from 'node:crypto';

import { TASK_V2_LINK_BACKEND } from './task-v2-projection.js';

/**
 * Core-outbox projection that turns TaskProgressReported events into top-level
 * Feishu Task v2 comments. It reuses the durable outbound comment ledger for
 * event-id dedupe and echo suppression, and never issues Core commands: a
 * progress report is a same-state event, so projecting it must not change task
 * state, wake agents, or touch legacy writers.
 */
export const TASK_PROGRESS_PROJECTION = 'feishu-task-progress';
export const TASK_PROGRESS_EVENT_TYPE = 'TaskProgressReported';
export const PROGRESS_COMMENT_HEADER = '【Zylos 任务进度】';
const MAX_COMMENT_LENGTH = 20_000;
const TASK_V2_LINK_LIMIT = 2;

function requireText(value, field, maxLength = 256) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (Array.from(normalized).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function codepoints(value) {
  return Array.from(value).length;
}

function errorDetail(error) {
  return String(error?.message ?? error ?? 'unknown task progress projection error').slice(0, 4_000);
}

function permanentError(message) {
  const error = new Error(message);
  error.retryable = false;
  return error;
}

function operationKey(parts) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `task-progress-projection:${digest}`;
}

/**
 * Render the task comment body for a progress report. The header gives the
 * app-authored comment context; when the progress message already fills the
 * Feishu comment body limit, the header is dropped instead of truncating the
 * message, so the full report always survives projection.
 */
export function renderTaskProgressComment(message) {
  const text = requireText(message, 'progress message', MAX_COMMENT_LENGTH);
  const prefixed = `${PROGRESS_COMMENT_HEADER}\n${text}`;
  if (codepoints(prefixed) <= MAX_COMMENT_LENGTH) return prefixed;
  return text;
}

function requireDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new TypeError('outbox delivery must be an object');
  }
  if (delivery.projection !== TASK_PROGRESS_PROJECTION) {
    throw new TypeError(`delivery.projection must be ${TASK_PROGRESS_PROJECTION}`);
  }
  const event = delivery.event;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('delivery.event must be an object');
  }
  return {
    delivery,
    eventId: requireText(delivery.eventId, 'delivery.eventId'),
    deliveryVersion: delivery.version,
    event,
  };
}

function progressMessage(event) {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw permanentError('TaskProgressReported event payload is missing');
  }
  if (typeof payload.message !== 'string' || payload.message.trim() === '') {
    throw permanentError('TaskProgressReported payload.message must be a non-empty string');
  }
  return payload.message;
}

function requireProgressEvent(event, eventId) {
  if (event.type !== TASK_PROGRESS_EVENT_TYPE) {
    throw permanentError(
      `outbox event ${eventId} is not a ${TASK_PROGRESS_EVENT_TYPE} event: ${String(event.type)}`,
    );
  }
}

function requireCommentApi(commentApi) {
  requireFunction(commentApi?.createComment, 'commentApi.createComment');
  return commentApi;
}

/**
 * Resolve the Feishu Task v2 GUID linked to a Core task. A missing link is
 * retryable: the Task v2 projection worker may not have created the remote
 * task yet, so progress waits instead of being dropped.
 */
export function createTaskProgressTargetResolver({ core } = {}) {
  if (!core || typeof core.externalLinks?.query !== 'function') {
    throw new TypeError('core.externalLinks.query must be a function');
  }
  return Object.freeze({
    resolve({ taskId } = {}) {
      const normalizedTaskId = requireText(taskId, 'progress target taskId');
      const links = core.externalLinks.query({
        taskId: normalizedTaskId,
        backend: TASK_V2_LINK_BACKEND,
        limit: TASK_V2_LINK_LIMIT,
      });
      if (!Array.isArray(links)) {
        throw new TypeError('core.externalLinks.query must return an array');
      }
      if (links.length > 1) {
        throw permanentError(`multiple Task v2 links found for ${normalizedTaskId}`);
      }
      if (links.length === 0) {
        const error = new Error(
          `Core task has no Feishu Task v2 link yet: ${normalizedTaskId}`,
        );
        error.code = 'TASK_PROGRESS_TARGET_UNLINKED';
        throw error;
      }
      return requireText(links[0].externalId, 'Task v2 ExternalLink externalId');
    },
  });
}

/**
 * One worker Interface over Core's projection outbox: claim a bounded batch,
 * post each TaskProgressReported event as a top-level task comment through the
 * durable outbound ledger, and settle every delivery independently.
 */
export function createTaskProgressProjector({
  appId,
  core,
  store,
  commentApi,
  targetResolver,
  workerId = `task-progress-worker-${randomUUID()}`,
  leaseMs = 30_000,
  retryAfterMs = 5_000,
  maxAttempts = 5,
  operationIdFactory = randomUUID,
}) {
  const normalizedAppId = requireText(appId, 'projector appId');
  if (!core || typeof core.outbox?.claim !== 'function'
      || typeof core.outbox?.ack !== 'function'
      || typeof core.outbox?.fail !== 'function') {
    throw new TypeError('core.outbox must provide claim, ack, and fail functions');
  }
  requireFunction(store?.beginOutbound, 'task comment store.beginOutbound');
  requireFunction(store?.finishOutbound, 'task comment store.finishOutbound');
  requireFunction(store?.failOutbound, 'task comment store.failOutbound');
  requireCommentApi(commentApi);
  const resolver = targetResolver ?? createTaskProgressTargetResolver({ core });
  requireFunction(resolver?.resolve, 'targetResolver.resolve');
  requireFunction(operationIdFactory, 'operationIdFactory');
  const normalizedWorkerId = requireText(workerId, 'projector workerId');
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) {
    throw new TypeError('leaseMs must be an integer between 1 and 86400000');
  }
  if (!Number.isInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 86_400_000) {
    throw new TypeError('retryAfterMs must be an integer between 0 and 86400000');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new TypeError('maxAttempts must be an integer between 1 and 100');
  }

  function ack(delivery, outcome) {
    core.outbox.ack({
      projection: TASK_PROGRESS_PROJECTION,
      eventId: delivery.eventId,
      workerId: normalizedWorkerId,
      idempotencyKey: operationKey({
        operation: 'ack',
        projection: TASK_PROGRESS_PROJECTION,
        workerId: normalizedWorkerId,
        operationId: delivery.operationId,
        eventId: delivery.eventId,
        deliveryVersion: delivery.deliveryVersion,
        outcome,
      }),
    }, delivery.deliveryVersion);
  }

  function fail(delivery, error) {
    const retryable = error?.retryable !== false;
    const failed = core.outbox.fail({
      projection: TASK_PROGRESS_PROJECTION,
      eventId: delivery.eventId,
      workerId: normalizedWorkerId,
      error: errorDetail(error),
      ...(retryable ? { retryAfterMs } : {}),
      maxAttempts,
      idempotencyKey: operationKey({
        operation: 'fail',
        projection: TASK_PROGRESS_PROJECTION,
        workerId: normalizedWorkerId,
        operationId: delivery.operationId,
        eventId: delivery.eventId,
        deliveryVersion: delivery.deliveryVersion,
        retryable,
      }),
    }, delivery.deliveryVersion);
    return failed?.status ?? 'failed';
  }

  function uncertainDeliveryError(delivery) {
    const error = new Error(
      `outbound progress comment is uncertain; automatic replay is blocked: ${delivery.eventId}`,
    );
    error.code = 'OUTBOUND_DELIVERY_UNCERTAIN';
    return error;
  }

  async function projectOne(delivery) {
    const event = delivery.event;
    if (event.type !== TASK_PROGRESS_EVENT_TYPE) {
      // The outbox delivers every Core event to every projection; only
      // progress reports produce comments here, everything else is a no-op.
      return 'not_applicable';
    }
    requireProgressEvent(event, delivery.eventId);
    const content = renderTaskProgressComment(progressMessage(event));
    const taskGuid = resolver.resolve({ taskId: event.taskId });
    const idempotencyKey = `task-progress:${delivery.eventId}`;
    const begun = store.beginOutbound({
      appId: normalizedAppId,
      idempotencyKey,
      taskGuid,
      replyToCommentId: null,
      content,
    });
    if (!begun.created) {
      if (begun.delivery.status === 'sent') {
        return 'already_sent';
      }
      // A pending or dead-lettered ledger row means a previous attempt may
      // have created the remote comment. Task v2 comments have no idempotency
      // token, so never blind-retry: wait for the reconciler to adopt the
      // comment or for an operator to resolve the ledger row.
      throw uncertainDeliveryError(delivery);
    }
    try {
      const comment = await commentApi.createComment({ taskGuid, content });
      store.finishOutbound({
        appId: normalizedAppId,
        idempotencyKey,
        commentId: requireText(comment?.id, 'created Task v2 comment ID'),
      });
      return 'commented';
    } catch (error) {
      store.failOutbound({
        appId: normalizedAppId,
        idempotencyKey,
        error: errorDetail(error),
      });
      throw error;
    }
  }

  return Object.freeze({
    async processOnce({ limit = 25 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('progress projection limit must be between 1 and 100');
      }
      const operationId = requireText(operationIdFactory(), 'operationIdFactory result', 128);
      const deliveries = core.outbox.claim({
        projection: TASK_PROGRESS_PROJECTION,
        workerId: normalizedWorkerId,
        leaseMs,
        limit,
        idempotencyKey: operationKey({
          operation: 'claim',
          projection: TASK_PROGRESS_PROJECTION,
          workerId: normalizedWorkerId,
          operationId,
          leaseMs,
          limit,
        }),
      });
      if (!Array.isArray(deliveries)) {
        throw new TypeError('core.outbox.claim must return an array');
      }
      const summary = {
        claimed: deliveries.length,
        commented: 0,
        alreadySent: 0,
        notApplicable: 0,
        retryWaiting: 0,
        deadLettered: 0,
        settlementFailed: 0,
      };
      const summaryKeys = {
        commented: 'commented',
        already_sent: 'alreadySent',
        not_applicable: 'notApplicable',
      };
      const results = [];
      for (const rawDelivery of deliveries) {
        const delivery = { ...requireDelivery(rawDelivery), operationId };
        try {
          const outcome = await projectOne(delivery);
          summary[summaryKeys[outcome] ?? outcome] += 1;
          ack(delivery, outcome);
          results.push({ eventId: delivery.eventId, outcome });
        } catch (error) {
          try {
            const status = fail(delivery, error);
            if (status === 'retry_wait') summary.retryWaiting += 1;
            if (status === 'dead_letter') summary.deadLettered += 1;
            results.push({ eventId: delivery.eventId, outcome: status, error });
          } catch (settlementError) {
            summary.settlementFailed += 1;
            results.push({
              eventId: delivery.eventId,
              outcome: 'settlement_failed',
              error: settlementError,
            });
          }
        }
      }
      return { ...summary, results };
    },
  });
}

/** Register the progress projection so Core starts queueing deliveries. */
export function initializeTaskProgressProjection({ bootstrapPolicy, openCore } = {}) {
  if (bootstrapPolicy !== 'from_now' && bootstrapPolicy !== 'from_beginning') {
    throw new TypeError('bootstrapPolicy must be from_now or from_beginning');
  }
  if (typeof openCore !== 'function') throw new TypeError('openCore must be a function');
  const core = openCore();
  try {
    return core.outbox.register({
      projection: TASK_PROGRESS_PROJECTION,
      bootstrapPolicy,
      actorId: 'commitment-feishu-task-progress-projection',
      idempotencyKey: `${TASK_PROGRESS_PROJECTION}:register:${bootstrapPolicy}:v1`,
    });
  } finally {
    core.close();
  }
}
