import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationResponseRuntimeAdapter } from '../src/lib/conversation-response-runtime-adapter.js';
import { normalizedCommandMentionsBot } from '../src/lib/feishu-inbound-normalizer.js';
import {
  openFeishuReplyComposition,
  resolveFeishuRouteTarget,
} from '../src/lib/feishu-reply-composition.js';
import { buildSmartModePrompt } from '../src/lib/smart-mode-prompt.js';
import { openSmartSilentMarkerStore } from '../src/lib/smart-silent-marker.js';
import { isSilentResponse } from '../src/lib/silent-response.js';
import { openTypingDoneMarkerStore } from '../src/lib/typing-done-marker.js';

const BOT_OPEN_ID = 'ou-bot-1';
const SMART_CHATS = new Set(['oc-smart']);

function smartEvent({
  eventId = 'evt-smart-1',
  messageId = 'om-smart-1',
  chatId = 'oc-smart',
  text = '随便看看',
  mentioned = false,
} = {}) {
  return {
    event_id: eventId,
    create_time: '1788220800000',
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      ...(mentioned
        ? { mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Bot' }] }
        : {}),
    },
    sender: { sender_id: { open_id: 'ou-human-1' }, tenant_key: 'tenant-1' },
  };
}

// Mirrors the service wiring in src/index.js: passive Smart-group messages are
// authorized but never bind presentation, carry the shared Smart policy prompt,
// and register a silent-disposition marker before Core sees the message.
function createServiceWiring({ smartMarkers, forwarded }) {
  const passiveSmart = (command) => {
    const target = resolveFeishuRouteTarget(command.source.targetRef);
    if (target.chatType !== 'group') return false;
    if (normalizedCommandMentionsBot(command, { botOpenId: BOT_OPEN_ID })) return false;
    return SMART_CHATS.has(target.chatId);
  };
  return {
    present: (rawEvent, normalized) => !passiveSmart(normalized.message),
    coreIntake: {
      async accept(command) {
        const target = resolveFeishuRouteTarget(command.source.targetRef);
        const passive = passiveSmart(command);
        const requestId = `assistant.feishu.${createHash('sha256')
          .update(command.source.messageId)
          .digest('hex')
          .slice(0, 40)}`;
        if (passive) {
          smartMarkers.mark(requestId, {
            messageId: command.source.messageId,
            chatId: target.chatId,
          });
        }
        forwarded.push({
          requestId,
          passive,
          text: passive ? `${buildSmartModePrompt()}${command.content.text}` : command.content.text,
        });
        return { schemaVersion: 1, type: 'MessageAccepted', requestId, traceId: command.traceId };
      },
    },
  };
}

function runEnvelope({ requestId, type, sequence = 1, output = 'done' }) {
  return {
    schemaVersion: 1,
    requestId,
    route: { channel: 'feishu', endpointId: 'oc-smart|type:group|msg:om-smart-1' },
    events: [{
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      requestId,
      sequence,
      type,
      payload: type === 'RunCompleted' ? { output } : { stage: 'tool' },
    }],
  };
}

function createRecordingStream(calls) {
  return {
    async open(input) { calls.push(['open', structuredClone(input)]); return { messageId: 'card-1' }; },
    async apply(input) {
      calls.push(['apply', structuredClone(input)]);
      const terminal = input.events.some(event => ['RunCompleted', 'RunFailed'].includes(event.type));
      return { handled: true, pending: false, status: terminal ? 'completed' : 'started' };
    },
  };
}

test('Smart silence keeps passive traffic invisible: [SKIP], trailing [SKIP], and failures produce zero outbound', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-smart-silence-'));
  const forwarded = [];
  const reactions = [];
  const cards = [];
  const streamCalls = [];
  let composition;
  try {
    const smartMarkers = openSmartSilentMarkerStore({
      directory: path.join(directory, 'smart-silent'),
    });
    const wiring = createServiceWiring({ smartMarkers, forwarded });
    composition = openFeishuReplyComposition({
      inboundDbPath: path.join(directory, 'inbound.db'),
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      present: wiring.present,
      coreIntake: wiring.coreIntake,
      reactionPort: {
        async add(effect) { reactions.push(['add', effect.requestId]); return { outcome: 'platform_accepted', reactionId: `reaction:${effect.requestId}` }; },
        async remove() { reactions.push(['remove']); return { outcome: 'platform_accepted' }; },
        async reconcile() { return { outcome: 'unknown' }; },
      },
      cardPort: {
        async apply(operation) { cards.push(['apply', operation.requestId]); return { outcome: 'platform_accepted', cardId: 'card-1' }; },
        async reconcile() { return { outcome: 'reconciled', cardId: 'card-1' }; },
      },
      delivery: {
        send: async () => ({ outcome: 'platform_accepted', externalRef: 'om-final' }),
        reconcile: async () => ({ outcome: 'reconciled', externalRef: 'om-final' }),
      },
      workerId: 'smart-silence',
      clock: () => 1_788_220_800_000,
      pollIntervalMs: 1,
    });

    const accepted = await composition.acceptMessage(smartEvent());
    const requestId = accepted.receipt.requestId;
    assert.equal(accepted.presentation, null);
    await composition.maintain();
    assert.deepEqual(reactions, []);
    assert.deepEqual(cards, []);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].passive, true);
    assert.match(forwarded[0].text, /^<smart-mode>/);

    const runtime = createConversationResponseRuntimeAdapter({
      stream: createRecordingStream(streamCalls),
      markers: openTypingDoneMarkerStore({ directory: path.join(directory, 'typing') }),
      silentGuard: {
        isSilentEligible: async (id) => smartMarkers.get(id) !== null,
        release: async (id) => { smartMarkers.release(id); },
      },
    });

    const exactSkip = await runtime.deliver(runEnvelope({
      requestId, type: 'RunCompleted', output: '[SKIP]',
    }));
    assert.equal(exactSkip.silent, true);
    const trailingSkip = await runtime.deliver(runEnvelope({
      requestId, type: 'RunCompleted', sequence: 2, output: '已有答案，无需补充。\n[SKIP]',
    }));
    assert.equal(trailingSkip.silent, true);
    const failure = await runtime.deliver(runEnvelope({ requestId, type: 'RunFailed', sequence: 3 }));
    assert.equal(failure.status, 'suppressed');
    const queued = await runtime.deliver(runEnvelope({ requestId, type: 'RunQueued', sequence: 4 }));
    assert.equal(queued.status, 'suppressed');

    assert.deepEqual(streamCalls, []);
    await composition.maintain();
    assert.deepEqual(reactions, []);
    assert.deepEqual(cards, []);
  } finally {
    await composition?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a passive substantive answer releases into exactly one normal reply', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-smart-substantive-'));
  const forwarded = [];
  const streamCalls = [];
  let composition;
  try {
    const smartMarkers = openSmartSilentMarkerStore({
      directory: path.join(directory, 'smart-silent'),
    });
    const wiring = createServiceWiring({ smartMarkers, forwarded });
    composition = openFeishuReplyComposition({
      inboundDbPath: path.join(directory, 'inbound.db'),
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      present: wiring.present,
      coreIntake: wiring.coreIntake,
      reactionPort: { async add() { return { outcome: 'platform_accepted', reactionId: 'r1' }; }, async remove() { return { outcome: 'platform_accepted' }; }, async reconcile() { return { outcome: 'unknown' }; } },
      cardPort: { async apply() { return { outcome: 'platform_accepted', cardId: 'card-1' }; }, async reconcile() { return { outcome: 'reconciled', cardId: 'card-1' }; } },
      delivery: {
        send: async () => ({ outcome: 'platform_accepted', externalRef: 'om-final' }),
        reconcile: async () => ({ outcome: 'reconciled', externalRef: 'om-final' }),
      },
      workerId: 'smart-substantive',
      clock: () => 1_788_220_800_000,
      pollIntervalMs: 1,
    });

    const accepted = await composition.acceptMessage(smartEvent({
      eventId: 'evt-smart-2',
      messageId: 'om-smart-2',
      text: '这个问题有人帮忙看下吗',
    }));
    const requestId = accepted.receipt.requestId;
    assert.equal(forwarded[0].passive, true);

    const runtime = createConversationResponseRuntimeAdapter({
      stream: createRecordingStream(streamCalls),
      markers: openTypingDoneMarkerStore({ directory: path.join(directory, 'typing') }),
      silentGuard: {
        isSilentEligible: async (id) => smartMarkers.get(id) !== null,
        release: async (id) => { smartMarkers.release(id); },
      },
    });

    const substantive = await runtime.deliver(runEnvelope({
      requestId, type: 'RunCompleted', output: '这是实质性回答',
    }));
    assert.equal(substantive.status, 'completed');
    assert.equal(substantive.silent, undefined);
    assert.deepEqual(streamCalls.map(([kind]) => kind), ['apply']);
    assert.equal(smartMarkers.get(requestId), null);

    // An inline mention of the marker is user content, not a silent decision.
    const inline = await runtime.deliver(runEnvelope({
      requestId, type: 'RunCompleted', sequence: 2, output: '大家在讨论 [SKIP] 的含义',
    }));
    assert.equal(inline.status, 'completed');
    assert.deepEqual(streamCalls.map(([kind]) => kind), ['apply', 'apply']);
  } finally {
    await composition?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit mentions keep the normal response path end to end', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-smart-mention-'));
  const forwarded = [];
  const reactions = [];
  const streamCalls = [];
  let composition;
  try {
    const smartMarkers = openSmartSilentMarkerStore({
      directory: path.join(directory, 'smart-silent'),
    });
    const wiring = createServiceWiring({ smartMarkers, forwarded });
    composition = openFeishuReplyComposition({
      inboundDbPath: path.join(directory, 'inbound.db'),
      presentationDbPath: path.join(directory, 'presentation.db'),
      accountRef: 'cli_app_a',
      authorize: async () => true,
      present: wiring.present,
      coreIntake: wiring.coreIntake,
      reactionPort: {
        async add(effect) { reactions.push(['add', effect.requestId]); return { outcome: 'platform_accepted', reactionId: `reaction:${effect.requestId}` }; },
        async remove() { reactions.push(['remove']); return { outcome: 'platform_accepted' }; },
        async reconcile() { return { outcome: 'unknown' }; },
      },
      cardPort: { async apply() { return { outcome: 'platform_accepted', cardId: 'card-1' }; }, async reconcile() { return { outcome: 'reconciled', cardId: 'card-1' }; } },
      delivery: {
        send: async () => ({ outcome: 'platform_accepted', externalRef: 'om-final' }),
        reconcile: async () => ({ outcome: 'reconciled', externalRef: 'om-final' }),
      },
      workerId: 'smart-mention',
      clock: () => 1_788_220_800_000,
      pollIntervalMs: 1,
    });

    const accepted = await composition.acceptMessage(smartEvent({
      eventId: 'evt-mention-1',
      messageId: 'om-mention-1',
      text: '@Bot 帮我查一下',
      mentioned: true,
    }));
    const requestId = accepted.receipt.requestId;
    assert.notEqual(accepted.presentation, null);
    await composition.maintain();
    assert.equal(reactions.filter(([kind]) => kind === 'add').length, 1);
    assert.equal(forwarded[0].passive, false);
    assert.equal(forwarded[0].text, '@Bot 帮我查一下');
    assert.equal(smartMarkers.get(requestId), null);

    const runtime = createConversationResponseRuntimeAdapter({
      stream: createRecordingStream(streamCalls),
      markers: openTypingDoneMarkerStore({ directory: path.join(directory, 'typing') }),
      silentGuard: {
        isSilentEligible: async (id) => smartMarkers.get(id) !== null,
        release: async (id) => { smartMarkers.release(id); },
      },
    });
    const result = await runtime.deliver(runEnvelope({
      requestId, type: 'RunCompleted', output: '查好了，结果如下',
    }));
    assert.equal(result.status, 'completed');
    assert.deepEqual(streamCalls.map(([kind]) => kind), ['apply']);
  } finally {
    await composition?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy and refactored paths share one silent-disposition contract', async () => {
  // The legacy terminal gate (scripts/send.js) and the refactored runtime guard
  // both resolve silence through isSilentResponse, and both consume the same
  // buildSmartModePrompt policy for passive evaluation.
  const legacyContract = [
    ['[SKIP]', true],
    ['解释文字。\n[SKIP]', true],
    ['[skip]', false],
    ['前缀 [SKIP]', false],
    ['[SKIP] 后缀', false],
  ];
  for (const [output, expected] of legacyContract) {
    assert.equal(isSilentResponse(output), expected, output);
  }
  assert.match(buildSmartModePrompt(), /Reply with exactly \[SKIP\] to stay silent/);

  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-smart-contract-'));
  try {
    const smartMarkers = openSmartSilentMarkerStore({
      directory: path.join(directory, 'smart-silent'),
    });
    const requestId = 'assistant.feishu.0123456789abcdef0123456789abcdef01234567';
    smartMarkers.mark(requestId, { messageId: 'om-contract-1', chatId: 'oc-smart' });
    const streamCalls = [];
    const runtime = createConversationResponseRuntimeAdapter({
      stream: createRecordingStream(streamCalls),
      markers: openTypingDoneMarkerStore({ directory: path.join(directory, 'typing') }),
      silentGuard: {
        isSilentEligible: async (id) => smartMarkers.get(id) !== null,
        release: async (id) => { smartMarkers.release(id); },
      },
    });
    for (const [output, silent] of legacyContract) {
      const result = await runtime.deliver(runEnvelope({
        requestId, type: 'RunCompleted', output,
      }));
      assert.equal(result.silent === true, silent, output);
      if (silent) assert.deepEqual(streamCalls, []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
