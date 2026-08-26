import { createHash, randomUUID } from 'node:crypto';

const MAX_NOTIFICATION_TEXT_LENGTH = 20_000;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 4_000) {
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

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function stableUuid(value) {
  return `ztn_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}

export function feishuNotificationDedupeKey(coreDedupeKey) {
  return `${requireText(coreDedupeKey, 'Core notification dedupeKey')}:feishu-im`;
}

function notificationText(deliveries) {
  const summaries = [...new Set(deliveries.map(({ summary }) => summary))];
  const lines = ['【Zylos 任务提醒】'];
  let included = 0;
  for (const summary of summaries) {
    const candidate = [...lines, `- ${summary}`].join('\n');
    if (Array.from(candidate).length > MAX_NOTIFICATION_TEXT_LENGTH - 64) break;
    lines.push(`- ${summary}`);
    included += 1;
  }
  const omitted = summaries.length - included;
  if (omitted > 0) lines.push(`- 另有 ${omitted} 条提醒已合并`);
  return lines.join('\n');
}

function errorDetail(error) {
  return String(error?.message ?? error ?? 'notification delivery failed').slice(0, 4_000);
}

function permanentRecipientError(recipientId) {
  const error = new Error(`notification recipient has no delivery mapping: ${recipientId}`);
  error.code = 'NOTIFICATION_RECIPIENT_UNMAPPED';
  error.retryable = false;
  return error;
}

/** Route logical Core identities without pretending Agent IDs are Feishu open_ids. */
export function createRoutedNotificationSender({ feishuSender, agentSender }) {
  requireFunction(feishuSender?.send, 'feishuSender.send');
  requireFunction(agentSender?.send, 'agentSender.send');
  return Object.freeze({
    async send(rawRequest) {
      const request = requireRecord(rawRequest, 'routed notification');
      const recipientId = requireText(request.recipientId, 'notification recipientId');
      const common = {
        text: requireText(request.text, 'notification text', 20_000),
        idempotencyKey: requireText(request.idempotencyKey, 'notification idempotencyKey'),
      };
      if (recipientId.startsWith('agent:')) {
        return agentSender.send({ agentId: recipientId, ...common });
      }
      if (recipientId.startsWith('ou_')) {
        return feishuSender.send({ recipientId, ...common });
      }
      throw permanentRecipientError(recipientId);
    },
  });
}

export function createSdkFeishuNotificationSender({ client }) {
  const sdk = requireRecord(client, 'Feishu SDK client');
  if (typeof sdk.im?.message?.create !== 'function') {
    throw new TypeError('Feishu SDK im.message.create is unavailable');
  }
  return Object.freeze({
    async send({ recipientId, text, idempotencyKey }) {
      if (typeof recipientId !== 'string' || !recipientId.startsWith('ou_')) {
        throw permanentRecipientError(recipientId);
      }
      const response = await sdk.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: requireText(recipientId, 'notification recipientId'),
          msg_type: 'text',
          content: JSON.stringify({ text: requireText(text, 'notification text', 20_000) }),
          uuid: stableUuid(requireText(idempotencyKey, 'notification idempotencyKey')),
        },
      });
      if (response?.code !== 0) {
        const error = new Error(response?.msg || 'Feishu notification send failed');
        error.code = response?.code;
        throw error;
      }
      return { messageId: requireText(response.data?.message_id, 'notification message ID') };
    },
  });
}

export function createFeishuNotificationAdapter({
  store,
  sender,
  workerId = `notification-worker-${randomUUID()}`,
  clock = () => new Date().toISOString(),
  leaseMs = 30_000,
  minRecipientIntervalMs = 1_000,
  retryAfterMs = 1_000,
  maxAttempts = 5,
}) {
  const notifications = requireRecord(store?.notifications, 'notification store');
  requireFunction(notifications.enqueue, 'notification store.enqueue');
  requireFunction(notifications.claim, 'notification store.claim');
  requireFunction(notifications.acknowledgeBatch, 'notification store.acknowledgeBatch');
  requireFunction(notifications.fail, 'notification store.fail');
  requireFunction(notifications.lastSentAt, 'notification store.lastSentAt');
  requireFunction(sender?.send, 'notification sender.send');
  const normalizedWorkerId = requireText(workerId, 'notification workerId');
  boundedInteger(leaseMs, 'notification leaseMs', 1, 86_400_000);
  boundedInteger(minRecipientIntervalMs, 'minRecipientIntervalMs', 0, 60_000);
  boundedInteger(retryAfterMs, 'notification retryAfterMs', 0, 86_400_000);
  boundedInteger(maxAttempts, 'notification maxAttempts', 1, 100);

  return Object.freeze({
    enqueue({ decision, summary }) {
      const normalizedDecision = requireRecord(decision, 'Core notification decision');
      if (!Array.isArray(normalizedDecision.deliveries)) {
        throw new TypeError('Core notification decision.deliveries must be an array');
      }
      const normalizedSummary = requireText(summary, 'notification summary');
      return normalizedDecision.deliveries.map((rawDelivery) => {
        const delivery = requireRecord(rawDelivery, 'Core notification delivery');
        return notifications.enqueue({
          dedupeKey: feishuNotificationDedupeKey(delivery.dedupeKey),
          eventId: requireText(normalizedDecision.eventId, 'decision.eventId'),
          taskId: requireText(normalizedDecision.taskId, 'decision.taskId'),
          recipientId: requireText(delivery.recipientId, 'delivery.recipientId'),
          reason: requireText(delivery.reason, 'delivery.reason'),
          urgency: requireText(delivery.urgency, 'delivery.urgency'),
          deliveryMode: requireText(delivery.deliveryMode, 'delivery.deliveryMode'),
          coalesceWindowMs: delivery.coalesceWindowMs,
          summary: normalizedSummary,
        });
      });
    },
    async flushOnce({ limit = 50 } = {}) {
      boundedInteger(limit, 'notification flush limit', 1, 100);
      const claimed = notifications.claim({
        workerId: normalizedWorkerId,
        leaseMs,
        limit,
      });
      const byRecipient = new Map();
      for (const delivery of claimed) {
        const current = byRecipient.get(delivery.recipientId) ?? [];
        current.push(delivery);
        byRecipient.set(delivery.recipientId, current);
      }
      let messagesSent = 0;
      let deadLettered = 0;
      for (const [recipientId, deliveries] of byRecipient) {
        try {
          const now = new Date(clock()).toISOString();
          const lastSentAt = notifications.lastSentAt({ recipientId });
          if (
            lastSentAt
            && new Date(now).valueOf() - new Date(lastSentAt).valueOf() < minRecipientIntervalMs
          ) {
            const error = new Error('recipient notification rate limit');
            error.retryAfterMs = minRecipientIntervalMs
              - (new Date(now).valueOf() - new Date(lastSentAt).valueOf());
            throw error;
          }
          await sender.send({
            recipientId,
            text: notificationText(deliveries),
            idempotencyKey: deliveries.map(({ dedupeKey }) => dedupeKey).sort().join('|'),
          });
          notifications.acknowledgeBatch(deliveries.map((delivery) => ({
            dedupeKey: delivery.dedupeKey,
            workerId: normalizedWorkerId,
            expectedVersion: delivery.version,
          })));
          messagesSent += 1;
        } catch (error) {
          for (const delivery of deliveries) {
            const failed = notifications.fail({
              dedupeKey: delivery.dedupeKey,
              workerId: normalizedWorkerId,
              expectedVersion: delivery.version,
              error: errorDetail(error),
              retryAfterMs: error?.retryable === false
                ? null
                : Math.max(0, Math.ceil(error?.retryAfterMs ?? retryAfterMs)),
              maxAttempts,
            });
            if (failed.status === 'dead_letter') deadLettered += 1;
          }
        }
      }
      return {
        claimed: claimed.length,
        messagesSent,
        deadLettered,
      };
    },
  });
}
