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

test('a config written before the sender-policy fields keeps the documented defaults', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-config-legacy-'));
  const previousHome = process.env.HOME;
  try {
    const dataDir = path.join(home, 'zylos/components/feishu');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      groupPolicy: 'allowlist',
      groups: { oc_legacy: { name: 'legacy', mode: 'smart', requireMention: false } },
    }));
    process.env.HOME = home;
    // The module resolves DATA_DIR at import time, so import it fresh.
    const configModule = await import(`../src/lib/config.js?legacy=${Date.now()}`);
    const loaded = configModule.loadConfig();
    assert.deepEqual(loaded.groupAllowTenants, []);
    assert.deepEqual(loaded.internalCrossTenantUsers, []);
    assert.equal(loaded.groupRejectMode, 'silent');
    assert.equal(loaded.groupRejectText, '');
    assert.deepEqual(loaded.groups.oc_legacy, { name: 'legacy', mode: 'smart', requireMention: false });
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
