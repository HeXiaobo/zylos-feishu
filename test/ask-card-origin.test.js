// R5 #179-1: a private-chat ask card is sent now, so its tap has to come back
// as a private chat. The callback used to hardcode `type:group`, which made
// every downstream p2p test (c4-gate's privateChat, auto-deliver's internal
// check) read a direct message as a group message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originSession } from '../src/lib/ask-card-origin.js';

test('私聊拍板的回调按 p2p 归单', () => {
  assert.deepEqual(originSession({ origin_endpoint: 'oc_x|type:p2p|msg:om_1' }), { chatId: 'oc_x', type: 'p2p' });
  assert.deepEqual(originSession({ origin_endpoint: 'oc_x|type:private' }), { chatId: 'oc_x', type: 'p2p' });
  assert.deepEqual(originSession({ origin_endpoint: 'oc_x|type:dm|msg:om_2' }), { chatId: 'oc_x', type: 'p2p' });
});

test('群聊拍板的回调仍是 group', () => {
  assert.deepEqual(originSession({ origin_endpoint: 'oc_y|type:group|msg:om_3' }), { chatId: 'oc_y', type: 'group' });
  // 没有 type 段（老数据）按群，和改动前写死 group 的行为一致。
  assert.deepEqual(originSession({ origin_endpoint: 'oc_y' }), { chatId: 'oc_y', type: 'group' });
  assert.deepEqual(originSession({ origin_endpoint: 'oc_y|msg:om_4' }), { chatId: 'oc_y', type: 'group' });
});

test('没有来源会话时不给 chatId', () => {
  assert.deepEqual(originSession({}), { chatId: null, type: 'group' });
  assert.deepEqual(originSession({ origin_endpoint: '' }), { chatId: null, type: 'group' });
  assert.deepEqual(originSession({ origin_endpoint: '|type:p2p' }), { chatId: null, type: 'group' });
});

test('chat 段里带别的东西也不会把 type 读错', () => {
  // 真实端点里 chat 段之后可能跟 parent:/thread: 这些（#173 的 batchKey 也认这套）。
  assert.deepEqual(
    originSession({ origin_endpoint: 'oc_z|type:p2p|parent:om_9|thread:om_8' }),
    { chatId: 'oc_z', type: 'p2p' },
  );
});
