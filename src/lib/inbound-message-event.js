function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

/** Canonicalize SDK-flat and webhook-nested message events before fingerprinting. */
export function normalizeInboundMessageEvent(data, explicitEventId = null) {
  const input = requireRecord(data, 'Feishu inbound message');
  const message = requireRecord(input.message, 'Feishu inbound message.message');
  const sender = requireRecord(input.sender, 'Feishu inbound message.sender');
  return Object.freeze({
    eventId: explicitEventId || input.event_id || input.header?.event_id || null,
    messageId: message.message_id || null,
    payload: Object.freeze({
      message,
      sender,
      _timestamp: input._timestamp || input.create_time || input.header?.create_time || null,
    }),
  });
}
