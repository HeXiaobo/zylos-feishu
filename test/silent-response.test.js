import assert from 'node:assert/strict';
import test from 'node:test';

import { isSilentResponse } from '../src/lib/silent-response.js';

test('recognizes exact and runtime-decorated terminal skip decisions', () => {
  assert.equal(isSilentResponse('[SKIP]'), true);
  assert.equal(isSilentResponse('Just a stray "A", not for me.\n\n[SKIP]'), true);
  assert.equal(isSilentResponse('与当前 Agent 无关。\r\n  [SKIP]  '), true);
});

test('does not swallow ordinary discussion of the skip marker', () => {
  assert.equal(isSilentResponse('请解释 [SKIP] 是什么意思。'), false);
  assert.equal(isSilentResponse('可以回复 [SKIP] 或继续处理。'), false);
  assert.equal(isSilentResponse('```text\n[SKIP]\n```'), false);
  assert.equal(isSilentResponse(''), false);
  assert.equal(isSilentResponse(null), false);
});
