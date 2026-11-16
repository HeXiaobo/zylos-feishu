import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEndpoint, parseEndpoint } from '../src/lib/endpoint.js';

// buildEndpoint was moved out of src/index.js unchanged; its output is parsed
// by scripts/send.js, so the exact format is pinned here.

test('buildEndpoint keeps the original field order and format', () => {
  assert.equal(
    buildEndpoint('oc_chat', { chatType: 'group', rootId: 'om_root', parentId: 'om_parent', messageId: 'om_msg', threadId: 'omt_thread' }),
    'oc_chat|type:group|root:om_root|parent:om_parent|msg:om_msg|thread:omt_thread'
  );
  assert.equal(buildEndpoint('oc_chat', { chatType: 'p2p', messageId: 'om_msg' }), 'oc_chat|type:p2p|msg:om_msg');
  assert.equal(buildEndpoint('oc_chat'), 'oc_chat');
});

test('buildEndpoint skips empty and null fields', () => {
  assert.equal(
    buildEndpoint('oc_chat', { chatType: 'group', rootId: null, parentId: '', messageId: 'om_msg', threadId: null }),
    'oc_chat|type:group|msg:om_msg'
  );
});

test('parseEndpoint round-trips buildEndpoint', () => {
  const ep = buildEndpoint('oc_chat', { chatType: 'group', rootId: 'om_r', parentId: 'om_p', messageId: 'om_m', threadId: 'omt_t' });
  assert.deepEqual(parseEndpoint(ep), {
    chatId: 'oc_chat', type: 'group', root: 'om_r', parent: 'om_p', msg: 'om_m', thread: 'omt_t'
  });
});

test('parseEndpoint ignores unknown keys and parts without a key, like scripts/send.js', () => {
  assert.deepEqual(parseEndpoint('oc_chat|type:group|topic:x|novalue|:empty|msg:om_1'), {
    chatId: 'oc_chat', type: 'group', msg: 'om_1'
  });
});

test('parseEndpoint handles a bare chat id and non-string input', () => {
  assert.deepEqual(parseEndpoint('oc_chat'), { chatId: 'oc_chat' });
  assert.deepEqual(parseEndpoint(undefined), { chatId: '' });
});
