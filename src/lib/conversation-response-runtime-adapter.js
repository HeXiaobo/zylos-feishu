import { createConversationResponseDelivery } from './conversation-response-delivery.js';
import { messageIdFromEndpoint } from './typing-done-marker.js';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function createConversationResponseRuntimeAdapter({ stream, markers, logger = console } = {}) {
  const delivery = createConversationResponseDelivery({ stream });
  const markerStore = requireRecord(markers, 'typing marker store');
  if (typeof markerStore.mark !== 'function') {
    throw new TypeError('typing marker store must provide mark');
  }

  return Object.freeze({
    async deliver(input) {
      const envelope = requireRecord(input, 'C4 assistant response delivery');
      const result = await delivery.deliver(envelope);
      if (
        result?.handled === true
        && result.pending !== true
        && ['completed', 'failed'].includes(result.status)
      ) {
        const messageId = messageIdFromEndpoint(envelope.route?.endpointId);
        if (!messageId) {
          const error = new Error('terminal delivery route has no exact source message identity');
          error.code = 'INVALID_SOURCE_MESSAGE_IDENTITY';
          throw error;
        }
        try {
          markerStore.mark(messageId);
          if (
            result.reason === 'main_timeout'
            && typeof stream.acknowledgePresenceCompletion === 'function'
          ) {
            await stream.acknowledgePresenceCompletion(envelope.requestId);
          }
        } catch (error) {
          logger.warn?.('Typing completion marker could not be persisted after terminal delivery', {
            messageId,
            error: error?.message ?? String(error),
          });
          throw error;
        }
      }
      return result;
    },
  });
}
