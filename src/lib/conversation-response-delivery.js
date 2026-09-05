const ROUTE_KEYS = new Set(['type', 'root', 'parent', 'msg', 'thread']);

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
  return value.trim();
}

export function targetFromC4Route(input) {
  const route = requireRecord(input, 'C4 response route');
  if (route.channel !== 'feishu') throw new TypeError('C4 response route channel must be feishu');
  const endpointId = requireText(route.endpointId, 'C4 response route endpointId');
  const parts = endpointId.split('|');
  const chatId = requireText(parts.shift(), 'Feishu response chatId');
  const metadata = {};
  for (const part of parts) {
    const separator = part.indexOf(':');
    if (separator < 1) continue;
    const key = part.slice(0, separator);
    if (!ROUTE_KEYS.has(key)) continue;
    metadata[key] = part.slice(separator + 1);
  }
  if (!['p2p', 'group'].includes(metadata.type)) {
    throw new TypeError('C4 response route requires a supported chat type');
  }
  const replyToMessageId = metadata.type === 'group'
    ? requireText(metadata.parent || metadata.root || metadata.msg, 'Feishu response reply messageId')
    : (metadata.msg ? requireText(metadata.msg, 'Feishu direct reply messageId') : null);
  return Object.freeze({ chatId, chatType: metadata.type, replyToMessageId });
}

export function createConversationResponseDelivery({ stream } = {}) {
  const adapter = requireRecord(stream, 'conversation response stream');
  if (typeof adapter.open !== 'function' || typeof adapter.apply !== 'function') {
    throw new TypeError('conversation response stream must expose open and apply');
  }
  return Object.freeze({
    async deliver(input) {
      const delivery = requireRecord(input, 'C4 assistant response delivery');
      if (delivery.schemaVersion !== 1 || !Array.isArray(delivery.events) || delivery.events.length === 0) {
        throw new TypeError('invalid C4 assistant response delivery');
      }
      const requestId = requireText(delivery.requestId, 'assistant response requestId');
      let result = await adapter.apply({ requestId, events: delivery.events });
      if (!result?.handled && result?.reason === 'stream_not_found') {
        await adapter.open({
          requestId,
          target: targetFromC4Route(delivery.route),
        });
        result = await adapter.apply({ requestId, events: delivery.events });
      }
      if (!result?.handled) {
        throw new Error(`Feishu response stream delivery was not handled: ${result?.reason || 'unknown'}`);
      }
      return result;
    },
  });
}
