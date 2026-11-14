import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseCard, hasMarkdownContent } from '../src/lib/card-decision.js';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

test('plain text defaults to cards, including old partial message config', () => {
  for (const config of [undefined, {}, { useMarkdownCard: true }, DEFAULT_CONFIG.message]) {
    assert.equal(shouldUseCard(config, '普通一句话'), true);
  }
});
test('alwaysCard true includes empty/plain content', () => {
  assert.equal(shouldUseCard({ useMarkdownCard: true, alwaysCard: true }, ''), true);
});
test('explicit useMarkdownCard false is the master switch', () => {
  assert.equal(shouldUseCard({ useMarkdownCard: false, alwaysCard: true }, '**文本**'), false);
});
test('explicit alwaysCard false retains markdown-only behavior', () => {
  assert.equal(shouldUseCard({ alwaysCard: false }, '普通'), false);
  for (const text of ['**加粗**', '# 标题', '```\ncode\n```', '- 列表', '| a |\n| - |']) {
    assert.equal(shouldUseCard({ alwaysCard: false }, text), true);
  }
});
test('markdown detection from PR 110 preserved', () => {
  assert.equal(hasMarkdownContent('普通'), false);
  assert.equal(hasMarkdownContent('1. 编号'), true);
  assert.equal(hasMarkdownContent('a | b'), false);
});
