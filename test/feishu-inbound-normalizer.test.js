import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFeishuInboundMessage } from '../src/lib/feishu-inbound-normalizer.js';

function inboundMessage(messageOverrides = {}, eventOverrides = {}) {
  return {
    event_id: eventOverrides.eventId ?? 'evt-p2p-1',
    create_time: '1788220800000',
    message: {
      message_id: 'om-p2p-1',
      chat_id: 'oc-p2p-1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      ...messageOverrides,
    },
    sender: {
      sender_id: { open_id: 'ou-user-1' },
      sender_type: 'user',
      tenant_key: 'tenant-1',
    },
  };
}

test('normalizes a p2p message into a v1 AcceptMessage and adapter-local lane acceptance', () => {
  const normalized = normalizeFeishuInboundMessage(inboundMessage(), {
    accountRef: 'cli_app_a',
  });

  assert.equal(normalized.conversationLaneKey, 'feishu:cli_app_a:p2p:oc-p2p-1:chat');
  assert.equal(normalized.sourceOrder, null);
  assert.equal(normalized.message.schemaVersion, 1);
  assert.equal(normalized.message.type, 'AcceptMessage');
  assert.equal(normalized.message.source.adapterId, 'feishu');
  assert.equal(normalized.message.source.accountRef, 'cli_app_a');
  assert.equal(normalized.message.source.eventType, 'im.message.receive_v1');
  assert.equal(normalized.message.source.eventId, 'evt-p2p-1');
  assert.equal(normalized.message.source.messageId, 'om-p2p-1');
  assert.match(normalized.message.source.payloadHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(normalized.message.source.transportEventKey, undefined);
  assert.equal(normalized.message.source.logicalMessageKey, undefined);
  assert.equal(normalized.message.content.text, 'hello');
  assert.deepEqual(normalized.message.contextHints, {
    threadRef: null,
    rootRef: null,
    parentRef: null,
    quoteRefs: [],
    mentionRefs: [],
    attachmentRefs: [],
    platformHistoryRefs: [],
  });
  assert.equal(normalized.message.reply.mode, 'required');
  assert.match(normalized.message.reply.targetRef, /^feishu-route:v1:/);
  assert.equal(normalized.message.policy.requireIdle, false);
});

test('thread precedence and ContextHints preserve only opaque Feishu platform facts', () => {
  const normalized = normalizeFeishuInboundMessage(inboundMessage({
    message_id: 'om-topic-1',
    chat_id: 'oc-topic-1',
    chat_type: 'topic_group',
    thread_id: 'omt-thread-1',
    root_id: 'om-root-1',
    parent_id: 'om-parent-1',
    upper_message_id: 'om-forward-container',
    message_type: 'file',
    content: JSON.stringify({ file_key: 'file-key-1', file_name: 'brief.pdf' }),
    mentions: [{ key: '@_user_1', name: 'Ada', id: { open_id: 'ou-ada' } }],
  }), { accountRef: 'cli_app_a' });

  assert.equal(
    normalized.conversationLaneKey,
    'feishu:cli_app_a:topic_group:oc-topic-1:thread:omt-thread-1',
  );
  assert.equal(normalized.conversationLaneKey.includes('om-root-1'), false);
  assert.equal(normalized.conversationLaneKey.includes('om-parent-1'), false);
  assert.equal(normalized.conversationLaneKey.includes('om-forward-container'), false);
  assert.match(normalized.message.contextHints.threadRef, /^feishu-thread:v1:/);
  assert.match(normalized.message.contextHints.rootRef, /^feishu-root:v1:/);
  assert.match(normalized.message.contextHints.parentRef, /^feishu-message:v1:/);
  assert.deepEqual(normalized.message.contextHints.quoteRefs, [
    normalized.message.contextHints.parentRef,
  ]);
  assert.equal(normalized.message.contextHints.mentionRefs.length, 1);
  assert.match(normalized.message.contextHints.mentionRefs[0], /^feishu-mention:v1:/);
  assert.equal(normalized.message.contextHints.attachmentRefs.length, 1);
  assert.match(normalized.message.contextHints.attachmentRefs[0], /^feishu-attachment:v1:/);
  for (const forbidden of ['tokenBudget', 'truncation', 'contextSnapshot', 'runtimeSession']) {
    assert.equal(normalized.message.contextHints[forbidden], undefined);
  }
});

test('group main and root fallback lanes ignore message, parent, and upper-message identities', () => {
  const main = normalizeFeishuInboundMessage(inboundMessage({
    message_id: 'om-main',
    chat_id: 'oc-group',
    chat_type: 'group',
  }), { accountRef: 'cli_app_a' });
  const firstReply = normalizeFeishuInboundMessage(inboundMessage({
    message_id: 'om-reply-1',
    chat_id: 'oc-group',
    chat_type: 'group',
    root_id: 'om-root',
    parent_id: 'om-parent-1',
    upper_message_id: 'om-upper-1',
  }, { eventId: 'evt-reply-1' }), { accountRef: 'cli_app_a' });
  const secondReply = normalizeFeishuInboundMessage(inboundMessage({
    message_id: 'om-reply-2',
    chat_id: 'oc-group',
    chat_type: 'group',
    root_id: 'om-root',
    parent_id: 'om-parent-2',
    upper_message_id: 'om-upper-2',
  }, { eventId: 'evt-reply-2' }), { accountRef: 'cli_app_a' });

  assert.equal(main.conversationLaneKey, 'feishu:cli_app_a:group:oc-group:chat');
  assert.equal(
    firstReply.conversationLaneKey,
    'feishu:cli_app_a:group:oc-group:reply:om-root',
  );
  assert.equal(secondReply.conversationLaneKey, firstReply.conversationLaneKey);
  assert.notEqual(
    secondReply.message.reply.targetRef,
    firstReply.message.reply.targetRef,
    'parent_id should change the opaque reply target',
  );
  for (const ignored of ['om-reply-1', 'om-parent-1', 'om-upper-1']) {
    assert.equal(firstReply.conversationLaneKey.includes(ignored), false);
  }
});

test('transport timestamps and event IDs do not masquerade as sourceOrder', () => {
  const sdk = normalizeFeishuInboundMessage(inboundMessage({}, { eventId: 'evt-sdk' }), {
    accountRef: 'cli_app_a',
  });
  const webhook = normalizeFeishuInboundMessage({
    ...inboundMessage({}, { eventId: 'discarded' }),
    event_id: undefined,
    header: { event_id: 'evt-webhook', create_time: '1788220800999' },
    create_time: undefined,
  }, { accountRef: 'cli_app_a' });

  assert.notEqual(sdk.eventId, webhook.eventId);
  assert.equal(sdk.payloadHash, webhook.payloadHash);
  assert.equal(sdk.sourceOrder, null);
  assert.equal(webhook.sourceOrder, null);
});

test('normalizes the real webhook event envelope and accepts only contract priorities', () => {
  const flat = inboundMessage({}, { eventId: 'discarded-flat-event' });
  const webhook = {
    header: {
      event_id: 'evt-real-webhook',
      event_type: 'im.message.receive_v1',
      create_time: '1788220800999',
    },
    event: {
      message: flat.message,
      sender: flat.sender,
    },
  };

  for (const priority of [1, 2, 3]) {
    const normalized = normalizeFeishuInboundMessage(webhook, {
      accountRef: 'cli_app_a',
      priority,
    });
    assert.equal(normalized.eventId, 'evt-real-webhook');
    assert.equal(normalized.message.source.messageId, 'om-p2p-1');
    assert.equal(normalized.message.policy.priority, priority);
  }
  for (const priority of [0, 4, 1.5]) {
    assert.throws(
      () => normalizeFeishuInboundMessage(webhook, { accountRef: 'cli_app_a', priority }),
      /priority must be one of 1, 2, or 3/,
    );
  }
});
