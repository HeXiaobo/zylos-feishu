import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openSmartSilentMarkerStore } from '../src/lib/smart-silent-marker.js';

const REQUEST_ID = 'assistant.feishu.0123456789abcdef0123456789abcdef01234567';

test('markers are durable, idempotent, and release exactly once', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-silent-marker-'));
  try {
    let now = 1_788_220_800_000;
    const store = openSmartSilentMarkerStore({ directory, clock: () => now });

    const first = store.mark(REQUEST_ID, { messageId: 'om-1', chatId: 'oc-1' });
    assert.equal(first.created, true);
    assert.deepEqual(first.entry, {
      schemaVersion: 1,
      type: 'SmartSilentRequest',
      requestId: REQUEST_ID,
      messageId: 'om-1',
      chatId: 'oc-1',
      createdAt: 1_788_220_800_000,
    });
    now += 5_000;
    const replay = store.mark(REQUEST_ID, { messageId: 'om-1', chatId: 'oc-1' });
    assert.equal(replay.created, false);
    assert.equal(replay.entry.createdAt, 1_788_220_800_000);
    assert.deepEqual(store.get(REQUEST_ID), first.entry);

    assert.equal(store.release(REQUEST_ID), true);
    assert.equal(store.release(REQUEST_ID), false);
    assert.equal(store.get(REQUEST_ID), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('concurrent or racy marks converge on one entry', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-silent-race-'));
  try {
    const store = openSmartSilentMarkerStore({ directory, clock: () => 1_788_220_800_000 });
    const first = store.mark(REQUEST_ID, { messageId: 'om-1', chatId: 'oc-1' });
    const second = store.mark(REQUEST_ID, { messageId: 'om-1', chatId: 'oc-1' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.entry, first.entry);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prune removes only entries past their TTL and corrupt debris', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-silent-prune-'));
  try {
    let now = 1_788_220_800_000;
    const store = openSmartSilentMarkerStore({ directory, clock: () => now, ttlMs: 1_000 });
    const staleId = 'assistant.feishu.ffffffffffffffffffffffffffffffffffffffff';
    store.mark(staleId, { messageId: 'om-2', chatId: 'oc-1' });
    now += 5_000;
    store.mark(REQUEST_ID, { messageId: 'om-1', chatId: 'oc-1' });
    writeFileSync(
      path.join(directory, 'assistant.feishu.corrupt.silent.json'),
      '{not json',
      'utf8',
    );

    const { removed } = store.prune();
    assert.equal(removed, 2);
    assert.equal(store.get(staleId), null);
    assert.notEqual(store.get(REQUEST_ID), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('identifiers and required fields fail closed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-silent-invalid-'));
  try {
    const store = openSmartSilentMarkerStore({ directory, clock: () => 1_788_220_800_000 });
    assert.throws(() => store.get('../escape'), TypeError);
    assert.throws(() => store.get(''), TypeError);
    assert.throws(
      () => store.mark(REQUEST_ID, { messageId: '', chatId: 'oc-1' }),
      TypeError,
    );
    assert.throws(
      () => store.mark(REQUEST_ID, { messageId: 'om-1', chatId: '' }),
      TypeError,
    );
    assert.throws(
      () => openSmartSilentMarkerStore({ directory, ttlMs: 0 }),
      TypeError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
