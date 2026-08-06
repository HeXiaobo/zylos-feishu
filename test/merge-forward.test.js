import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupByUpperMessageId,
  renderMergeForward,
  itemsFromResponse,
  MAX_MERGE_FORWARD_FETCHES,
} from '../src/lib/merge-forward.js';

const ROOT = 'om_root';

// Minimal stand-ins for index.js's parser/name-resolver. The real ones are
// exercised through the live component; here we only care about tree assembly.
const parseItemText = (item) => {
  if (item.msg_type === 'merge_forward') return '[nested merge_forward message]';
  try {
    return JSON.parse(item.body?.content || '{}').text || '';
  } catch {
    return '';
  }
};
const resolveSenderName = async (item) => item.sender?.id || 'unknown';
const textItem = (id, upper, sender, text) => ({
  message_id: id,
  upper_message_id: upper,
  msg_type: 'text',
  sender: { id: sender },
  body: { content: JSON.stringify({ text }) },
});
const forwardItem = (id, upper, sender) => ({
  message_id: id,
  upper_message_id: upper,
  msg_type: 'merge_forward',
  sender: { id: sender },
  body: { content: 'Merged and Forwarded Message' },
});
// Fails the test if the nested-fetch path is taken when it should not be.
const noFetch = async (id) => { throw new Error(`unexpected fetch for ${id}`); };

test('flat forward: renders wrapper-excluded children as sender: text lines', async () => {
  const items = [
    forwardItem(ROOT, undefined, 'ou_sender'),
    textItem('om_1', ROOT, 'ou_a', 'first'),
    textItem('om_2', ROOT, 'ou_b', 'second'),
  ];
  const out = await renderMergeForward({
    items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(out, '[Forwarded conversation]\nou_a: first\nou_b: second');
});

test('wrapper item itself is never rendered as a child', async () => {
  const items = [forwardItem(ROOT, undefined, 'ou_sender'), textItem('om_1', ROOT, 'ou_a', 'only')];
  const out = await renderMergeForward({
    items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(out.split('\n').length, 2, 'header + exactly one child line');
  assert.doesNotMatch(out, /nested merge_forward/);
});

test('payload without upper_message_id: all non-wrapper items treated as direct children', async () => {
  // The field is documented as only present "在合并转发场景"; a payload that
  // omits it must still render rather than collapse to "no child messages".
  const items = [
    { message_id: ROOT, msg_type: 'merge_forward', sender: { id: 'ou_s' }, body: { content: 'x' } },
    { message_id: 'om_1', msg_type: 'text', sender: { id: 'ou_a' }, body: { content: JSON.stringify({ text: 'a' }) } },
    { message_id: 'om_2', msg_type: 'text', sender: { id: 'ou_b' }, body: { content: JSON.stringify({ text: 'b' }) } },
  ];
  const out = await renderMergeForward({
    items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(out, '[Forwarded conversation]\nou_a: a\nou_b: b');
});

test('nested forward, FLATTENED payload: expands inline, no extra fetch, no duplication', async () => {
  // Behaviour A: the API returns the inner forward's children in the same
  // items[]. Detected via upper_message_id pointing at the inner forward.
  const items = [
    forwardItem(ROOT, undefined, 'ou_s'),
    textItem('om_1', ROOT, 'ou_a', 'top level'),
    forwardItem('om_inner', ROOT, 'ou_b'),
    textItem('om_2', 'om_inner', 'ou_c', 'inner one'),
    textItem('om_3', 'om_inner', 'ou_d', 'inner two'),
  ];
  const out = await renderMergeForward({
    items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(out, [
    '[Forwarded conversation]',
    'ou_a: top level',
    'ou_b: [nested merge_forward message]',
    '  ou_c: inner one',
    '  ou_d: inner two',
  ].join('\n'));
  // Each inner child appears exactly once.
  assert.equal(out.match(/inner one/g).length, 1);
});

test('nested forward, NON-flattened payload: fetches the inner forward exactly once', async () => {
  // Behaviour B: the API returns only the inner forward wrapper. Feishu does
  // not document which of A/B happens, so both must work.
  const items = [
    forwardItem(ROOT, undefined, 'ou_s'),
    textItem('om_1', ROOT, 'ou_a', 'top level'),
    forwardItem('om_inner', ROOT, 'ou_b'),
  ];
  const fetched = [];
  const fetchItems = async (id) => {
    fetched.push(id);
    return [
      forwardItem('om_inner', undefined, 'ou_b'),
      textItem('om_2', 'om_inner', 'ou_c', 'inner one'),
    ];
  };
  const out = await renderMergeForward({ items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems });
  assert.deepEqual(fetched, ['om_inner']);
  assert.equal(out, [
    '[Forwarded conversation]',
    'ou_a: top level',
    'ou_b: [nested merge_forward message]',
    '  ou_c: inner one',
  ].join('\n'));
});

test('nested fetch failure degrades to a marker and keeps the rest of the transcript', async () => {
  const items = [
    forwardItem(ROOT, undefined, 'ou_s'),
    textItem('om_1', ROOT, 'ou_a', 'kept'),
    forwardItem('om_inner', ROOT, 'ou_b'),
  ];
  const out = await renderMergeForward({
    items, rootId: ROOT, parseItemText, resolveSenderName,
    fetchItems: async () => { throw new Error('boom'); },
  });
  assert.match(out, /ou_a: kept/, 'sibling content survives a failed nested fetch');
  assert.match(out, /\[nested forward, failed to fetch content\]/);
});

test('depth limit stops expansion instead of recursing without bound', async () => {
  // A chain of forwards, each containing the next, all flattened into one
  // payload: root > f1 > f2 > f3 > f4.
  const items = [forwardItem(ROOT, undefined, 'ou_s')];
  let parent = ROOT;
  for (let i = 1; i <= 4; i++) {
    items.push(forwardItem(`om_f${i}`, parent, `ou_${i}`));
    parent = `om_f${i}`;
  }
  items.push(textItem('om_deep', parent, 'ou_deep', 'too deep'));
  const out = await renderMergeForward({
    items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.match(out, /\[nested forward not expanded: depth limit\]/);
  assert.doesNotMatch(out, /too deep/);
});

test('nested-fetch budget is capped across the whole render', async () => {
  // Many sibling inner forwards, none flattened — each would need its own
  // fetch; only MAX_MERGE_FORWARD_FETCHES may actually fire.
  const items = [forwardItem(ROOT, undefined, 'ou_s')];
  for (let i = 0; i < MAX_MERGE_FORWARD_FETCHES + 5; i++) {
    items.push(forwardItem(`om_inner${i}`, ROOT, `ou_${i}`));
  }
  let fetches = 0;
  const fetchItems = async () => { fetches += 1; return []; };
  const out = await renderMergeForward({ items, rootId: ROOT, parseItemText, resolveSenderName, fetchItems });
  assert.equal(fetches, MAX_MERGE_FORWARD_FETCHES);
  assert.match(out, /\[nested forward not expanded: fetch limit\]/);
});

test('empty / wrapper-only payload returns the no-children marker', async () => {
  const out = await renderMergeForward({
    items: [forwardItem(ROOT, undefined, 'ou_s')], rootId: ROOT,
    parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(out, '[merge_forward message, no child messages]');

  const outEmpty = await renderMergeForward({
    items: [], rootId: ROOT, parseItemText, resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(outEmpty, '[merge_forward message, no child messages]');
});

test('multi-line child text is indented to its own level (real forwarded cards are multi-line)', async () => {
  const items = [
    forwardItem(ROOT, undefined, 'ou_s'),
    forwardItem('om_inner', ROOT, 'ou_b'),
    { message_id: 'om_card', upper_message_id: 'om_inner', msg_type: 'interactive', sender: { id: 'ou_c' }, body: { content: '{}' } },
  ];
  const out = await renderMergeForward({
    items, rootId: ROOT,
    parseItemText: (item) => (item.msg_type === 'interactive' ? 'line one\nline two\nline three' : '[nested merge_forward message]'),
    resolveSenderName, fetchItems: noFetch,
  });
  assert.equal(out, [
    '[Forwarded conversation]',
    'ou_b: [nested merge_forward message]',
    '  ou_c: line one',
    '    line two',
    '    line three',
  ].join('\n'));
});

test('itemsFromResponse: a non-zero code THROWS rather than degrading to "no child messages"', () => {
  // Regression guard. If a failed read-back returned [] instead, renderMergeForward
  // would emit "[merge_forward message, no child messages]" — reporting a fetch
  // failure as a genuinely empty forward and silently dropping the transcript.
  // The caller's catch must see an error so the failed-content marker wins.
  assert.throws(
    () => itemsFromResponse({ code: 230002, msg: 'Bot/User can NOT be out of the chat.' }, 'om_x'),
    /code=230002/,
    'permission-class failure must throw',
  );
  assert.throws(() => itemsFromResponse({ code: 99991672, msg: 'no permission' }, 'om_x'), /code=99991672/);
  assert.throws(() => itemsFromResponse(undefined, 'om_x'), /code=missing/, 'absent response must throw');
  assert.throws(() => itemsFromResponse({}, 'om_x'), /code=missing/, 'response without code must throw');
});

test('itemsFromResponse: a successful response yields items, and an empty one is a real empty', () => {
  const items = [{ message_id: 'om_1' }];
  assert.deepEqual(itemsFromResponse({ code: 0, data: { items } }, 'om_x'), items);
  // code=0 with no items is a genuinely empty result, not a failure — it may
  // legitimately degrade to the no-children marker.
  assert.deepEqual(itemsFromResponse({ code: 0, data: {} }, 'om_x'), []);
  assert.deepEqual(itemsFromResponse({ code: 0 }, 'om_x'), []);
});

test('a failed top-level fetch surfaces as failed-content, never as an empty forward', async () => {
  // End-to-end of the guard: renderMergeForward is never even reached, because
  // the throw propagates to fetchMergeForwardContent's catch in index.js.
  const boom = () => itemsFromResponse({ code: 230002, msg: 'Bot/User can NOT be out of the chat.' }, 'om_root');
  assert.throws(boom, /im\.message\.get failed for om_root/);
});

test('groupByUpperMessageId excludes the wrapper and keeps child order', () => {
  const items = [
    forwardItem(ROOT, undefined, 'ou_s'),
    textItem('om_1', ROOT, 'ou_a', 'a'),
    textItem('om_2', 'om_inner', 'ou_b', 'b'),
    textItem('om_3', ROOT, 'ou_c', 'c'),
  ];
  const byUpper = groupByUpperMessageId(items, ROOT);
  assert.deepEqual(byUpper.get(ROOT).map((i) => i.message_id), ['om_1', 'om_3']);
  assert.deepEqual(byUpper.get('om_inner').map((i) => i.message_id), ['om_2']);
  assert.equal(byUpper.has(ROOT) && byUpper.get(ROOT).some((i) => i.message_id === ROOT), false);
});
