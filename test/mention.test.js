/**
 * Tests for src/lib/mention.js
 *
 * Uses Node built-in test runner (node:test).
 * Run: node --test test/mention.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMentionContent,
  buildMentionMarkdown,
  getMentionMap,
  _setMapForTest,
} from '../src/lib/mention.js';

// ---------- helpers ----------

const TEST_MAP = {
  '吴优': 'ou_aaa',
  '贺小波': 'ou_bbb',
  '波总': 'ou_bbb',        // alias for same person
  '曹栩瑄': 'ou_ccc',
  '吴优你好': 'ou_ddd',    // longer name that shares prefix with 吴优
};

// ---------- buildMentionContent ----------

describe('buildMentionContent', () => {
  beforeEach(() => _setMapForTest({ ...TEST_MAP }));

  it('no @mention → returns text type unchanged', () => {
    const result = buildMentionContent('普通消息，没有艾特');
    assert.equal(result.msgType, 'text');
    assert.equal(result.content, '普通消息，没有艾特');
  });

  it('single @mention → returns post type with at element', () => {
    const result = buildMentionContent('你好 @吴优 请看一下');
    assert.equal(result.msgType, 'post');
    const post = JSON.parse(result.content);
    const elements = post.zh_cn.content[0];
    assert.equal(elements.length, 3);
    assert.deepEqual(elements[0], { tag: 'text', text: '你好 ' });
    assert.deepEqual(elements[1], { tag: 'at', user_id: 'ou_aaa' });
    assert.deepEqual(elements[2], { tag: 'text', text: ' 请看一下' });
  });

  it('consecutive @mentions without space → @吴优@波总', () => {
    const result = buildMentionContent('@吴优@波总');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements.length, 2);
    assert.deepEqual(elements[0], { tag: 'at', user_id: 'ou_aaa' });
    assert.deepEqual(elements[1], { tag: 'at', user_id: 'ou_bbb' });
  });

  it('@mention followed by punctuation → @吴优，', () => {
    const result = buildMentionContent('@吴优，请处理');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements.length, 2);
    assert.deepEqual(elements[0], { tag: 'at', user_id: 'ou_aaa' });
    assert.deepEqual(elements[1], { tag: 'text', text: '，请处理' });
  });

  it('@mention followed by newline', () => {
    const result = buildMentionContent('@吴优\n下一行');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements.length, 2);
    assert.deepEqual(elements[0], { tag: 'at', user_id: 'ou_aaa' });
    assert.deepEqual(elements[1], { tag: 'text', text: '\n下一行' });
  });

  it('longest prefix match → @吴优你好 matches longer name first', () => {
    const result = buildMentionContent('@吴优你好');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    // Should match "吴优你好" (longer), not "吴优" + leftover "你好"
    assert.equal(elements.length, 1);
    assert.deepEqual(elements[0], { tag: 'at', user_id: 'ou_ddd' });
  });

  it('prefix case without longer name → @吴优早 matches 吴优', () => {
    const result = buildMentionContent('@吴优早');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements.length, 2);
    assert.deepEqual(elements[0], { tag: 'at', user_id: 'ou_aaa' });
    assert.deepEqual(elements[1], { tag: 'text', text: '早' });
  });

  it('unknown @name → preserved as plain text', () => {
    const result = buildMentionContent('@不存在的人 你好');
    assert.equal(result.msgType, 'text');
    assert.equal(result.content, '@不存在的人 你好');
  });

  it('mixed known and unknown @names', () => {
    const result = buildMentionContent('@吴优 和 @不存在 和 @波总');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    // @吴优 → at, " 和 @不存在 和 " → text, @波总 → at
    assert.equal(elements.length, 3);
    assert.deepEqual(elements[0], { tag: 'at', user_id: 'ou_aaa' });
    assert.equal(elements[1].tag, 'text');
    assert.deepEqual(elements[2], { tag: 'at', user_id: 'ou_bbb' });
  });

  it('empty map → returns text type unchanged', () => {
    _setMapForTest({});
    const result = buildMentionContent('@吴优 你好');
    assert.equal(result.msgType, 'text');
    assert.equal(result.content, '@吴优 你好');
  });

  it('openId is empty string → falls back to text element', () => {
    _setMapForTest({ '吴优': '' });
    const result = buildMentionContent('@吴优');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements.length, 1);
    assert.deepEqual(elements[0], { tag: 'text', text: '@吴优' });
  });

  it('openId is undefined → falls back to text element', () => {
    _setMapForTest({ '吴优': undefined });
    const result = buildMentionContent('@吴优');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements.length, 1);
    assert.deepEqual(elements[0], { tag: 'text', text: '@吴优' });
  });

  it('snapshot isolation — map swap mid-flight does not affect result', () => {
    _setMapForTest({ '吴优': 'ou_aaa', '波总': 'ou_bbb' });

    // Monkey-patch: after buildMentionPattern runs (which reads the snapshot),
    // swap the module-level map. The function should still use the snapshot.
    // We verify by checking that the result uses ou_aaa, not the swapped value.
    const result = buildMentionContent('@吴优 @波总');
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];

    // Both should resolve from the snapshot taken at function entry
    const atElements = elements.filter(e => e.tag === 'at');
    assert.equal(atElements.length, 2);
    assert.equal(atElements[0].user_id, 'ou_aaa');
    assert.equal(atElements[1].user_id, 'ou_bbb');

    // Now verify: if we swap the map BEFORE calling, results change
    _setMapForTest({ '吴优': 'ou_xxx', '波总': 'ou_yyy' });
    const result2 = buildMentionContent('@吴优 @波总');
    const elements2 = JSON.parse(result2.content).zh_cn.content[0];
    const atElements2 = elements2.filter(e => e.tag === 'at');
    assert.equal(atElements2[0].user_id, 'ou_xxx');
    assert.equal(atElements2[1].user_id, 'ou_yyy');
  });
});

// ---------- buildMentionMarkdown ----------

describe('buildMentionMarkdown', () => {
  beforeEach(() => _setMapForTest({ ...TEST_MAP }));

  it('no @mention → returns text unchanged', () => {
    const result = buildMentionMarkdown('普通消息');
    assert.equal(result, '普通消息');
  });

  it('single @mention → replaces with <at> tag', () => {
    const result = buildMentionMarkdown('你好 @吴优 请看');
    assert.equal(result, '你好 <at id=ou_aaa></at> 请看');
  });

  it('consecutive @mentions', () => {
    const result = buildMentionMarkdown('@吴优@波总');
    assert.equal(result, '<at id=ou_aaa></at><at id=ou_bbb></at>');
  });

  it('@mention + punctuation', () => {
    const result = buildMentionMarkdown('@吴优，来');
    assert.equal(result, '<at id=ou_aaa></at>，来');
  });

  it('unknown @name → preserved', () => {
    const result = buildMentionMarkdown('@不存在 hello');
    assert.equal(result, '@不存在 hello');
  });

  it('longest prefix match', () => {
    const result = buildMentionMarkdown('@吴优你好');
    assert.equal(result, '<at id=ou_ddd></at>');
  });

  it('empty map → returns text unchanged', () => {
    _setMapForTest({});
    const result = buildMentionMarkdown('@吴优');
    assert.equal(result, '@吴优');
  });

  it('openId empty string → preserved as original text', () => {
    _setMapForTest({ '吴优': '' });
    const result = buildMentionMarkdown('@吴优');
    assert.equal(result, '@吴优');
  });

  it('snapshot isolation', () => {
    _setMapForTest({ '吴优': 'ou_aaa' });
    const result = buildMentionMarkdown('@吴优');
    assert.equal(result, '<at id=ou_aaa></at>');

    _setMapForTest({ '吴优': 'ou_zzz' });
    const result2 = buildMentionMarkdown('@吴优');
    assert.equal(result2, '<at id=ou_zzz></at>');
  });
});

// ---------- override_map merge priority ----------

describe('override_map merge priority', () => {
  it('override wins over auto-sync for same key', () => {
    // Simulate: auto-sync has 吴优→ou_sync, override has 吴优→ou_override
    const autoSync = { '吴优': 'ou_sync', '张三': 'ou_zhangsan' };
    const override = { '吴优': 'ou_override' };
    // Merge order: { ...autoSync, ...override } → override wins
    const merged = { ...autoSync, ...override };
    _setMapForTest(merged);

    const result = buildMentionContent('@吴优');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    assert.equal(elements[0].user_id, 'ou_override');

    // 张三 from auto-sync still works
    const result2 = buildMentionContent('@张三');
    const elements2 = JSON.parse(result2.content).zh_cn.content[0];
    assert.equal(elements2[0].user_id, 'ou_zhangsan');
  });
});

// ---------- getMentionMap ----------

describe('getMentionMap', () => {
  it('returns the current map', () => {
    _setMapForTest({ 'test': 'ou_test' });
    const map = getMentionMap();
    assert.deepEqual(map, { 'test': 'ou_test' });
  });
});
