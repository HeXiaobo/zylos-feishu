const CORE_EVENT_PROJECTION_PREFIX = 'task-comment-core-event:';

export const NATIVE_TASK_COMMENT_REMINDER_CONTENT = '请查看上方 BOT 回复。';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function coreEventIdFromProjectionRequest(request) {
  const key = requireText(request.idempotencyKey, 'Task comment projection idempotencyKey');
  if (!key.startsWith(CORE_EVENT_PROJECTION_PREFIX)) return null;
  return key.slice(CORE_EVENT_PROJECTION_PREFIX.length) || null;
}

/**
 * A transport rejection is safe to fall back from only when the remote API
 * has explicitly rejected the request. A connection/timeout error remains
 * ambiguous because Feishu may have accepted the comment before the client
 * observed the failure.
 */
function isDeterministicFailure(error) {
  if (error?.code === 'OUTBOUND_DELIVERY_UNCERTAIN' || error?.deliveryUncertain === true) {
    return false;
  }
  return error?.deterministic === true
    || error?.retryable === false
    || typeof error?.code === 'number'
    || error?.code === 'FEISHU_API_ERROR';
}

function publicationHasDeliveries(publication) {
  return Array.isArray(publication?.decision?.deliveries)
    && publication.decision.deliveries.length > 0;
}

/**
 * Project one Core Agent reply and, after its remote ID is known, one native
 * Task self-reply. The native self-reply is the primary human notification;
 * the injected fallback is attempted only for an explicit API rejection.
 */
export function createTaskCommentNativeNotification({
  primaryReply,
  nativeReply,
  publicationForCoreEvent,
  releasePublication,
  enqueueFallback,
  fallbackExists,
  reminderContent = NATIVE_TASK_COMMENT_REMINDER_CONTENT,
}) {
  requireFunction(primaryReply?.reply, 'primary Task comment reply.reply');
  requireFunction(nativeReply?.reply, 'native Task comment reply.reply');
  requireFunction(publicationForCoreEvent, 'publicationForCoreEvent');
  requireFunction(releasePublication, 'releasePublication');
  requireFunction(enqueueFallback, 'enqueueFallback');
  requireFunction(fallbackExists, 'fallbackExists');
  const normalizedReminderContent = requireText(
    reminderContent,
    'native Task comment reminder content',
    20_000,
  );

  async function fallback(publication) {
    if (!publicationHasDeliveries(publication)) return { queued: false, existing: false };
    if (fallbackExists(publication)) return { queued: false, existing: true };
    await enqueueFallback(publication);
    return { queued: true, existing: false };
  }

  return Object.freeze({
    async reply(rawRequest) {
      const request = requireRecord(rawRequest, 'Task comment native notification request');
      const coreEventId = coreEventIdFromProjectionRequest(request);
      const publication = coreEventId === null
        ? null
        : publicationForCoreEvent(coreEventId);
      try {
        const primary = await primaryReply.reply(request);

        const primaryCommentId = requireText(
          primary?.commentId,
          'primary Task comment ID',
        );
        try {
          const native = await nativeReply.reply({
            taskGuid: requireText(request.taskGuid, 'native Task comment taskGuid'),
            replyToCommentId: primaryCommentId,
            content: normalizedReminderContent,
            idempotencyKey: `task-comment-native-notification:${requireText(
              coreEventId,
              'native Task comment Core event ID',
            )}`,
          });
          return Object.freeze({
            ...primary,
            nativeNotification: native,
            notificationChannel: 'native-task-comment',
          });
        } catch (error) {
          if (
            error?.code === 'OUTBOUND_DELIVERY_UNCERTAIN'
            && fallbackExists(publication)
          ) {
            return Object.freeze({
              ...primary,
              nativeNotification: {
                created: false,
                commentId: null,
                uncertain: true,
              },
              notificationChannel: 'feishu-im',
              fallback: { queued: false, existing: true },
            });
          }
          if (!isDeterministicFailure(error)) throw error;
          const fallbackResult = await fallback(publication);
          return Object.freeze({
            ...primary,
            nativeNotification: {
              created: false,
              commentId: null,
            },
            notificationChannel: 'feishu-im',
            fallback: fallbackResult,
          });
        }
      } finally {
        if (coreEventId !== null) releasePublication(coreEventId);
      }
    },
  });
}
