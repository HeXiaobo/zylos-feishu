import { createConversationResponseDelivery } from './conversation-response-delivery.js';
import { messageIdFromEndpoint } from './typing-done-marker.js';
import { isSilentResponse } from './silent-response.js';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function createConversationResponseRuntimeAdapter({
  stream,
  markers,
  onTerminalMark = null,
  silentGuard = null,
  logger = console,
} = {}) {
  const delivery = createConversationResponseDelivery({ stream });
  const markerStore = requireRecord(markers, 'typing marker store');
  if (typeof markerStore.mark !== 'function') {
    throw new TypeError('typing marker store must provide mark');
  }
  if (
    silentGuard !== null
    && (typeof silentGuard !== 'object'
      || typeof silentGuard.isSilentEligible !== 'function'
      || typeof silentGuard.release !== 'function')
  ) {
    throw new TypeError('silentGuard must provide isSilentEligible and release');
  }

  async function settleSilentTerminal(envelope) {
    const messageId = messageIdFromEndpoint(envelope.route?.endpointId);
    if (!messageId) return;
    try {
      markerStore.mark(messageId);
      if (typeof onTerminalMark === 'function') {
        await onTerminalMark(messageId);
      }
    } catch (error) {
      logger.warn?.('Typing cleanup after a silent disposition failed', {
        messageId,
        error: error?.message ?? String(error),
      });
    }
  }

  // A Smart-group request accepted without a mention must stay invisible until
  // a substantive answer exists. Pre-terminal and failed deliveries are
  // dropped (no placeholder or error card may open), a terminal `[SKIP]`
  // resolves to zero outbound, and only a substantive terminal answer is
  // released into the normal projection.
  async function deliverSilentEligible(envelope) {
    const requestId = envelope.requestId;
    const events = Array.isArray(envelope.events) ? envelope.events : [];
    const completed = events.find(event => event?.type === 'RunCompleted');
    if (!completed) {
      return { handled: true, pending: false, status: 'suppressed', reason: 'smart_silent_eligible' };
    }
    if (isSilentResponse(completed.payload?.output)) {
      await settleSilentTerminal(envelope);
      return { handled: true, pending: false, status: 'completed', silent: true };
    }
    await silentGuard.release(requestId);
    return deliverNormal(envelope);
  }

  async function deliverNormal(envelope) {
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
      // Directly clear the typing reaction(s) the bot has on the originating
      // message. This one-shot worker process has no legacy 2s typing drain,
      // and the reply-refactor composition adds the reaction through its own
      // presence ledger, so the marker alone would leave the ⌨️ emoji behind.
      if (typeof onTerminalMark === 'function') {
        try {
          await onTerminalMark(messageId);
        } catch (error) {
          logger.warn?.('Typing reaction could not be cleared after terminal delivery', {
            messageId,
            error: error?.message ?? String(error),
          });
        }
      }
    }
    return result;
  }

  return Object.freeze({
    async deliver(input) {
      const envelope = requireRecord(input, 'C4 assistant response delivery');
      if (
        silentGuard
        && typeof envelope.requestId === 'string'
        && await silentGuard.isSilentEligible(envelope.requestId)
      ) {
        return deliverSilentEligible(envelope);
      }
      return deliverNormal(envelope);
    },
  });
}
