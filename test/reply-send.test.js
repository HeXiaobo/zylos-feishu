import test from 'node:test';
import assert from 'node:assert/strict';

import { sendThreadAware } from '../src/lib/reply-send.js';

// Regression: reject/error replies from the message handler go through
// sendThreadAwareMessage -> sendThreadAware. Before this fix it replied-to
// whenever a root/parent was present — even in a p2p DM, where a threaded/quoted
// reply via im.message.reply is not surfaced in the main view (the API returns
// success, so the error message silently never reaches the user). It must be
// chat-type-aware: p2p always base-sends; groups keep reply-to.

function spies({ replySuccess = true, replyThrows = false, sendSuccess = true } = {}) {
  const calls = { reply: [], send: [] };
  const replyToMessage = async (target, text) => {
    calls.reply.push({ target, text });
    if (replyThrows) throw new Error('reply boom');
    return { success: replySuccess };
  };
  const sendMessage = async (chatId, text) => {
    calls.send.push({ chatId, text });
    return { success: sendSuccess };
  };
  return { calls, deps: { replyToMessage, sendMessage } };
}

test('p2p reject reply with root/parent/messageId base-sends, never replyToMessage', async () => {
  const { calls, deps } = spies();
  const ok = await sendThreadAware(
    { chatId: 'oc_p2p', text: 'error', chatType: 'p2p', rootId: 'om_root', parentId: 'om_parent', messageId: 'om_msg' },
    deps,
  );
  assert.equal(ok, true);
  assert.equal(calls.reply.length, 0, 'replyToMessage must not be called for p2p');
  assert.deepEqual(calls.send, [{ chatId: 'oc_p2p', text: 'error' }]);
});

test('p2p with only messageId (quoted DM) still base-sends', async () => {
  const { calls, deps } = spies();
  await sendThreadAware(
    { chatId: 'oc_p2p', text: 'x', chatType: 'p2p', messageId: 'om_msg' },
    deps,
  );
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.send.length, 1);
});

test('group thread reply uses replyToMessage(parent||root), no base send', async () => {
  const { calls, deps } = spies();
  const ok = await sendThreadAware(
    { chatId: 'oc_grp', text: 'error', chatType: 'group', rootId: 'om_root', parentId: 'om_parent', messageId: 'om_msg' },
    deps,
  );
  assert.equal(ok, true);
  assert.deepEqual(calls.reply, [{ target: 'om_parent', text: 'error' }]);
  assert.equal(calls.send.length, 0, 'base send must not run when reply succeeds');
});

test('group @mention reply (msg only, no root) uses replyToMessage(msg)', async () => {
  const { calls, deps } = spies();
  await sendThreadAware(
    { chatId: 'oc_grp', text: 'error', chatType: 'group', messageId: 'om_msg' },
    deps,
  );
  assert.deepEqual(calls.reply, [{ target: 'om_msg', text: 'error' }]);
  assert.equal(calls.send.length, 0);
});

test('group reply failure (success:false) falls back to base send', async () => {
  const { calls, deps } = spies({ replySuccess: false });
  const ok = await sendThreadAware(
    { chatId: 'oc_grp', text: 'error', chatType: 'group', rootId: 'om_root' },
    deps,
  );
  assert.equal(ok, true);
  assert.equal(calls.reply.length, 1);
  assert.deepEqual(calls.send, [{ chatId: 'oc_grp', text: 'error' }]);
});

test('group reply throwing falls back to base send', async () => {
  const { calls, deps } = spies({ replyThrows: true });
  const ok = await sendThreadAware(
    { chatId: 'oc_grp', text: 'error', chatType: 'group', rootId: 'om_root' },
    deps,
  );
  assert.equal(ok, true);
  assert.equal(calls.reply.length, 1);
  assert.equal(calls.send.length, 1);
});

test('unknown/undefined chat type base-sends (safe default)', async () => {
  const { calls, deps } = spies();
  await sendThreadAware(
    { chatId: 'oc_x', text: 'error', rootId: 'om_root', messageId: 'om_msg' },
    deps,
  );
  assert.equal(calls.reply.length, 0);
  assert.equal(calls.send.length, 1);
});

test('p2p topic thread reject reply goes to parent||root with replyInThread', async () => {
  const calls = [];
  const replyToMessage = async (target, text, msgType, opts) => {
    calls.push({ target, text, msgType, opts });
    return { success: true };
  };
  const sendMessage = async () => { throw new Error('base send must not run'); };
  const ok = await sendThreadAware(
    { chatId: 'oc_p2p', text: 'error', chatType: 'p2p', rootId: 'om_root', parentId: 'om_parent', messageId: 'om_msg', threadId: 'omt_1' },
    { replyToMessage, sendMessage },
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ target: 'om_parent', text: 'error', msgType: 'text', opts: { replyInThread: true } }]);
});

test('p2p quote reply without a topic thread still base-sends', async () => {
  const { calls, deps } = spies();
  await sendThreadAware(
    { chatId: 'oc_p2p', text: 'x', chatType: 'p2p', rootId: 'om_root', parentId: 'om_parent', messageId: 'om_msg', threadId: null },
    deps,
  );
  assert.equal(calls.reply.length, 0);
  assert.deepEqual(calls.send, [{ chatId: 'oc_p2p', text: 'x' }]);
});
