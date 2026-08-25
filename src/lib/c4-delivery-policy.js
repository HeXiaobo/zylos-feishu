import { createHash } from 'node:crypto';

function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Resolve the durable C4 identity used as the Feishu delivery seam. Assistant
 * requests already carry a globally stable ID; other C4 sends must provide
 * C4_DELIVERY_ID from Core's persisted outbound record.
 */
export function requestIdForC4Delivery(env = process.env) {
  const assistantRequestId = optionalText(env.C4_ASSISTANT_REQUEST_ID);
  if (assistantRequestId) return assistantRequestId;
  const deliveryId = optionalText(env.C4_DELIVERY_ID);
  if (!deliveryId) return null;
  const digest = createHash('sha256').update(deliveryId).digest('hex').slice(0, 40);
  return `assistant.feishu.delivery.${digest}`;
}

export function completedCardFailureAction(error) {
  return error?.deliveryOutcome === 'rejected' && (error?.deliveredParts || 0) === 0
    ? 'fallback_text'
    : 'retry_same_delivery';
}
