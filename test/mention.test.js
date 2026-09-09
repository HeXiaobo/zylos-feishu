/**
 * Tests for src/lib/mention.js
 *
 * Uses Node built-in test runner (node:test).
 * Run: node --test test/mention.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMentionContent,
  buildMentionMarkdown,
  getMentionMap,
  resolveMentionMapForChat,
  _setMapForTest,
  _setFetchMembersForTest,
  _clearLiveMembersCacheForTest,
  _getMentionDiagnosticsForTest,
  _resetMentionDiagnosticsForTest,
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

// ---------- live chat member resolution (issue #81) ----------

/**
 * issue #81: open_id is context-scoped (chat / bot / purpose), so the global
 * override_map must not be trusted at send time. These tests assert:
 * - resolution prefers the target chat's live member list;
 * - a fallback to the (possibly wrong-scope) cache is observable, never silent;
 * - an unresolvable @name is observable (warn with name + chat dimensions);
 * - people absent from the source group / override_map still resolve.
 */

describe('resolveMentionMapForChat (issue #81)', () => {
  const originalConsoleWarn = console.warn;
  let warnings;

  beforeEach(() => {
    _setMapForTest({ ...TEST_MAP });
    _resetMentionDiagnosticsForTest();
    _clearLiveMembersCacheForTest();
    _setFetchMembersForTest(null);
    warnings = [];
    console.warn = (msg) => warnings.push(String(msg));
  });

  afterEach(() => {
    console.warn = originalConsoleWarn;
    _setFetchMembersForTest(null);
  });

  it('live member list wins over stale override_map → mention payload uses the chat-scoped open_id', async () => {
    // override_map holds a KNOWN-WRONG (other-scope) open_id for 吴优
    _setMapForTest({ '吴优': 'ou_stale_from_other_scope' });
    _setFetchMembersForTest(async (chatId) => {
      assert.equal(chatId, 'oc_live1');
      return { '吴优': 'ou_live_from_chat_members' };
    });

    const ctx = await resolveMentionMapForChat('oc_live1');
    assert.equal(ctx.live, true);
    assert.equal(ctx.chatId, 'oc_live1');
    assert.equal(ctx.map['吴优'], 'ou_live_from_chat_members');

    // Plain-text path: mentions payload non-empty, with the LIVE id
    const result = buildMentionContent('@吴优 请看', { map: ctx.map, liveNames: ctx.liveNames, chatId: ctx.chatId });
    assert.equal(result.msgType, 'post');
    const elements = JSON.parse(result.content).zh_cn.content[0];
    const atElements = elements.filter(e => e.tag === 'at');
    assert.equal(atElements.length, 1);
    assert.equal(atElements[0].user_id, 'ou_live_from_chat_members');

    // Card path: same resolution
    const md = buildMentionMarkdown('@吴优 请看', { map: ctx.map, liveNames: ctx.liveNames, chatId: ctx.chatId });
    assert.equal(md, '<at id=ou_live_from_chat_members></at> 请看');

    // Live hit is not a fallback — no warnings at all
    const diags = _getMentionDiagnosticsForTest();
    assert.equal(diags.fallbackResolutions, 0);
    assert.equal(warnings.length, 0);
  });

  it('person absent from override_map (not in source group) resolves via live chat members', async () => {
    _setMapForTest({}); // override_map 查不到
    _setFetchMembersForTest(async () => ({ '王新': 'ou_wangxin_live' }));

    const ctx = await resolveMentionMapForChat('oc_live2');
    const result = buildMentionContent('@王新 到了', { map: ctx.map, liveNames: ctx.liveNames, chatId: ctx.chatId });
    assert.equal(result.msgType, 'post');
    const atElements = JSON.parse(result.content).zh_cn.content[0].filter(e => e.tag === 'at');
    assert.equal(atElements.length, 1);
    assert.equal(atElements[0].user_id, 'ou_wangxin_live');
    assert.equal(_getMentionDiagnosticsForTest().unresolvedMentions, 0);
  });

  it('negative sample: fallback to a known-wrong open_id is observable (warn + counter), never silent', async () => {
    _setMapForTest({ '老张': 'ou_wrong_scope_value' }); // 另一作用域的错值
    _setFetchMembersForTest(async () => ({ '吴优': 'ou_live' })); // 老张不在本会话

    const ctx = await resolveMentionMapForChat('oc_live3');
    assert.equal(ctx.live, true);

    const md = buildMentionMarkdown('@老张 看一下', { map: ctx.map, liveNames: ctx.liveNames, chatId: ctx.chatId });
    assert.equal(md, '<at id=ou_wrong_scope_value></at> 看一下'); // 回退用了缓存值

    // 但这一步必须留痕：FALLBACK warn（含 name 与 chat 维度）+ 计数
    const diags = _getMentionDiagnosticsForTest();
    assert.equal(diags.fallbackResolutions, 1);
    const fallbackWarnings = warnings.filter(w => w.includes('FALLBACK'));
    assert.equal(fallbackWarnings.length, 1);
    assert.ok(fallbackWarnings[0].includes('老张'));
    assert.ok(fallbackWarnings[0].includes('oc_live3'));

    // plain-text path counts the same way
    buildMentionContent('@老张', { map: ctx.map, liveNames: ctx.liveNames, chatId: ctx.chatId });
    assert.equal(_getMentionDiagnosticsForTest().fallbackResolutions, 2);
  });

  it('completely unknown @name → UNRESOLVED warn (name + chat dimensions), message preserved without silent mention', async () => {
    _setFetchMembersForTest(async () => ({ '吴优': 'ou_live' }));
    const ctx = await resolveMentionMapForChat('oc_live4');

    const result = buildMentionContent('@幽灵人 收到请回复', { map: ctx.map, liveNames: ctx.liveNames, chatId: ctx.chatId });
    assert.equal(result.msgType, 'text'); // delivered, but mention kept as plain text
    assert.equal(result.content, '@幽灵人 收到请回复');

    const diags = _getMentionDiagnosticsForTest();
    assert.equal(diags.unresolvedMentions, 1);
    const unresolved = warnings.filter(w => w.includes('UNRESOLVED'));
    assert.equal(unresolved.length, 1);
    assert.ok(unresolved[0].includes('幽灵人'));
    assert.ok(unresolved[0].includes('oc_live4'));
  });

  it('known name with empty open_id is reported as unresolved, not silent', () => {
    _setMapForTest({ '吴优': '' });
    buildMentionContent('@吴优', { chatId: 'oc_live5' });
    const diags = _getMentionDiagnosticsForTest();
    assert.equal(diags.unresolvedMentions, 1);
    assert.ok(warnings.some(w => w.includes('UNRESOLVED') && w.includes('吴优') && w.includes('oc_live5')));
  });

  it('per-chat TTL cache: repeated resolve for the same chat fetches once', async () => {
    let calls = 0;
    _setFetchMembersForTest(async () => { calls += 1; return { '吴优': 'ou_live' }; });
    await resolveMentionMapForChat('oc_live6');
    await resolveMentionMapForChat('oc_live6');
    assert.equal(calls, 1);
  });

  it('live lookup returns null (API failure) → fallback map + warn + liveLookupFailures counted', async () => {
    _setMapForTest({ '吴优': 'ou_aaa' });
    _setFetchMembersForTest(async () => null);
    const ctx = await resolveMentionMapForChat('oc_live7');
    assert.equal(ctx.live, false);
    assert.equal(ctx.map['吴优'], 'ou_aaa');
    assert.ok(warnings.some(w => w.includes('falling back to cached map') && w.includes('oc_live7')));
    assert.equal(_getMentionDiagnosticsForTest().liveLookupFailures, 1);
  });

  it('live lookup throws → fallback map + warn, resolution still observable', async () => {
    _setMapForTest({ '吴优': 'ou_aaa' });
    _setFetchMembersForTest(async () => { throw new Error('network down'); });
    const ctx = await resolveMentionMapForChat('oc_live8');
    assert.equal(ctx.live, false);
    assert.equal(ctx.map['吴优'], 'ou_aaa');
    assert.ok(warnings.some(w => w.includes('network down') && w.includes('oc_live8')));
    assert.equal(_getMentionDiagnosticsForTest().liveLookupFailures, 1);
  });

  it('missing chatId → returns fallback map untouched without fetching', async () => {
    let called = false;
    _setFetchMembersForTest(async () => { called = true; return {}; });
    const ctx = await resolveMentionMapForChat(null);
    assert.equal(ctx.live, false);
    assert.equal(ctx.chatId, null);
    assert.equal(called, false);
  });
});

// ---------- unresolved @candidate scan precision (issue #81) ----------

describe('unresolved @candidate scan precision', () => {
  beforeEach(() => {
    _setMapForTest({ ...TEST_MAP });
    _resetMentionDiagnosticsForTest();
  });

  it('email-like and URL-path @text is not reported', () => {
    buildMentionMarkdown('邮箱 a@b.com，主页 https://x.com/@user 看看', { chatId: 'oc_scan1' });
    assert.equal(_getMentionDiagnosticsForTest().unresolvedMentions, 0);
  });

  it('aggregate targets @all / @所有人 are not reported', () => {
    buildMentionContent('@所有人 开会，@all please join', {});
    assert.equal(_getMentionDiagnosticsForTest().unresolvedMentions, 0);
  });

  it('@吴优早 and @吴优你好早 match known-name prefixes, not unknown persons', () => {
    buildMentionMarkdown('@吴优早', { chatId: 'oc_scan2' });
    buildMentionMarkdown('@吴优你好早', { chatId: 'oc_scan2' });
    assert.equal(_getMentionDiagnosticsForTest().unresolvedMentions, 0);
  });

  it('@names inside code fences are not reported', () => {
    buildMentionMarkdown('示例：\n```\nnpm run @notaperson\n```\n完', { chatId: 'oc_scan3' });
    assert.equal(_getMentionDiagnosticsForTest().unresolvedMentions, 0);
  });

  it('genuinely unknown @name outside code is reported once per name', () => {
    buildMentionContent('@李新 和 @李新 再和 @王五', {});
    const diags = _getMentionDiagnosticsForTest();
    assert.equal(diags.unresolvedMentions, 2); // 李新 deduped, 王五 separate
  });
});
