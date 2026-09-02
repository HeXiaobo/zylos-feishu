import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';

function eventFor(requestId, sequence, type, payload = {}) {
  return {
    schemaVersion: 1,
    eventId: `${requestId}:${sequence}`,
    requestId,
    sequence,
    type,
    occurredAt: 1_700_000_000 + sequence,
    payload,
  };
}

function event(sequence, type, payload = {}) {
  return eventFor('assistant.feishu.om_1', sequence, type, payload);
}

function createClient({ conversion = true, interactiveFailure = false } = {}) {
  const calls = [];
  let messages = 0;
  const send = async (kind, payload) => {
    calls.push([kind, payload]);
    const content = payload.data?.content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (interactiveFailure && parsed?.schema === '2.0') {
      return { code: 230001, msg: 'interactive unavailable' };
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

function cardElement(card, elementId) {
  return card.body.elements.find(element => element.element_id === elementId);
}

function processDetail(card) {
  return cardElement(card, 'zylos_progress')?.elements?.[0]?.content || '';
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
  const closeSettings = JSON.parse(closes[0].data.settings);
  assert.equal(finalCard.config.streaming_mode, false);
  assert.equal(finalCard.config.summary.content, '真实完整答案');
  assert.equal(closeSettings.config.summary.content, '真实完整答案');
  assert.equal(cardElement(finalCard, 'zylos_phase'), undefined);
  assert.equal(cardElement(finalCard, 'zylos_answer').content, '真实完整答案');
  assert.equal(finalCard.body.elements.length, 1);
  assert.equal(cardElement(finalCard, 'zylos_answer').element_id.length <= 20, true);
}));

test('visible Core events may start late and keep their original non-contiguous sequence', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(5, 'ProgressUpdated', { stage: 'reading' })],
  });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(9, 'RunCompleted', { output: '完成' })],
  });
  assert.equal(calls.filter(([name]) => name === 'update').length, 2);
  assert.equal(calls.filter(([name]) => name === 'close').length, 1);
}));

for (const conversion of [true, false]) {
  const mode = conversion ? 'CardKit' : 'ordinary-card fallback';
  test(`keeps interleaved requests and a background completion on separate cards in ${mode}`, () => withState(async stateDirectory => {
    const { client, calls } = createClient({ conversion });
    const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
    const requestA = 'assistant.feishu.om_A';
    const requestB = 'assistant.feishu.om_B';

    await stream.open({ requestId: requestA, target: target() });
    await stream.apply({
      requestId: requestA,
      events: [
        eventFor(requestA, 1, 'AssistantRequestAccepted', { sourceId: 'om_A' }),
        eventFor(requestA, 2, 'RunStarted'),
      ],
    });
    await stream.open({ requestId: requestB, target: target() });
    await stream.apply({
      requestId: requestB,
      events: [
        eventFor(requestB, 1, 'AssistantRequestAccepted', { sourceId: 'om_B' }),
        eventFor(requestB, 2, 'RunStarted'),
      ],
    });
    await stream.apply({
      requestId: requestA,
      events: [eventFor(requestA, 3, 'RunCompleted', { output: 'A 的答案' })],
    });
    await stream.sendCompleted({
      requestId: 'assistant.feishu.background_notice',
      target: target(),
      output: '独立后台通知',
    });
    await stream.apply({
      requestId: requestB,
      events: [eventFor(requestB, 3, 'RunCompleted', { output: 'B 的答案' })],
    });

    const terminalWrites = calls.flatMap(([operation, payload]) => {
      if (operation === 'update') {
        const card = JSON.parse(payload.data.card.data);
        return card.config.streaming_mode === false
          ? [{ target: payload.path.card_id, answer: cardElement(card, 'zylos_answer').content }]
          : [];
      }
      if (operation === 'patch') {
        const card = JSON.parse(payload.data.content);
        return card.config.streaming_mode === false
          ? [{ target: payload.path.message_id, answer: cardElement(card, 'zylos_answer').content }]
          : [];
      }
      return [];
    });

    assert.ok(terminalWrites.some(write => write.target.includes('om_response_1') && write.answer === 'A 的答案'));
    assert.ok(terminalWrites.some(write => write.target.includes('om_response_2') && write.answer === 'B 的答案'));
    const completedSends = calls.filter(([operation, payload]) => {
      if (operation !== 'send') return false;
      const card = JSON.parse(payload.data.content);
      return cardElement(card, 'zylos_answer')?.content === '独立后台通知';
    });
    assert.equal(completedSends.length, 1);
  }));
}

test('phase events stay visible while running and disappear when completion supplies the answer', () => withState(async stateDirectory => {
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
  assert.match(cardElement(progressCard, 'zylos_answer').content, /等待回答/);
  assert.equal(cardElement(progressCard, 'zylos_progress').header.title.content, '正在整理结果');
  assert.match(processDetail(progressCard), /正在分析问题/);
  assert.match(processDetail(progressCard), /正在整理结果/);
  assert.equal(processDetail(progressCard).includes('chain-of-thought'), false);
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(5, 'RunCompleted', { output: '只有完整答案，没有伪造 token 流。' })],
  });
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(finalCard, 'zylos_phase'), undefined);
  assert.equal(cardElement(finalCard, 'zylos_answer').content, '只有完整答案，没有伪造 token 流。');
  assert.equal(finalCard.body.elements.some(element => element.element_id === 'zylos_progress'), false);
}));

test('records a queued timeout without inventing a user-visible terminal', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    queuedTimeoutMs: 1_000,
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunQueued')],
  });
  const callsBeforeTimeout = calls.length;

  now = 2_001;
  const timedOut = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [],
  });

  assert.deepEqual(timedOut, {
    handled: true,
    pending: true,
    replayed: true,
    status: 'queued',
    reason: 'queued_timeout_observed',
  });
  assert.equal(calls.length, callsBeforeTimeout);
  const persisted = JSON.parse(fs.readFileSync(
    path.join(stateDirectory, fs.readdirSync(stateDirectory).find(name => name.endsWith('.json'))),
    'utf8',
  ));
  assert.equal(persisted.status, 'queued');
  assert.equal(persisted.compatibilityTerminal, false);
  assert.equal(persisted.queuedTimeoutObservedAt, now);
}));

test('fails a started stream after the configured main timeout with an honest retry terminal', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    mainTimeoutMs: 1_000,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'OutputDelta', { delta: '部分答案' }),
    ],
  });

  now = 2_001;
  const timedOut = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [],
  });

  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.reason, 'main_timeout');
  const terminalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(terminalCard, 'zylos_phase').content, '⚠️ 回复超时，请重试');
  assert.equal(cardElement(terminalCard, 'zylos_answer').content, '⚠️ 本次回复未生成，请重新发送。');
  assert.doesNotMatch(JSON.stringify(terminalCard), /部分答案/);
  assert.doesNotMatch(JSON.stringify(terminalCard), /没有可显示的回答/);
}));

test('sweeps a started stream into timeout without waiting for another delivery', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    mainTimeoutMs: 1_000,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunStarted')],
  });

  now = 2_001;
  const swept = await stream.sweepExpired();

  assert.deepEqual(swept, {
    checked: 1,
    expired: 1,
    failed: 0,
    presenceCompletionRequestIds: ['assistant.feishu.om_1'],
  });
  const retry = await stream.sweepExpired();
  assert.deepEqual(retry.presenceCompletionRequestIds, ['assistant.feishu.om_1']);
  assert.equal(await stream.acknowledgePresenceCompletion('assistant.feishu.om_1'), true);
  assert.deepEqual((await stream.sweepExpired()).presenceCompletionRequestIds, []);
  const terminalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(terminalCard, 'zylos_phase').content, '⚠️ 回复超时，请重试');
  assert.equal(cardElement(terminalCard, 'zylos_answer').content, '⚠️ 本次回复未生成，请重新发送。');
}));

test('removes stale partial output from every continuation card on main timeout', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    answerBytesPerCard: 300,
    mainTimeoutMs: 1_000,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target('group') });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'OutputDelta', { delta: 'x'.repeat(750) }),
    ],
  });
  assert.equal(calls.filter(([name]) => name === 'reply').length, 3);

  const updatesBeforeTimeout = calls.filter(([name]) => name === 'update').length;
  now = 2_001;
  await stream.sweepExpired();
  const timeoutUpdates = calls
    .filter(([name]) => name === 'update')
    .slice(updatesBeforeTimeout);

  assert.equal(timeoutUpdates.length, 3);
  for (const [, payload] of timeoutUpdates) {
    const card = JSON.parse(payload.data.card.data);
    assert.doesNotMatch(JSON.stringify(card), /x{20}/);
    assert.equal(cardElement(card, 'zylos_phase').content, '⚠️ 回复超时，请重试');
  }
}));

test('starts the main timeout only after RunStarted and keeps the queued timeout separate', () => withState(async stateDirectory => {
  const { client } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    queuedTimeoutMs: 1_000,
    mainTimeoutMs: 2_000,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunQueued')],
  });
  now = 1_999;
  const started = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(2, 'RunStarted')],
  });
  assert.equal(started.status, 'started');

  now = 3_998;
  const stillRunning = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [],
  });
  assert.equal(stillRunning.status, 'started');

  now = 3_999;
  const timedOut = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [],
  });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.reason, 'main_timeout');
}));

test('does not expire queued work that starts before the timeout boundary', () => withState(async stateDirectory => {
  const { client } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    queuedTimeoutMs: 1_000,
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunQueued')],
  });
  now = 1_999;
  const started = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(2, 'RunStarted')],
  });
  assert.equal(started.status, 'started');

  now = 10_000;
  const stillRunning = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [],
  });
  assert.equal(stillRunning.replayed, true);
  assert.equal(stillRunning.status, 'started');
}));

test('allows canonical completion to repair a queued-timeout compatibility terminal', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    queuedTimeoutMs: 1_000,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunQueued')],
  });
  now = 2_001;
  await stream.apply({ requestId: 'assistant.feishu.om_1', events: [] });
  const completed = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(2, 'RunStarted'),
      event(3, 'RunCompleted', { output: '延迟到达的真实答案' }),
    ],
  });

  assert.equal(completed.status, 'completed');
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(finalCard, 'zylos_answer').content, '延迟到达的真实答案');
  assert.doesNotMatch(JSON.stringify(finalCard), /排队超时/);
}));

test('allows canonical completion to repair a main-timeout compatibility terminal', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let now = 1_000;
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    clock: () => now,
    throttleMs: 0,
    mainTimeoutMs: 1_000,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunStarted')],
  });
  now = 2_001;
  await stream.apply({ requestId: 'assistant.feishu.om_1', events: [] });
  const completed = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(2, 'RunCompleted', { output: '迟到但真实的答案' }),
    ],
  });

  assert.equal(completed.status, 'completed');
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(finalCard, 'zylos_answer').content, '迟到但真实的答案');
  assert.doesNotMatch(JSON.stringify(finalCard), /回复超时/);
}));

test('keeps one current status collapsed above the streaming answer without numbered boilerplate', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'ProgressUpdated', { stage: 'reading' }),
      event(3, 'ProgressUpdated', { stage: 'organizing' }),
    ],
  });

  const card = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  const [status, answer] = card.body.elements;
  assert.equal(status.tag, 'collapsible_panel');
  assert.equal(status.element_id, 'zylos_progress');
  assert.equal(status.expanded, false);
  assert.equal(status.header.title.content, '正在整理结果');
  assert.equal(answer.element_id, 'zylos_answer');
  assert.match(answer.content, /等待回答/);
  assert.match(status.elements[0].content, /正在分析问题/);
  assert.match(status.elements[0].content, /正在读取资料/);
  assert.equal(/^\d+\./m.test(status.elements[0].content), false);
  assert.equal(card.body.elements.some(element => element.element_id === 'zylos_phase'), false);
}));

test('uses the compact thinking status before tool progress arrives', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(1, 'RunStarted')],
  });

  const card = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(card, 'zylos_progress').header.title.content, '思考中');
}));

test('keeps the collapsed process panel when CardKit falls back to ordinary card patches', () => withState(async stateDirectory => {
  const { client, calls } = createClient({ conversion: false });
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'ProgressUpdated', { stage: 'reading' }),
    ],
  });

  const card = JSON.parse(calls.filter(([name]) => name === 'patch').at(-1)[1].data.content);
  assert.equal(card.config.streaming_mode, false);
  assert.equal(cardElement(card, 'zylos_progress').tag, 'collapsible_panel');
  assert.equal(cardElement(card, 'zylos_progress').expanded, false);
  assert.match(cardElement(card, 'zylos_progress').elements[0].content, /正在读取资料/);
  assert.match(cardElement(card, 'zylos_answer').content, /等待回答/);
}));

test('uses a user-facing chat-list summary in both running card modes', async () => {
  for (const conversion of [true, false]) {
    await withState(async stateDirectory => {
      const { client, calls } = createClient({ conversion });
      const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
      await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
      await stream.apply({
        requestId: 'assistant.feishu.om_1',
        events: [event(1, 'RunStarted')],
      });

      const [kind, payload] = calls
        .filter(([name]) => name === (conversion ? 'update' : 'patch'))
        .at(-1);
      const card = JSON.parse(kind === 'update' ? payload.data.card.data : payload.data.content);
      assert.equal(card.config.summary.content, '正在回复…');
      assert.equal(card.config.summary.content.includes('Zylos'), false);
    });
  }
});

test('normalizes the completed answer into the ordinary-card chat-list summary', async () => {
  for (const chatType of ['p2p', 'group']) {
    await withState(async stateDirectory => {
      const { client, calls } = createClient({ conversion: false });
      const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
      const output = '# 真实结果\n\n- 已完成 [详情](https://example.com/result)';

      await stream.open({ requestId: 'assistant.feishu.om_1', target: target(chatType) });
      await stream.apply({
        requestId: 'assistant.feishu.om_1',
        events: [
          event(1, 'RunStarted'),
          event(2, 'RunCompleted', { output }),
        ],
      });

      const finalCard = JSON.parse(calls.filter(([name]) => name === 'patch').at(-1)[1].data.content);
      assert.equal(finalCard.config.summary.content, '真实结果 已完成 详情');
      assert.equal(cardElement(finalCard, 'zylos_answer').content, output);
    });
  }
});

test('rejects empty completed answers and preserves explicit failure summaries', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  const callsBeforeInvalidCompletion = calls.length;
  await assert.rejects(
    stream.apply({
      requestId: 'assistant.feishu.om_1',
      events: [event(1, 'RunCompleted', { output: ' \n\t' })],
    }),
    error => error?.code === 'MISSING_OUTPUT',
  );
  assert.equal(calls.length, callsBeforeInvalidCompletion);

  await withState(async failedStateDirectory => {
    const failed = createClient();
    const failedStream = createConversationResponseStream({
      client: failed.client,
      stateDirectory: failedStateDirectory,
      throttleMs: 0,
    });
    await failedStream.open({ requestId: 'assistant.feishu.om_1', target: target() });
    await failedStream.apply({
      requestId: 'assistant.feishu.om_1',
      events: [event(1, 'RunFailed', { retryable: true })],
    });
    const finalCard = JSON.parse(failed.calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
    assert.equal(finalCard.config.summary.content, '⚠️ 本次处理未完成，可重试');
    assert.match(cardElement(finalCard, 'zylos_answer').content, /请重新发送/);
    assert.doesNotMatch(cardElement(finalCard, 'zylos_answer').content, /没有可显示的回答/);
  });
}));

test('can hide transient process UI while continuing to stream the answer', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    processDisplay: 'answer_only',
  });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'ProgressUpdated', { stage: 'executing' }),
      event(3, 'PublicReasoningDelta', { delta: '这段公开摘要也不应占用卡片。' }),
      event(4, 'OutputDelta', { delta: '答案正在逐步出现。' }),
    ],
  });

  const card = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.deepEqual(card.body.elements.map(element => element.element_id), ['zylos_answer']);
  assert.equal(card.body.elements[0].content, '答案正在逐步出现。');
  assert.equal(card.config.streaming_mode, true);
}));

test('keeps long completed answers free of extra copy actions', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'RunCompleted', { output: '这是一段需要方便复制的较长回答。'.repeat(12) }),
    ],
  });

  const card = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(Buffer.byteLength(card.config.summary.content, 'utf8') <= 120, true);
  assert.equal(card.config.summary.content.endsWith('…'), true);
  assert.equal(cardElement(card, 'zylos_answer').content, '这是一段需要方便复制的较长回答。'.repeat(12));
  assert.equal(card.body.elements.some(element => element.element_id === 'zylos_copy'), false);
  assert.deepEqual(card.body.elements.map(element => element.tag), ['markdown']);
}));

test('sends proactive text as the same completed response card without a placeholder', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  const output = '主动汇报也应该使用统一的完成卡片。';

  const sent = await stream.sendCompleted({
    requestId: 'assistant.feishu.proactive.1',
    target: target(),
    output,
  });
  const replay = await stream.sendCompleted({
    requestId: 'assistant.feishu.proactive.1',
    target: target(),
    output,
  });

  assert.equal(sent.messageId, 'om_response_1');
  assert.equal(replay.replayed, true);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
  assert.equal(calls.filter(([name]) => name === 'convert').length, 0);
  const card = JSON.parse(calls.find(([name]) => name === 'send')[1].data.content);
  assert.equal(card.config.streaming_mode, false);
  assert.equal(card.config.summary.content, output);
  assert.equal(cardElement(card, 'zylos_phase'), undefined);
  assert.equal(cardElement(card, 'zylos_answer').content, output);
  assert.equal(card.body.elements.length, 1);
}));

test('persists proactive delivery intent and retries the same Feishu UUID after an unknown outcome', () => withState(async stateDirectory => {
  const attempts = [];
  let loseFirstResponse = true;
  const { client, calls } = createClient();
  const originalCreate = client.im.message.create;
  client.im.message.create = async payload => {
    attempts.push(payload.data.uuid);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error('response lost after Feishu accepted the card');
    }
    return originalCreate(payload);
  };
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  const request = {
    requestId: 'c4.delivery.4821',
    target: target(),
    output: '稳定投递的主动消息',
  };

  await assert.rejects(
    stream.sendCompleted(request),
    error => error?.code === 'FEISHU_DELIVERY_OUTCOME_UNKNOWN',
  );
  const pending = JSON.parse(fs.readFileSync(
    path.join(stateDirectory, fs.readdirSync(stateDirectory).find(name => name.endsWith('.json'))),
    'utf8',
  ));
  assert.equal(pending.delivery.status, 'pending');
  assert.equal(pending.output, request.output);

  const recovered = await stream.sendCompleted(request);
  assert.equal(recovered.replayed, false);
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
}));

test('uses one idempotent plain fallback only after Feishu explicitly rejects a proactive card', () => withState(async stateDirectory => {
  const { client, calls } = createClient({ interactiveFailure: true });
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });
  const request = {
    requestId: 'c4.delivery.explicit-reject',
    target: target(),
    output: '纯文本安全降级',
  };

  const delivered = await stream.sendCompleted(request);
  const replay = await stream.sendCompleted(request);
  const textSends = calls.filter(([, payload]) => Object.hasOwn(JSON.parse(payload.data.content), 'text'));

  assert.equal(delivered.mode, 'plain_text');
  assert.equal(replay.replayed, true);
  assert.equal(textSends.length, 1);
  assert.equal(JSON.parse(textSends[0][1].data.content).text, request.output);
}));

test('treats a completed pre-v2 state without delivery metadata as an already-sent replay', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  const request = {
    requestId: 'assistant.feishu.legacy-completed',
    target: target(),
    output: '旧版已发送回答',
  };
  await stream.sendCompleted(request);
  const filePath = path.join(
    stateDirectory,
    fs.readdirSync(stateDirectory).find(name => name.endsWith('.json')),
  );
  const legacy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  delete legacy.delivery;
  delete legacy.outputHash;
  delete legacy.terminalAt;
  delete legacy.terminalTombstone;
  legacy.output = request.output;
  fs.writeFileSync(filePath, `${JSON.stringify(legacy)}\n`);

  const replay = await stream.sendCompleted(request);
  assert.equal(replay.replayed, true);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
}));

test('streams public reasoning in its own card region without mixing it into the answer', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'PublicReasoningDelta', { delta: '先核对任务边界。\n' }),
      event(5, 'PublicReasoningDelta', { delta: '再验证关键数据。\n' }),
      event(6, 'OutputDelta', { delta: '这是答案。' }),
    ],
  });

  const card = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(cardElement(card, 'zylos_answer').content, '这是答案。');
  assert.equal(cardElement(card, 'zylos_progress').header.title.content, '正在生成回答');
  assert.match(processDetail(card), /正在分析问题[\s\S]*正在生成回答/);
  assert.match(processDetail(card), /工作摘要/);
  assert.match(processDetail(card), /先核对任务边界。[\s\S]*再验证关键数据。/);
  assert.match(processDetail(card), /不含模型隐藏思维/);

  const persisted = JSON.parse(fs.readFileSync(
    fs.readdirSync(stateDirectory)
      .filter(name => name.endsWith('.json'))
      .map(name => path.join(stateDirectory, name))[0],
    'utf8',
  ));
  assert.equal(persisted.output, '这是答案。');
  assert.equal(persisted.publicReasoning, '先核对任务边界。\n再验证关键数据。\n');

  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(7, 'RunCompleted', { output: '这是最终答案。' })],
  });
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(finalCard.body.elements.some(element => element.element_id === 'zylos_progress'), false);
  const finalState = JSON.parse(fs.readFileSync(
    fs.readdirSync(stateDirectory)
      .filter(name => name.endsWith('.json'))
      .map(name => path.join(stateDirectory, name))[0],
    'utf8',
  ));
  assert.equal(finalState.publicReasoning, '');
  assert.deepEqual(finalState.progress, []);
  assert.equal(finalState.output, undefined);
  assert.match(finalState.outputHash, /^[a-f0-9]{64}$/);
  assert.equal(finalState.terminalTombstone, true);
  assert.equal(JSON.stringify(finalState).includes('这是最终答案。'), false);
}));

test('keeps a bounded, de-duplicated public progress trace across restart', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const first = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await first.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await first.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_trace' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'ProgressUpdated', { stage: 'reading' }),
      event(5, 'ProgressUpdated', { stage: 'reading' }),
    ],
  });
  const second = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await second.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(6, 'ProgressUpdated', { stage: 'querying' })],
  });

  const runningCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  const trace = processDetail(runningCard);
  assert.equal((trace.match(/正在读取资料/g) || []).length, 1);
  assert.match(trace, /正在分析问题[\s\S]*正在读取资料[\s\S]*正在查询数据/);
  await second.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(7, 'RunCompleted', { output: '完成' })],
  });
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(finalCard.body.elements.some(element => element.element_id === 'zylos_progress'), false);
}));

test('renders fixed public action progress without exposing model-authored summaries', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'ProgressUpdated', {
        stage: 'searching',
        action: 'search_sources',
        status: 'started',
        summary: 'private model text must not render',
      }),
      event(3, 'ProgressUpdated', {
        stage: 'searching',
        action: 'search_sources',
        status: 'completed',
        summary: 'another private model text must not render',
      }),
    ],
  });

  const runningCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  const trace = processDetail(runningCard);
  assert.match(trace, /正在分析问题[\s\S]*正在查找相关信息[\s\S]*已找到相关信息/);
  assert.equal(JSON.stringify(runningCard).includes('private model text'), false);
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(4, 'RunCompleted', { output: '完成' })],
  });
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(finalCard.body.elements.some(element => element.element_id === 'zylos_progress'), false);
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

test('patches every continuation card when CardKit conversion becomes unavailable', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let conversionAttempts = 0;
  client.cardkit.v1.card.idConvert = async payload => {
    calls.push(['convert', payload]);
    conversionAttempts += 1;
    return conversionAttempts === 1
      ? { code: 0, data: { card_id: 'AA_initial' } }
      : { code: 230001, msg: 'deep card conversion unavailable' };
  };
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    answerBytesPerCard: 300,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target('group') });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'RunStarted'),
      event(2, 'RunCompleted', { output: '混合深层卡片内容'.repeat(260) }),
    ],
  });

  const continuationReplies = calls
    .filter(([name]) => name === 'reply')
    .slice(1);
  const patchedMessageIds = calls
    .filter(([name]) => name === 'patch')
    .map(([, payload]) => payload.path.message_id);
  assert.equal(continuationReplies.length >= 2, true);
  assert.equal(patchedMessageIds.length, continuationReplies.length);
  assert.deepEqual(
    patchedMessageIds,
    continuationReplies.map(([, payload], index) => `om_response_${index + 2}`),
  );
  assert.equal(calls.filter(([name]) => name === 'update').length, 1);
  assert.equal(conversionAttempts, continuationReplies.length + 1);
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

test('retries the same terminal projection when CardKit close fails after the content update', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let closeAttempts = 0;
  client.cardkit.v1.card.settings = async payload => {
    calls.push(['close', payload]);
    closeAttempts += 1;
    return closeAttempts === 1
      ? { code: 230099, msg: 'temporary close failure' }
      : { code: 0 };
  };
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
    ],
  });

  await assert.rejects(
    stream.apply({
      requestId: 'assistant.feishu.om_1',
      events: [event(4, 'RunCompleted', { output: '可恢复终态' })],
    }),
    /temporary close failure/,
  );
  const retried = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(4, 'RunCompleted', { output: '可恢复终态' })],
  });

  assert.equal(retried.replayed, false);
  assert.equal(retried.status, 'completed');
  assert.equal(calls.filter(([name]) => name === 'close').length, 2);
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

test('does not send a second plain message when placeholder delivery has an unknown outcome', () => withState(async stateDirectory => {
  const attempts = [];
  let loseFirstResponse = true;
  const { client, calls } = createClient();
  const originalCreate = client.im.message.create;
  client.im.message.create = async payload => {
    attempts.push(payload.data.uuid);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error('socket closed after upload');
    }
    return originalCreate(payload);
  };
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });

  await assert.rejects(
    stream.open({ requestId: 'assistant.feishu.om_1', target: target() }),
    error => error?.code === 'FEISHU_DELIVERY_OUTCOME_UNKNOWN',
  );
  assert.equal(calls.filter(([name]) => name === 'send').length, 0);

  const recovered = await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  assert.equal(recovered.replayed, false);
  assert.deepEqual(attempts, [attempts[0], attempts[0]]);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
  const persisted = JSON.parse(fs.readFileSync(
    fs.readdirSync(stateDirectory).find(name => name.endsWith('.json'))
      ? path.join(stateDirectory, fs.readdirSync(stateDirectory).find(name => name.endsWith('.json')))
      : '',
    'utf8',
  ));
  assert.equal(persisted.delivery.status, 'sent');
}));

test('keeps the sent placeholder and repairs CardKit conversion without sending a second placeholder', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const originalConvert = client.cardkit.v1.card.idConvert;
  let conversionAttempts = 0;
  client.cardkit.v1.card.idConvert = async payload => {
    conversionAttempts += 1;
    if (conversionAttempts === 1) throw new Error('temporary conversion transport failure');
    return originalConvert(payload);
  };
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });

  const opened = await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  assert.equal(opened.mode, 'conversion_pending');
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);

  const applied = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
    ],
  });
  assert.equal(applied.status, 'started');
  assert.equal(conversionAttempts, 2);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
  assert.equal(calls.filter(([name]) => name === 'update').length, 1);
}));

test('repairs compatibility completion through the existing placeholder when CardKit conversion fails', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  client.cardkit.v1.card.idConvert = async payload => {
    calls.push(['convert', payload]);
    throw new Error('conversion transport remains unavailable');
  };
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });

  const opened = await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  assert.equal(opened.mode, 'conversion_pending');
  const completed = await stream.completeWithFullAnswer({
    requestId: 'assistant.feishu.om_1',
    output: '等待可靠事件投影的答案',
  });

  assert.equal(completed.handled, true);
  assert.equal(completed.pending, undefined);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
  assert.equal(calls.filter(([name]) => name === 'patch').length, 2);
  const terminalCard = JSON.parse(calls.filter(([name]) => name === 'patch').at(-1)[1].data.content);
  assert.equal(cardElement(terminalCard, 'zylos_answer').content, '等待可靠事件投影的答案');
}));

test('projects an explicit failure notice when C4 rejects while CardKit conversion fails', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  client.cardkit.v1.card.idConvert = async payload => {
    calls.push(['convert', payload]);
    throw new Error('conversion transport remains unavailable');
  };
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  const failed = await stream.fail({ requestId: 'assistant.feishu.om_1', retryable: true });

  assert.equal(failed.handled, true);
  assert.equal(failed.pending, undefined);
  const terminalCard = JSON.parse(calls.filter(([name]) => name === 'patch').at(-1)[1].data.content);
  assert.equal(cardElement(terminalCard, 'zylos_phase').content, '⚠️ 本次处理未完成，可重试');
  assert.equal(cardElement(terminalCard, 'zylos_answer').content, '⚠️ 本次回复未生成，请重新发送。');
  assert.doesNotMatch(JSON.stringify(terminalCard), /没有可显示的回答/);
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
  const compatibilityCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  const compatibilityClose = JSON.parse(calls.filter(([name]) => name === 'close').at(-1)[1].data.settings);
  assert.equal(compatibilityCard.config.summary.content, '兼容完整答案');
  assert.equal(compatibilityClose.config.summary.content, '兼容完整答案');
  assert.equal(cardElement(compatibilityCard, 'zylos_phase'), undefined);
  assert.equal(cardElement(compatibilityCard, 'zylos_answer').content, '兼容完整答案');
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

test('canonical Core completion corrects an earlier local ambiguous failure on the same card', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.fail({ requestId: 'assistant.feishu.om_1', retryable: true });
  const callsAfterLocalFailure = calls.length;

  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
    ],
  });
  assert.equal(calls.length, callsAfterLocalFailure, 'nonterminal replay must not mutate a locally closed card');

  const completed = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(4, 'RunCompleted', { output: 'Core 的最终答案' })],
  });
  assert.equal(completed.status, 'completed');
  const finalUpdate = calls.filter(([name]) => name === 'update').at(-1)[1];
  const finalCard = JSON.parse(finalUpdate.data.card.data);
  assert.equal(cardElement(finalCard, 'zylos_phase'), undefined);
  assert.equal(cardElement(finalCard, 'zylos_answer').content, 'Core 的最终答案');
}));

test('canonical Core completion corrects an earlier local failure in plain-text fallback', () => withState(async stateDirectory => {
  const { client, calls } = createClient({ interactiveFailure: true });
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.fail({ requestId: 'assistant.feishu.om_1', retryable: true });

  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunQueued'),
      event(3, 'RunStarted'),
      event(4, 'RunCompleted', { output: 'Core 的纯文本最终答案' }),
    ],
  });

  const texts = calls.flatMap(([, payload]) => {
    const content = JSON.parse(payload.data?.content || '{}');
    return typeof content.text === 'string' ? [content.text] : [];
  });
  assert.deepEqual(texts, [
    '已接收，正在处理…',
    '⚠️ 本次回复未生成，请重新发送。',
    'Core 的纯文本最终答案',
  ]);
}));

test('renders an explicit retry instruction for a compatibility failure instead of an empty answer card', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });

  await stream.fail({ requestId: 'assistant.feishu.om_1', retryable: true });

  const terminalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(terminalCard.config.summary.content, '⚠️ 本次处理未完成，可重试');
  assert.equal(cardElement(terminalCard, 'zylos_phase').content, '⚠️ 本次处理未完成，可重试');
  assert.equal(cardElement(terminalCard, 'zylos_answer').content, '⚠️ 本次回复未生成，请重新发送。');
  assert.doesNotMatch(JSON.stringify(terminalCard), /没有可显示的回答/);
}));

test('retries a deferred terminal projection after both CardKit conversion and patch fail', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let patchFailures = 1;
  client.cardkit.v1.card.idConvert = async payload => {
    calls.push(['convert', payload]);
    throw new Error('conversion transport remains unavailable');
  };
  client.im.v1.message.patch = async payload => {
    calls.push(['patch', payload]);
    if (patchFailures > 0) {
      patchFailures -= 1;
      throw new Error('patch transport remains unavailable');
    }
    return { code: 0 };
  };
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn() {} },
  });

  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  const deferred = await stream.fail({ requestId: 'assistant.feishu.om_1', retryable: true });
  assert.equal(deferred.pending, true);

  const repaired = await stream.apply({ requestId: 'assistant.feishu.om_1', events: [] });
  assert.equal(repaired.repaired, true);
  const terminalCard = JSON.parse(calls.filter(([name]) => name === 'patch').at(-1)[1].data.content);
  assert.equal(cardElement(terminalCard, 'zylos_phase').content, '⚠️ 本次处理未完成，可重试');
  assert.equal(cardElement(terminalCard, 'zylos_answer').content, '⚠️ 本次回复未生成，请重新发送。');
}));

test('legacy compatibility completion cannot overwrite an existing terminal result', () => withState(async stateDirectory => {
  const { client } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.completeWithFullAnswer({
    requestId: 'assistant.feishu.om_1',
    output: '第一个终态答案',
  });

  await assert.rejects(
    stream.completeWithFullAnswer({
      requestId: 'assistant.feishu.om_1',
      output: '冲突的第二个答案',
    }),
    error => error?.code === 'ASSISTANT_TERMINAL_CONFLICT',
  );
}));

test('ignores and diagnoses a higher-sequence event that arrives after canonical terminal state', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const warnings = [];
  const stream = createConversationResponseStream({
    client,
    stateDirectory,
    throttleMs: 0,
    logger: { warn(message, details) { warnings.push([message, details]); } },
  });
  await stream.open({ requestId: 'assistant.feishu.om_1', target: target() });
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [
      event(1, 'AssistantRequestAccepted', { sourceId: 'om_1' }),
      event(2, 'RunStarted'),
      event(3, 'RunCompleted', { output: '不可变终态' }),
    ],
  });
  const callsAtTerminal = calls.length;

  const late = await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(4, 'OutputDelta', { delta: '迟到且不得覆盖' })],
  });

  assert.deepEqual(late, {
    handled: true,
    ignored: true,
    reason: 'terminal_state',
    status: 'completed',
  });
  assert.equal(calls.length, callsAtTerminal);
  assert.deepEqual(warnings, [[
    'Ignored response event after terminal state',
    {
      requestId: 'assistant.feishu.om_1',
      status: 'completed',
      lastEventSequence: 3,
      receivedSequences: [4],
    },
  ]]);
}));
