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
  assert.match(progressCard.body.elements[1].content, /等待回答/);
  assert.match(progressCard.body.elements[2].content, /正在分析问题/);
  assert.match(progressCard.body.elements[2].content, /正在整理结果/);
  assert.equal(progressCard.body.elements[2].content.includes('chain-of-thought'), false);
  await stream.apply({
    requestId: 'assistant.feishu.om_1',
    events: [event(5, 'RunCompleted', { output: '只有完整答案，没有伪造 token 流。' })],
  });
  const finalCard = JSON.parse(calls.filter(([name]) => name === 'update').at(-1)[1].data.card.data);
  assert.equal(finalCard.body.elements[1].content, '只有完整答案，没有伪造 token 流。');
  assert.equal(finalCard.body.elements.some(element => element.element_id === 'zylos_progress'), false);
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
  assert.equal(card.body.elements.some(element => element.element_id === 'zylos_copy'), false);
  assert.deepEqual(card.body.elements.map(element => element.tag), ['markdown', 'markdown']);
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
  assert.equal(card.body.elements[0].content, '✅ 已完成');
  assert.equal(card.body.elements[1].content, output);
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
  assert.equal(card.body.elements[1].content, '这是答案。');
  assert.match(card.body.elements[2].content, /处理过程（实时）/);
  assert.match(card.body.elements[2].content, /正在分析问题[\s\S]*正在生成回答/);
  assert.match(card.body.elements[2].content, /公开工作摘要/);
  assert.match(card.body.elements[2].content, /先核对任务边界。[\s\S]*再验证关键数据。/);
  assert.match(card.body.elements[2].content, /不含模型隐藏思维/);

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
  const trace = runningCard.body.elements[2].content;
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
  const trace = runningCard.body.elements[2].content;
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

test('defers compatibility completion when placeholder repair still fails instead of sending another card', () => withState(async stateDirectory => {
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
  assert.equal(completed.pending, true);
  assert.equal(calls.filter(([name]) => name === 'send').length, 1);
  assert.equal(calls.filter(([name]) => name === 'update').length, 0);
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
  assert.equal(finalCard.body.elements[0].content, '✅ 已完成');
  assert.equal(finalCard.body.elements[1].content, 'Core 的最终答案');
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
    '⚠️ 本次处理未完成，可重试',
    'Core 的纯文本最终答案',
  ]);
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
