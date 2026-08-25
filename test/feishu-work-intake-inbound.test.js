import assert from 'node:assert/strict';
import test from 'node:test';

import { createFeishuWorkIntakeInboundAdapter } from '../src/lib/feishu-work-intake-inbound.js';

const adapter = createFeishuWorkIntakeInboundAdapter({
  intentRevision: 1,
  timeZone: 'Asia/Shanghai',
});

function message(overrides = {}) {
  return {
    messageId: overrides.messageId ?? 'om_inbound',
    chatId: overrides.chatId ?? 'oc_inbound',
    chatType: overrides.chatType ?? 'p2p',
    threadId: overrides.threadId ?? null,
    senderId: overrides.senderId ?? 'ou_sender',
    text: overrides.text ?? '请玥然整理客户记录',
    mentionedBot: overrides.mentionedBot ?? false,
    receivedAt: overrides.receivedAt ?? '2026-08-25T03:00:00.000Z',
    mentions: overrides.mentions ?? [],
  };
}

test('maps Feishu identity and message metadata to a channel-neutral envelope', () => {
  assert.deepEqual(adapter.toEnvelope(message()), {
    source: {
      channel: 'feishu',
      messageId: 'om_inbound',
      conversationId: 'oc_inbound',
      conversationType: 'direct',
      threadId: null,
    },
    sender: { id: 'ou_sender', kind: 'human' },
    text: '请玥然整理客户记录',
    intentRevision: 1,
    receivedAt: '2026-08-25T03:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    people: [],
  });
});

test('group WorkIntake is disabled without @玥然 and enabled with a bot mention', () => {
  assert.equal(adapter.toEnvelope(message({ chatType: 'group', mentionedBot: false })), null);
  const envelope = adapter.toEnvelope(message({
    chatType: 'group',
    mentionedBot: true,
    threadId: 'omt_topic',
    mentions: [
      { name: '玥然', id: 'ou_bot', candidateIds: ['ou_bot'], kind: 'agent', isBot: true },
      { name: '小王', id: 'ou_wang', candidateIds: ['ou_wang'], kind: 'human', isBot: false },
    ],
  }));
  assert.equal(envelope.source.conversationType, 'group');
  assert.equal(envelope.source.threadId, 'omt_topic');
  assert.deepEqual(envelope.people, [{
    name: '小王',
    id: 'ou_wang',
    candidateIds: ['ou_wang'],
    kind: 'human',
  }]);
});

test('rejects malformed or SDK-leaking normalized input', () => {
  assert.throws(() => adapter.toEnvelope({ ...message(), sdkEvent: {} }), /unsupported/);
  assert.throws(() => adapter.toEnvelope(message({ senderId: '' })), /non-empty/);
  assert.throws(() => adapter.toEnvelope(message({ chatType: 'topic' })), /unsupported/);
});
