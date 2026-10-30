import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPostText, resolveMentions, textFromContent } from '../src/lib/message-text.js';

// The recovery poller replays a message the long connection never saw, so the
// body has to keep the executable parts: a link keeps its URL, an @ keeps the
// recipient. Before this module the poller kept only `tag === 'text'` nodes and
// dropped both — the exact content of the task it was replaying.

const MENTIONS = [{ key: '@_user_1', name: '指定客户', id: { open_id: 'ou_recipient' } }];

test('rich text keeps the link and the @ recipient', () => {
  const post = [
    [{ tag: 'text', text: '请把' }],
    [{ tag: 'a', text: '这份报表', href: 'https://example.invalid/report' }, { tag: 'text', text: '发给' }],
    [{ tag: 'at', user_id: 'ou_recipient', user_name: '指定客户' }, { tag: 'text', text: '，今天要' }],
  ];
  const { text } = extractPostText(post, 'om_demo');
  assert.equal(text, '请把\n这份报表(https://example.invalid/report)发给\n@指定客户，今天要');
});

test('a post without a title is just its body; with a title the component shape is kept', () => {
  const content = { content: [[{ tag: 'text', text: '正文' }]] };
  assert.equal(textFromContent('post', content, 'om_a'), '正文');
  assert.equal(textFromContent('post', { title: '派活', ...content }, 'om_a'), '[派活] 正文');
});

test('plain-text mentions resolve to names instead of @_user_N placeholders', () => {
  assert.equal(
    textFromContent('text', { text: '把客户资料发给 @_user_1' }, 'om_b', MENTIONS),
    '把客户资料发给 @指定客户',
  );
});

test('unknown or unparseable content is refused, not delivered as noise', () => {
  assert.equal(textFromContent('text', '{not json', 'om_c'), null);
  assert.equal(textFromContent('image', { image_key: 'k' }, 'om_d'), null);
  assert.equal(textFromContent('text', { text: '   ' }, 'om_e'), null);
});

test('media markers keep the same shape the component logs', () => {
  assert.equal(
    resolveMentions('@_user_1 看这个', MENTIONS),
    '@指定客户 看这个',
  );
  const { text, imageKeys } = extractPostText([[{ tag: 'img', image_key: 'img_1' }]], 'om_f');
  assert.deepEqual(imageKeys, ['img_1']);
  assert.equal(text, '[image, image_key: img_1, msg_id: om_f]');
});
