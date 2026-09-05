import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConversationResponseDelivery,
  targetFromC4Route,
} from '../src/lib/conversation-response-delivery.js';

test('derives the exact Feishu reply target from a durable C4 route', () => {
  assert.deepEqual(targetFromC4Route({
    channel: 'feishu',
    endpointId: 'oc_group|type:group|root:om_root|parent:om_parent|msg:om_message',
  }), {
    chatId: 'oc_group',
    chatType: 'group',
    replyToMessageId: 'om_parent',
  });
  assert.deepEqual(targetFromC4Route({
    channel: 'feishu',
    endpointId: 'oc_dm|type:p2p|msg:om_message',
  }), {
    chatId: 'oc_dm',
    chatType: 'p2p',
    replyToMessageId: 'om_message',
  });
});
test('a durable Core delivery recreates a missing placeholder before applying events', async () => {
  const calls = [];
  let opened = false;
  const delivery = createConversationResponseDelivery({
    stream: {
      async apply(request) {
        calls.push(['apply', request]);
        return opened
          ? { handled: true, applied: request.events.length }
          : { handled: false, reason: 'stream_not_found' };
      },
      async open(request) {
        calls.push(['open', request]);
        opened = true;
        return { handled: true };
      },
    },
  });
  const event = {
    schemaVersion: 1,
    eventId: 'assistant.feishu.recover:1',
    requestId: 'assistant.feishu.recover',
    sequence: 1,
    type: 'AssistantRequestAccepted',
    occurredAt: 1,
    payload: {},
  };
  const result = await delivery.deliver({
    schemaVersion: 1,
    requestId: event.requestId,
    route: {
      channel: 'feishu',
      endpointId: 'oc_dm|type:p2p|msg:om_recover',
    },
    events: [event],
  });

  assert.equal(result.handled, true);
  assert.deepEqual(calls.map(([operation]) => operation), ['apply', 'open', 'apply']);
  assert.deepEqual(calls[1][1], {
    requestId: event.requestId,
    target: {
      chatId: 'oc_dm',
      chatType: 'p2p',
      replyToMessageId: 'om_recover',
    },
  });
});

test('DM durable routes quote the trigger, never inherited topic facts', () => {
  assert.equal(targetFromC4Route({channel: 'feishu', endpointId: 'oc_dm|type:p2p|root:om_old|parent:om_parent|msg:om_new'}).replyToMessageId, 'om_new');
  assert.equal(targetFromC4Route({channel: 'feishu', endpointId: 'oc_dm|type:p2p|root:om_old'}).replyToMessageId, null);
});
