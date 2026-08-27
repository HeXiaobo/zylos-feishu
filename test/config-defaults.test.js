import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CONFIG, getStreamProcessDisplay } from '../src/lib/config.js';

test('new deployments default ordinary assistant replies to the unified card format', () => {
  assert.equal(DEFAULT_CONFIG.message.useMarkdownCard, true);
});

test('new deployments default streaming process UI to a collapsible status', () => {
  assert.equal(DEFAULT_CONFIG.message.streamProcessDisplay, 'collapsible');
});

test('older and invalid configs resolve to the safe supported process display', () => {
  assert.equal(getStreamProcessDisplay({ message: { useMarkdownCard: true } }), 'collapsible');
  assert.equal(getStreamProcessDisplay({ message: { streamProcessDisplay: 'unknown' } }), 'collapsible');
  assert.equal(getStreamProcessDisplay({ message: { streamProcessDisplay: 'answer_only' } }), 'answer_only');
});
