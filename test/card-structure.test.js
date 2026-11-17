import test from 'node:test';
import assert from 'node:assert/strict';

import { RETIRED_CONTAINER_TAGS, findUnsupportedStructure, withoutButtons } from '../src/lib/card-structure.js';

// 卡片 2.0 的结构底线。
//
// 2026-11-17 生产 T11172125-6m6p：c4.db 661 / 663 两张卡 `send_status=failed`、
// **没有平台消息 id**，同一条路径的 666 发出去就成功了。三张卡只差结构——前两张
// 把按钮包在 `{tag:'action', actions:[…]}` 壳里、还带一个 `{tag:'note', …}`，
// 成功那张按钮直接是 `body.elements` 的成员。
//
// 当时 `readCardFile()` 只查了路径 / JSON / `schema` / `body` 是不是对象，**从不
// 往下看元素**，所以这两张必然被拒的卡一路通过了本地校验，直到飞书回 400 才失败。
// 这个文件钉住的就是补上的那一条。

const btn = (label = '甲') => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type: 'primary',
  value: { z: 'ask', a: 'ask_pick', t: 'T01010000-abcd', i: 0, u: 'ou_1111111111111111111111111111' },
});
const card = (elements) => ({
  schema: '2.0',
  config: { update_multi: true, summary: { content: '需要你定' } },
  header: { template: 'orange', title: { tag: 'plain_text', content: '需要你定：挑方案' } },
  body: { elements },
});

test('生产上被拒的第一种结构（action 壳）被判为必然失败，并说出是哪一条', () => {
  const found = findUnsupportedStructure(card([
    { tag: 'markdown', content: '**走哪个方案？**' },
    { tag: 'action', actions: [btn('甲'), btn('乙')] },
  ]));
  assert.ok(found, 'a card with an action shell must be rejected locally');
  assert.equal(found.tag, 'action');
  assert.match(found.path, /^card\.body\.elements\[1\]\.tag$/, '要指到具体位置，不然人得自己找');
  assert.match(found.reason, /no `action` module/, '要说清为什么，不只是「非法」');
});

test('生产上被拒的第二种结构（note）同样判为必然失败', () => {
  const found = findUnsupportedStructure(card([
    { tag: 'markdown', content: '**走哪个方案？**' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '只有被问的你能点' }] },
  ]));
  assert.equal(found?.tag, 'note');
  assert.match(found.reason, /no `note` element/);
});

test('生产上成功的那一张（扁平按钮）原样放行', () => {
  assert.equal(findUnsupportedStructure(card([
    { tag: 'markdown', content: '**走哪个方案？**' },
    btn('甲'),
    btn('乙'),
    btn('我自己写'),
    btn('交给别人定'),
    { tag: 'markdown', content: '点按钮或直接回复都行。' },
  ])), null);
});

test('藏起来的也拦得住：column_set / form 里的 action 与 note', () => {
  // 只看顶层是不够的：飞书拒的是那个 tag 本身，藏在哪一层都一样。
  assert.equal(findUnsupportedStructure(card([
    { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'action', actions: [btn()] }] }] },
  ]))?.tag, 'action');
  assert.equal(findUnsupportedStructure(card([
    { tag: 'form', elements: [{ tag: 'note', elements: [] }] },
  ]))?.tag, 'note');
  // 路径要能定位到那一层。
  const nested = findUnsupportedStructure(card([
    { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'action', actions: [] }] }] },
  ]));
  assert.match(nested.path, /columns\[0\]\.elements\[0\]\.tag$/);
});

test('不误伤：2.0 合法组件与 report-card 用的结构一律放行', () => {
  // 白名单式的校验必然会误伤——2.0 还在加组件。这里列的是真实在用的结构。
  assert.equal(findUnsupportedStructure(card([
    { tag: 'column_set', columns: [
      { tag: 'column', elements: [{ tag: 'markdown', content: 'x' }] },
      { tag: 'column', elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'y' } }] },
    ] },
    { tag: 'hr' },
    { tag: 'button', behaviors: [{ type: 'open_url', default_url: 'https://x' }] },
    { tag: 'collapsible_panel', elements: [{ tag: 'markdown', content: 'z' }] },
    { tag: 'interactive_container', elements: [{ tag: 'button', value: { k: 'v' } }] },
    { tag: 'img', img_key: 'img_x' },
    { tag: 'overflow', options: [] },
  ])), null);
});

test('只看元素树，不翻按钮值和正文：不碰敏感内容也不误判', () => {
  // 按钮值里的 `value` 是回调数据，不是元素树。哪怕里面有 `tag: 'action'` 也不能拦。
  const sneaky = card([{ ...btn(), value: { z: 'ask', a: 'ask_pick', t: 'T01010000-abcd', note: 'note', action: 'action' } }]);
  assert.equal(findUnsupportedStructure(sneaky), null);
  // 正文里出现「action」「note」这两个词不算。
  assert.equal(findUnsupportedStructure(card([
    { tag: 'markdown', content: '这段说 action 和 note 都已废弃' },
  ])), null);
});

test('RETIRED_CONTAINER_TAGS 每条都带一句为什么', () => {
  assert.deepEqual([...RETIRED_CONTAINER_TAGS.keys()], ['action', 'note']);
  for (const [tag, reason] of RETIRED_CONTAINER_TAGS) {
    assert.ok(reason.length > 10, `${tag} 必须带一句可读的理由`);
  }
});

test('withoutButtons 拆两种形状，别的元素原样留下', () => {
  const kept = { tag: 'markdown', content: '正文' };
  // 修复后的生成器：扁平按钮。
  assert.deepEqual(withoutButtons([kept, btn('甲')]), [kept], '扁平按钮必须拆掉');
  // 修复前的生成器：action 壳。
  assert.deepEqual(withoutButtons([kept, { tag: 'action', actions: [btn('甲')] }]), [kept], 'action 壳整个拆掉');
  // 藏在一层容器里也要拆：留下按钮，人点了会以为没点上。
  assert.deepEqual(
    withoutButtons([{ tag: 'column_set', columns: [{ tag: 'column', elements: [btn('甲'), kept] }] }]),
    [{ tag: 'column_set', columns: [{ tag: 'column', elements: [kept] }] }],
  );
  // note 不是按钮，留着（它由调用方统一换成 markdown）。
  assert.deepEqual(withoutButtons([{ tag: 'note', elements: [] }]), [{ tag: 'note', elements: [] }]);
  // 不是数组就返回空，不抛。
  assert.deepEqual(withoutButtons(undefined), []);
  assert.deepEqual(withoutButtons(null), []);
});
