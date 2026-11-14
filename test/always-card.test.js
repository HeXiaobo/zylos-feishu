// alwaysCard 开关：config.message.alwaysCard=true 时，纯文本也发卡片。
// 默认（不配或 false）行为必须与改动前完全一致。
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseCard, hasMarkdownContent } from '../src/lib/card-decision.js';

test('alwaysCard 默认关闭：纯文本不发卡片', () => {
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '普通一句话'), false);
  assert.equal(shouldUseCard({ useMarkdownCard: true, alwaysCard: false }, '普通一句话'), false);
  assert.equal(shouldUseCard({}, '普通一句话'), false);
});

test('alwaysCard=true：纯文本也发卡片', () => {
  assert.equal(shouldUseCard({ useMarkdownCard: true, alwaysCard: true }, '普通一句话'), true);
  assert.equal(shouldUseCard({ useMarkdownCard: true, alwaysCard: true }, ''), true);
});

test('alwaysCard=true 但 useMarkdownCard 关：仍不发卡片（旧开关仍是总闸）', () => {
  assert.equal(shouldUseCard({ useMarkdownCard: false, alwaysCard: true }, '普通一句话'), false);
  assert.equal(shouldUseCard({ alwaysCard: true }, '普通一句话'), false);
});

test('原行为不变：useMarkdownCard 开着且有 markdown 时照旧发卡片', () => {
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '**加粗**'), true);
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '# 标题'), true);
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '```\ncode\n```'), true);
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '- 列表项'), true);
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '| a | b |\n| - | - |'), true);
  assert.equal(shouldUseCard({ useMarkdownCard: true }, '没有格式的纯文本'), false);
});

test('hasMarkdownContent 与迁移前逐字一致', () => {
  assert.equal(hasMarkdownContent('普通'), false);
  assert.equal(hasMarkdownContent('1. 编号'), true);
  assert.equal(hasMarkdownContent('| a |\n| - |'), true);
  assert.equal(hasMarkdownContent('a | b'), false);
});
