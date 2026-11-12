import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG } from '../src/lib/config.js';

test('new sender-policy fields ship with safe defaults', () => {
  assert.deepEqual(DEFAULT_CONFIG.groupAllowTenants, []);
  assert.deepEqual(DEFAULT_CONFIG.internalCrossTenantUsers, []);
  assert.equal(DEFAULT_CONFIG.groupRejectMode, 'silent');
  assert.equal(DEFAULT_CONFIG.groupRejectText, '');
});

test('a config written before the sender-policy fields keeps the documented defaults', async () => {
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
