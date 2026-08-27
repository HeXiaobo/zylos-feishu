import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeInboundMessageEvent } from '../src/lib/inbound-message-event.js';

test('normalizes flat SDK and nested webhook metadata to one durable payload', () => {
  const message = { message_id: 'om_1', content: '{"text":"hi"}' };
  const sender = { sender_id: { open_id: 'ou_1' } };
  const sdk = normalizeInboundMessageEvent({
    event_id: 'evt_1', create_time: '1787600000000', message, sender,
  });
  const webhook = normalizeInboundMessageEvent({
    _timestamp: '1787600000000', message, sender,
  }, 'evt_1');

  assert.deepEqual(sdk, webhook);
  assert.equal(sdk.eventId, 'evt_1');
  assert.equal(sdk.messageId, 'om_1');
});
