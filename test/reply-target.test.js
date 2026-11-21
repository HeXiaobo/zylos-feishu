import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseReplyTarget } from '../src/lib/reply-target.js';

// Regression: outbound replies in a p2p DM were silently dropped because the
// send routing called im.message.reply whenever root/parent was present — even
// in 1:1 DMs, where a threaded/quoted reply is not surfaced in the main view.
// The routing decision must always be "base send" (null target) for p2p.

test('p2p DM with root/parent chooses base send (null), not reply-to', () => {
  assert.equal(
    chooseReplyTarget({ type: 'p2p', root: 'om_root', parent: 'om_parent', msg: 'om_msg' }),
    null
  );
});

test('p2p DM with only msg chooses base send (null), not reply-to', () => {
  assert.equal(
    chooseReplyTarget({ type: 'p2p', msg: 'om_msg' }),
    null
  );
});

test('p2p DM with only root chooses base send (null)', () => {
  assert.equal(
    chooseReplyTarget({ type: 'p2p', root: 'om_root' }),
    null
  );
});

test('plain p2p DM (no thread fields) chooses base send (null)', () => {
  assert.equal(chooseReplyTarget({ type: 'p2p' }), null);
});

test('group with root replies to parent when present (thread continuation)', () => {
  assert.equal(
    chooseReplyTarget({ type: 'group', root: 'om_root', parent: 'om_parent' }),
    'om_parent'
  );
});

test('group with root but no parent replies to root', () => {
  assert.equal(
    chooseReplyTarget({ type: 'group', root: 'om_root' }),
    'om_root'
  );
});

test('group with root replies to parent||root for every chunk, not just the first', () => {
  assert.equal(
    chooseReplyTarget({ type: 'group', root: 'om_root', parent: 'om_parent' }, { isFirstChunk: false }),
    'om_parent'
  );
});

test('group @mention (msg, no root) replies to msg on the first chunk only', () => {
  assert.equal(
    chooseReplyTarget({ type: 'group', msg: 'om_msg' }, { isFirstChunk: true }),
    'om_msg'
  );
  assert.equal(
    chooseReplyTarget({ type: 'group', msg: 'om_msg' }, { isFirstChunk: false }),
    null
  );
});

test('plain group (no root, no msg) chooses base send (null)', () => {
  assert.equal(chooseReplyTarget({ type: 'group' }), null);
});

test('unknown/undefined chat type never replies (safe default = base send)', () => {
  assert.equal(chooseReplyTarget({ root: 'om_root', msg: 'om_msg' }), null);
  assert.equal(chooseReplyTarget({}), null);
  assert.equal(chooseReplyTarget(), null);
});

test('p2p inside a topic thread replies into the thread; p2p without thread still base-sends', () => {
  assert.equal(chooseReplyTarget({ type: 'p2p', root: 'om_r', parent: 'om_p', msg: 'om_m', thread: 'omt_1' }), 'om_p');
  assert.equal(chooseReplyTarget({ type: 'p2p', root: 'om_r', msg: 'om_m', thread: 'omt_1' }), 'om_r');
  assert.equal(chooseReplyTarget({ type: 'p2p', thread: 'omt_1' }), null);
  assert.equal(chooseReplyTarget({ type: 'p2p', root: 'om_r', parent: 'om_p', msg: 'om_m' }), null);
  assert.equal(chooseReplyTarget({ type: 'p2p', msg: 'om_m' }), null);
});
