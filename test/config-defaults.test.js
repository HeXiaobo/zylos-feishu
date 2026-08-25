import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG } from '../src/lib/config.js';

test('new deployments default ordinary assistant replies to the unified card format', () => {
  assert.equal(DEFAULT_CONFIG.message.useMarkdownCard, true);
});
