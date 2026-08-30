import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CONFIG,
  getResponseStreamMainTimeoutMs,
  getResponseStreamQueuedTimeoutMs,
  getStreamProcessDisplay,
} from '../src/lib/config.js';

test('new deployments default ordinary assistant replies to the unified card format', () => {
  assert.equal(DEFAULT_CONFIG.message.useMarkdownCard, true);
});

test('new deployments default streaming process UI to a collapsible status', () => {
  assert.equal(DEFAULT_CONFIG.message.streamProcessDisplay, 'collapsible');
});

test('queued response timeout defaults safely and rejects invalid configuration', () => {
  assert.equal(DEFAULT_CONFIG.message.responseStreamQueuedTimeoutMs, 60_000);
  assert.equal(getResponseStreamQueuedTimeoutMs({ message: {} }), 60_000);
  assert.equal(getResponseStreamQueuedTimeoutMs({ message: { responseStreamQueuedTimeoutMs: 30_000 } }), 30_000);
  assert.equal(getResponseStreamQueuedTimeoutMs({ message: { responseStreamQueuedTimeoutMs: 0 } }), 60_000);
});

test('main response timeout defaults to fifteen minutes and rejects invalid configuration', () => {
  assert.equal(DEFAULT_CONFIG.message.responseStreamMainTimeoutMs, 900_000);
  assert.equal(getResponseStreamMainTimeoutMs({ message: {} }), 900_000);
  assert.equal(getResponseStreamMainTimeoutMs({ message: { responseStreamMainTimeoutMs: 120_000 } }), 120_000);
  assert.equal(getResponseStreamMainTimeoutMs({ message: { responseStreamMainTimeoutMs: 0 } }), 900_000);
});

test('older and invalid configs resolve to the safe supported process display', () => {
  assert.equal(getStreamProcessDisplay({ message: { useMarkdownCard: true } }), 'collapsible');
  assert.equal(getStreamProcessDisplay({ message: { streamProcessDisplay: 'unknown' } }), 'collapsible');
  assert.equal(getStreamProcessDisplay({ message: { streamProcessDisplay: 'answer_only' } }), 'answer_only');
});
