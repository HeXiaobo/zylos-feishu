import { createHash, randomUUID } from 'node:crypto';

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

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function stableKey(prefix, values) {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(values)).digest('base64url')}`;
}

function logicalCommentId(appId, commentId) {
  return stableKey('external-comment', [appId, commentId]);
}

function normalizeMapping(rawMapping) {
  const mapping = requireRecord(rawMapping, 'Task GUID mapping');
  return {
    taskId: requireText(mapping.taskId, 'Task GUID mapping.taskId'),
    wakeTarget: mapping.wakeTarget === null || mapping.wakeTarget === undefined
      ? null
      : requireRecord(mapping.wakeTarget, 'Task GUID mapping.wakeTarget'),
  };
}

function errorDetail(error) {
  return String(error?.message ?? error ?? 'unknown task comment worker error').slice(0, 4_000);
}

export function createTaskCommentWorker({
  appId,
  store,
  commentApi,
  taskMapping,
  conversation,
  wakeAgent,
  workerId = `task-comment-worker-${randomUUID()}`,
  leaseMs = 30_000,
  retryAfterMs = 1_000,
  maxAttempts = 5,
}) {
  const normalizedAppId = requireText(appId, 'worker appId');
  requireFunction(store?.claim, 'task comment store.claim');
  requireFunction(store?.acknowledge, 'task comment store.acknowledge');
  requireFunction(store?.fail, 'task comment store.fail');
  requireFunction(store?.isOutboundComment, 'task comment store.isOutboundComment');
  requireFunction(store?.recordObserved, 'task comment store.recordObserved');
  requireFunction(commentApi?.getComment, 'commentApi.getComment');
  requireFunction(taskMapping?.resolve, 'taskMapping.resolve');
  requireFunction(conversation?.record, 'conversation.record');
  requireFunction(wakeAgent, 'wakeAgent');
  const normalizedWorkerId = requireText(workerId, 'workerId');
  boundedInteger(leaseMs, 'leaseMs', 1, 86_400_000);
  boundedInteger(retryAfterMs, 'retryAfterMs', 0, 86_400_000);
  boundedInteger(maxAttempts, 'maxAttempts', 1, 100);

  async function processEntry(entry) {
    const mapping = normalizeMapping(await taskMapping.resolve({
      appId: normalizedAppId,
      taskGuid: entry.taskGuid,
    }));
    const read = await commentApi.getComment({
      taskGuid: entry.taskGuid,
      commentId: entry.commentId,
    });
    if (read?.kind !== 'found' && read?.kind !== 'missing') {
      throw new TypeError('commentApi.getComment returned an unsupported result');
    }
    if (read.kind === 'found') {
      const comment = requireRecord(read.comment, 'Task v2 comment');
      if (store.isOutboundComment({ appId: normalizedAppId, commentId: comment.id })) {
        store.recordObserved({
          appId: normalizedAppId,
          taskGuid: entry.taskGuid,
          commentId: comment.id,
          updatedAt: comment.updatedAt,
        });
        return { outcome: 'echo_suppressed', commentId: comment.id };
      }
      if (comment.resourceId && comment.resourceId !== entry.taskGuid) {
        const error = new Error('Task v2 comment belongs to another task');
        error.retryable = false;
        throw error;
      }
      if (comment.resourceType && comment.resourceType !== 'task') {
        const error = new Error('Task v2 comment belongs to a non-Task resource');
        error.retryable = false;
        throw error;
      }
      const commandType = comment.updatedAt === comment.createdAt
        ? 'AddComment'
        : 'ReviseComment';
      const command = {
        type: commandType,
        taskId: mapping.taskId,
        commentId: logicalCommentId(normalizedAppId, comment.id),
        actorId: requireText(comment.creator?.id, 'Task v2 comment creator ID'),
        ...(comment.replyToCommentId
          ? { replyToCommentId: logicalCommentId(normalizedAppId, comment.replyToCommentId) }
          : {}),
        body: requireText(comment.content, 'Task v2 comment content'),
        occurredAt: requireText(comment.updatedAt, 'Task v2 comment updatedAt'),
        idempotencyKey: stableKey('feishu-comment-effect', [
          normalizedAppId,
          entry.taskGuid,
          comment.id,
          commandType,
          comment.updatedAt,
          comment.content,
        ]),
      };
      const result = await conversation.record(command);
      if (mapping.wakeTarget) {
        await wakeAgent({
          taskId: mapping.taskId,
          target: mapping.wakeTarget,
          commentEventId: requireText(result?.event?.id, 'Core conversation event ID'),
          commentId: command.commentId,
          actorId: command.actorId,
          body: command.body,
          occurredAt: command.occurredAt,
          replyContext: {
            channel: 'feishu-task-v2',
            appId: normalizedAppId,
            taskGuid: entry.taskGuid,
            replyToCommentId: comment.id,
          },
          idempotencyKey: `${command.idempotencyKey}:wake`,
        });
      }
      store.recordObserved({
        appId: normalizedAppId,
        taskGuid: entry.taskGuid,
        commentId: comment.id,
        updatedAt: comment.updatedAt,
      });
      return { outcome: 'recorded', command, result };
    }
    const command = {
      type: 'DeleteComment',
      taskId: mapping.taskId,
      commentId: logicalCommentId(normalizedAppId, entry.commentId),
      actorId: `external:${normalizedAppId}`,
      ...(entry.parentCommentId
        ? { replyToCommentId: logicalCommentId(normalizedAppId, entry.parentCommentId) }
        : {}),
      occurredAt: entry.occurredAt,
      idempotencyKey: stableKey('feishu-comment-delete', [
        normalizedAppId,
        entry.taskGuid,
        entry.commentId,
      ]),
    };
    const result = await conversation.record(command);
    return { outcome: 'tombstone_recorded', command, result };
  }

  return Object.freeze({
    async processOnce({ limit = 25 } = {}) {
      boundedInteger(limit, 'comment worker limit', 1, 100);
      const entries = store.claim({
        appId: normalizedAppId,
        workerId: normalizedWorkerId,
        leaseMs,
        limit,
      });
      const results = [];
      for (const entry of entries) {
        try {
          const result = await processEntry(entry);
          store.acknowledge({
            appId: entry.appId,
            eventId: entry.eventId,
            workerId: normalizedWorkerId,
            expectedVersion: entry.version,
          });
          results.push({ eventId: entry.eventId, ...result });
        } catch (error) {
          const failed = store.fail({
            appId: entry.appId,
            eventId: entry.eventId,
            workerId: normalizedWorkerId,
            expectedVersion: entry.version,
            error: errorDetail(error),
            retryAfterMs: error?.retryable === false ? null : retryAfterMs,
            maxAttempts,
          });
          results.push({ eventId: entry.eventId, outcome: failed.status, error });
        }
      }
      return {
        claimed: entries.length,
        processed: results.filter(({ outcome }) => (
          outcome === 'recorded'
          || outcome === 'tombstone_recorded'
          || outcome === 'echo_suppressed'
        )).length,
        deadLettered: results.filter(({ outcome }) => outcome === 'dead_letter').length,
        results,
      };
    },
  });
}

export function createTaskCommentReplyAdapter({ appId, store, commentApi }) {
  const normalizedAppId = requireText(appId, 'reply adapter appId');
  requireFunction(store?.beginOutbound, 'task comment store.beginOutbound');
  requireFunction(store?.finishOutbound, 'task comment store.finishOutbound');
  requireFunction(store?.failOutbound, 'task comment store.failOutbound');
  requireFunction(commentApi?.reply, 'commentApi.reply');
  return Object.freeze({
    async reply(rawRequest) {
      const request = requireRecord(rawRequest, 'Task comment reply');
      const normalized = {
        appId: normalizedAppId,
        idempotencyKey: requireText(request.idempotencyKey, 'Task comment reply.idempotencyKey'),
        taskGuid: requireText(request.taskGuid, 'Task comment reply.taskGuid'),
        replyToCommentId: requireText(
          request.replyToCommentId,
          'Task comment reply.replyToCommentId',
        ),
        content: requireText(request.content, 'Task comment reply.content'),
      };
      const begun = store.beginOutbound(normalized);
      if (!begun.created) {
        if (begun.delivery.status === 'sent') {
          return { created: false, commentId: begun.delivery.commentId };
        }
        const error = new Error('outbound comment delivery is uncertain; automatic replay is blocked');
        error.code = 'OUTBOUND_DELIVERY_UNCERTAIN';
        throw error;
      }
      try {
        const comment = await commentApi.reply(normalized);
        const delivery = store.finishOutbound({
          appId: normalizedAppId,
          idempotencyKey: normalized.idempotencyKey,
          commentId: requireText(comment?.id, 'created Task v2 comment ID'),
        });
        return { created: true, commentId: delivery.commentId };
      } catch (error) {
        store.failOutbound({
          appId: normalizedAppId,
          idempotencyKey: normalized.idempotencyKey,
          error: errorDetail(error),
        });
        throw error;
      }
    },
  });
}
