import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';

function event(sequence, type, payload = {}) {
  return {
    schemaVersion: 1,
    eventId: `assistant.feishu.om_1:${sequence}`,
    requestId: 'assistant.feishu.om_1',
    sequence,
    type,
    occurredAt: 1_700_000_000 + sequence,
    payload,
  };
}

function createClient({ conversion = true, interactiveFailure = false } = {}) {
  const calls = [];
  let messages = 0;
  const send = async (kind, payload) => {
    calls.push([kind, payload]);
    const content = payload.data?.content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (interactiveFailure && parsed?.schema === '2.0') {
      throw new Error('interactive unavailable');
    }
    messages += 1;
    return { code: 0, data: { message_id: `om_response_${messages}` } };
  };
  const client = {
    im: {
      message: {
        create: payload => send('send', payload),
        reply: payload => send('reply', payload),
      },
      v1: {
        message: {
          async patch(payload) {
            calls.push(['patch', payload]);
            return { code: 0 };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert(payload) {
            calls.push(['convert', payload]);
            return conversion
              ? { code: 0, data: { card_id: `AA_${payload.data.message_id}` } }
              : { code: 230001, msg: 'CardKit unavailable' };
          },
          async update(payload) {
            calls.push(['update', payload]);
            return { code: 0 };
          },
          async settings(payload) {
            calls.push(['close', payload]);
            return { code: 0 };
          },
        },
      },
    },
  };
  return { client, calls };
}

function target(chatType = 'p2p') {
  return {
    chatId: 'oc_chat_1',
    chatType,
    replyToMessageId: chatType === 'group' ? 'om_1' : null,
  };
}

function withState(testFn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-response-stream-'));
  return Promise.resolve()
    .then(() => testFn(directory))
    .finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('opens once, coalesces real deltas, keeps sequence monotonic, and closes the same card', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    pause: async milliseconds => { now += milliseconds; },
  });
  const opened = await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  const replay = await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  assert.equal(opened.messageId, 'om_response_1');
  assert.equal(replay.replayed, true);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);

  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'ProgressUpdated', { stage: 'reading', hidden: 'secret=must-not-render' }),
      event(5, 'OutputDelta', { delta: '真实' }),
      event(6, 'OutputDelta', { delta: '增量' }),
    ],
  });
  const updatesAfterDelta = calls.filter(([name]) => name === 'update');
  assert.equal(updatesAfterDelta.length, 1, 'one batch must coalesce both deltas into one CardKit update');
  const deltaCard = JSON.parse(updatesAfterDelta[0][1].data.card.data);
  assert.equal(deltaCard.body.elements[1].content, '真实增量');
  assert.equal(JSON.stringify(deltaCard).includes('must-not-render'), false);

  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(7, 'RunCompleted', { output: '真实完整答案' })],
  });
  const updates = calls.filter(([name]) => name === 'update').map(([, payload]) => payload);
  const closes = calls.filter(([name]) => name === 'close').map(([, payload]) => payload);
  assert.deepEqual(updates.map(call => call.data.sequence), [1, 2]);
  assert.deepEqual(closes.map(call => call.data.sequence), [3]);
  const finalCard = JSON.parse(updates.at(-1).data.card.data);
  assert.equal(finalCard.config.streaming_mode, false);
  assert.equal(finalCard.body.elements[0].content, '✅ 已完成');
  assert.equal(finalCard.body.elements[1].content, '真实完整答案');
  assert.equal(finalCard.body.elements[0].element_id.length <= 20, true);
  assert.equal(finalCard.body.elements[1].element_id.length <= 20, true);
}));

test('phase events never fabricate answer deltas and completion may supply one full answer', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
  });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'ProgressUpdated', { stage: 'organizing' }),
    ],
  });
  const progressCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.match(progressCard.body.elements[1].content, /等待回答/);
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(5, 'RunCompleted', { output: '只有完整答案，没有伪造 token 流。' })],
  });
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(finalCard.body.elements[1].content, '只有完整答案，没有伪造 token 流。');
}));

test('swaps to continuation cards only when the verified answer exceeds one card', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    answerBytesPerCard: 300,
  });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target('group') });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'OutputDelta', { delta: 'x'.repeat(750) }),
    ],
  });
  assert.equal(calls.filter(([name]) => name === 'reply').length, 3);
  assert.equal(calls.filter(([name]) => name === 'close').length >= 2, true);
  const cards = calls
    .filter(([name]) => name === 'reply')
    .map(([, payload]) => JSON.parse(payload.data.content));
  assert.equal(cards[0].body.elements[1].content.includes('续'), false);
  assert.match(cards[1].body.elements[1].content, /续 2/);
  assert.match(cards[2].body.elements[1].content, /续 3/);
}));

test('overlong output remains deliverable when CardKit conversion is unavailable', () => withState(async stateDirectory => {
  const { client, calls } = createClient({ conversion: false });
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    answerBytesPerCard: 300,
    logger: { warn() {} },
  });
  const opened = await stream.open({ requestId: 'assistant.feishu.om_1', target: target('group') });
  assert.equal(opened.mode, 'ordinary_card');
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'RunCompleted', { output: '降级'.repeat(260) }),
    ],
  });
  assert.equal(calls.filter(([name]) => name === 'reply').length >= 3, true);
  assert.equal(calls.filter(([name]) => name === 'patch').length >= 2, true);
  assert.equal(calls.some(([name]) => name === 'update' || name === 'close'), false);
}));

test('survives process restart and resumes from persisted sequence without duplicate send', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const first = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await first.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await first.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
    ],
  });
  const second = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await second.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(4, 'RunCompleted', { output: '重启后完成' })],
  });
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
  assert.deepEqual(
    calls.filter(([name]) => name === 'update').map(([, payload]) => payload.data.sequence),
    [1, 2],
  );
}));

test('serializes worker updates with the compatibility full-answer process', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const originalUpdate = client.cardkit.v1.card.update;
  let enterUpdate;
  let releaseUpdate;
  const updateEntered = new Promise(resolve => { enterUpdate = resolve; });
  const updateGate = new Promise(resolve => { releaseUpdate = resolve; });
  client.cardkit.v1.card.update = async payload => {
    enterUpdate();
    await updateGate;
    return originalUpdate(payload);
  };
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  const progress = stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
    ],
  });
  await updateEntered;
  let compatibilityFinished = false;
  const compatibility = stream.completeWithFullAnswer({
    requestId: 'assistant.feishu.om_1',
    output: '并发兼容答案',
  }).then(result => {
    compatibilityFinished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(compatibilityFinished, false);
  releaseUpdate();
  await Promise.all([progress, compatibility]);

  assert.deepEqual(
    calls.filter(([name]) => name === 'update').map(([, payload]) => payload.data.sequence),
    [1, 2],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === 'close').map(([, payload]) => payload.data.sequence),
    [3],
  );
}));

test('falls back to plain text when interactive creation fails and sends one terminal answer', () => withState(async stateDirectory => {
  const { client, calls } = createClient({ interactiveFailure: true });
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0, logger: { warn() {} } });
  const opened = await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  assert.equal(opened.mode, 'plain_text');
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'RunCompleted', { output: '纯文本降级答案' }),
    ],
  });
  const textSends = calls.filter(([, payload]) => {
    const content = JSON.parse(payload.data.content);
    return Object.hasOwn(content, 'text');
  });
  assert.equal(textSends.length, 2);
  assert.equal(JSON.parse(textSends[1][1].data.content).text, '纯文本降级答案');
}));

test('legacy full-answer completion finalizes the existing card and durable terminal replay is a no-op', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  const completed = await stream.completeWithFullAnswer({
    requestId: 'assistant.feishu.om_1',
    output: '兼容完整答案',
  });
  assert.equal(completed.handled, true);
  const apiCallCount = calls.length;
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'RunCompleted', { output: '兼容完整答案' }),
    ],
  });
  assert.equal(calls.length, apiCallCount, 'durable replay must not reopen or duplicate a closed compatibility card');
}));
