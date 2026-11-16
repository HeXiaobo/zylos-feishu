import test from 'node:test';
import assert from 'node:assert/strict';

import {
  answeredCard, checkActor, createAskCardRuntime, parseAskCardEvent, tapContent, tapOutcomeText,
} from '../src/lib/ask-card-runtime.js';

// issue #171：拍板卡回调。这里不碰飞书、不碰数据库 —— 归单那一步是把一条
// 消息投给 c4-receive，这里只钉住「投不投、投什么、卡片改成什么样」。
//
// 三件事一旦错了就是线上事故：
//   1. 别人点也被采纳（等于谁都能替人拍板）；
//   2. 单子已经答过了还投一条 input（等于一次拍板算两次）；
//   3. 点完之后卡片还挂着能点的按钮（人会以为没点上）。

const OWNER = 'ou_1111111111111111111111111111';
const STRANGER = 'ou_9999999999999999999999999999';
const TICKET = 'T01010000-abcd';

function event({action = 'ask_pick', label = '甲', index = 0, actor = OWNER, messageId = 'om_1', value} = {}) {
  return {
    operator: {open_id: actor},
    context: {open_message_id: messageId},
    action: {
      tag: 'button',
      value: value ?? {z: 'ask', a: action, t: TICKET, i: index, u: OWNER, q: '走哪个方案？', l: label},
    },
  };
}

const CARD = {
  schema: '2.0',
  config: {update_multi: true, summary: {content: '需要你定'}},
  header: {template: 'orange', title: {tag: 'plain_text', content: '需要你定：挑方案'}},
  body: {elements: [
    {tag: 'markdown', content: '**走哪个方案？**'},
    {tag: 'action', actions: [
      {tag: 'button', text: {tag: 'plain_text', content: '甲'}, value: {z: 'ask', a: 'ask_pick', t: TICKET}},
      {tag: 'button', text: {tag: 'plain_text', content: '乙'}, value: {z: 'ask', a: 'ask_pick', t: TICKET}},
    ]},
    {tag: 'note', elements: [{tag: 'plain_text', content: '只有被问的你能点'}]},
  ]},
};

test('回调摊平：只认带 z=ask 的按钮值，别的卡片一律不接管', () => {
  const parsed = parseAskCardEvent(event());
  assert.equal(parsed.ticketId, TICKET);
  assert.equal(parsed.action, 'ask_pick');
  assert.equal(parsed.actorId, OWNER);
  assert.equal(parsed.messageId, 'om_1');
  assert.equal(parseAskCardEvent({operator: {open_id: OWNER}, action: {tag: 'button', value: {action: 'start'}}}), null);
  assert.equal(parseAskCardEvent({operator: {open_id: OWNER}, action: {tag: 'button', value: {z: 'ask', a: 'ask_pick', t: 'nope'}}}), null);
});

test('Webhook 包了一层 header/event 也认', () => {
  const parsed = parseAskCardEvent({header: {event_type: 'card.action.trigger'}, event: event({actor: OWNER})});
  assert.equal(parsed.ticketId, TICKET);
});

test('只有被问的人能点：别人点了给出无权提示，不改卡片也不投单', async () => {
  const calls = [];
  const runtime = createAskCardRuntime({
    readCard: async () => { calls.push('read'); return CARD; },
    patchCard: async () => { calls.push('patch'); },
    receive: async () => { calls.push('receive'); return {ok: true}; },
  });
  const out = await runtime.handle(event({actor: STRANGER}));
  assert.equal(out.handled, true);
  assert.equal(out.toast.type, 'warning');
  assert.match(out.toast.content, /不是问你/);
  assert.deepEqual(calls, [], '既不读卡、也不改卡、也不投单');
});

test('本人点了：投一条带单号的归单消息，并把原卡改成已选', async () => {
  const received = [];
  const patched = [];
  const runtime = createAskCardRuntime({
    readCard: async () => CARD,
    patchCard: async (messageId, card) => { patched.push([messageId, card]); },
    receive: async args => { received.push(args); return {ok: true}; },
  });
  const out = await runtime.handle(event({label: '乙', index: 1}), {actorName: '波总'});
  assert.equal(out.toast.type, 'success');
  assert.equal(received.length, 1);
  assert.equal(received[0].ticketId, TICKET);
  assert.match(received[0].content, /乙/);
  assert.equal(patched.length, 1);
  const [messageId, card] = patched[0];
  assert.equal(messageId, 'om_1');
  assert.equal(card.header.template, 'green');
  assert.match(card.header.title.content, /波总 已选：乙/);
  // 按钮必须全部去掉：还挂着按钮，人会以为没点上。
  assert.equal(card.body.elements.some(element => element.tag === 'action'), false);
  assert.equal(card.config.update_multi, true);
});

test('单子已经答过：不投单、不改卡，只提示', async () => {
  const calls = [];
  const runtime = createAskCardRuntime({
    readCard: async () => { calls.push('read'); return CARD; },
    patchCard: async () => { calls.push('patch'); },
    receive: async () => { calls.push('receive'); return {accepted: false, toast: '这张单已经答过了'}; },
  });
  const out = await runtime.handle(event());
  assert.equal(out.toast.type, 'warning');
  assert.equal(out.toast.content, '这张单已经答过了');
  assert.deepEqual(calls, ['receive'], '归单被拒之后不写卡');
});

test('归单接口抛错：回一条「请在聊天里回复」，不装作成功', async () => {
  const runtime = createAskCardRuntime({
    readCard: async () => CARD,
    patchCard: async () => {},
    receive: async () => { throw new Error('c4 down'); },
    onError: () => {},
  });
  const out = await runtime.handle(event());
  assert.equal(out.toast.type, 'error');
  assert.match(out.toast.content, /直接在聊天里回复/);
});

test('改卡失败不影响归单：「已选」不写上去，但答复已经进去了', async () => {
  const errors = [];
  const runtime = createAskCardRuntime({
    readCard: async () => { throw new Error('get failed'); },
    patchCard: async () => {},
    receive: async () => ({ok: true}),
    onError: message => errors.push(message),
  });
  const out = await runtime.handle(event());
  assert.equal(out.toast.type, 'success');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /patch skipped/);
});

test('「我自己写」「交给别人定」：只投一条说明，不改卡（还要人打字）', async () => {
  const patched = [];
  const received = [];
  const runtime = createAskCardRuntime({
    readCard: async () => CARD,
    patchCard: async (id, card) => patched.push([id, card]),
    receive: async args => { received.push(args); return {ok: true}; },
  });
  for (const action of ['ask_write', 'ask_delegate']) {
    const out = await runtime.handle(event({action, label: ''}));
    assert.equal(out.toast.type, 'success');
  }
  assert.equal(received.length, 2);
  assert.equal(patched.length, 0);
  assert.match(received[0].content, /我自己写/);
  assert.match(received[1].content, /交给别人定/);
});

test('读不回原卡时用按钮值里的问题拼一张最小卡，不发空卡', () => {
  const card = answeredCard(null, {label: '甲', actorName: '波总', ticketId: TICKET, question: '走哪个方案？'});
  assert.equal(card.header.template, 'green');
  assert.match(card.header.title.content, /已选：甲/);
  assert.match(JSON.stringify(card), /走哪个方案/);
  assert.equal(card.body.elements.some(element => element.tag === 'action'), false);
});

test('鉴权：拿不到身份、卡里没记住问谁，都不采纳', () => {
  assert.equal(checkActor({actorId: '', askee: OWNER}).ok, false);
  assert.equal(checkActor({actorId: OWNER, askee: ''}).ok, false);
  assert.equal(checkActor({actorId: OWNER, askee: OWNER}).ok, true);
  assert.equal(tapContent({action: 'ask_pick', label: '甲'}).includes('选：甲'), true);
  assert.equal(tapOutcomeText({action: 'ask_delegate'}), '要用文字说明交给谁');
});
