import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimDirPath, claimLibPath, loadClaimStore, sharedClaimEnabled } from '../src/lib/dedupe-claim-loader.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-claim-loader-'));
}

const STUB_MODULE = `
export function createClaimStore(options = {}) {
  const claimed = new Set();
  return {
    dir: options.dir,
    via: options.via,
    claim(id) { if (claimed.has(id)) return false; claimed.add(id); return true; },
    ownerOf(id) { return claimed.has(id) ? { id, via: options.via } : null; },
    sweep() { return 0; },
  };
}
`;

test('claimLibPath: explicit override wins', () => {
  assert.equal(
    claimLibPath({ ZYLOS_FEISHU_CLAIM_LIB: '/opt/x/claim.mjs', HOME: '/home/zylos' }),
    '/opt/x/claim.mjs',
  );
});

test('claimLibPath: defaults to the image copy under zylos/lib/3ai', () => {
  assert.equal(
    claimLibPath({ HOME: '/home/zylos' }),
    path.join('/home/zylos', 'zylos', 'lib', '3ai', 'feishu-claim.mjs'),
  );
  assert.equal(
    claimLibPath({ HOME: '/home/zylos', ZYLOS_DIR: '/data/z' }),
    path.join('/data/z', 'lib', '3ai', 'feishu-claim.mjs'),
  );
});

test('shared claim is off unless the entrypoint marked the data volume', async () => {
  const home = tmpdir();
  const env = { HOME: home };
  const loaded = await loadClaimStore({ via: 'ws', env });
  assert.equal(loaded.store, null);
  assert.match(loaded.error, /shared claim is off/);
  // Off must not touch the data volume: no claim dir, no claim files.
  assert.equal(fs.existsSync(claimDirPath(env)), false);
  assert.equal(sharedClaimEnabled(env), false);
});

test('loadClaimStore: imports the shared module and tags the claims', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'feishu-claim.mjs');
  const dedup = path.join(dir, 'dedup');
  fs.writeFileSync(file, STUB_MODULE);
  fs.mkdirSync(dedup, { recursive: true });
  fs.writeFileSync(path.join(dedup, '.enabled'), '{}\n');
  const loaded = await loadClaimStore({ via: 'ws', env: { ZYLOS_FEISHU_CLAIM_LIB: file, ZYLOS_FEISHU_DEDUP_DIR: dedup } });
  try {
    assert.equal(loaded.error, undefined);
    assert.equal(typeof loaded.store.claim, 'function');
    assert.equal(loaded.store.claim('om_a'), true);
    assert.equal(loaded.store.claim('om_a'), false);
    assert.equal(loaded.store.ownerOf('om_a').via, 'ws');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadClaimStore: a missing module is reported, not thrown', async () => {
  const dedup = tmpdir();
  fs.writeFileSync(path.join(dedup, '.enabled'), '{}\n');
  const loaded = await loadClaimStore({
    env: { ZYLOS_FEISHU_CLAIM_LIB: '/nonexistent/claim.mjs', ZYLOS_FEISHU_DEDUP_DIR: dedup },
  });
  assert.equal(loaded.store, null);
  assert.match(loaded.error, /not found/);
});

test('loadClaimStore: a module without createClaimStore is rejected', async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'empty.mjs');
  const dedup = path.join(dir, 'dedup');
  fs.mkdirSync(dedup, { recursive: true });
  fs.writeFileSync(path.join(dedup, '.enabled'), '{}\n');
  fs.writeFileSync(file, 'export const nothing = 1;\n');
  try {
    const loaded = await loadClaimStore({ env: { ZYLOS_FEISHU_CLAIM_LIB: file, ZYLOS_FEISHU_DEDUP_DIR: dedup } });
    assert.equal(loaded.store, null);
    assert.match(loaded.error, /createClaimStore is not exported/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The channel must keep working when the image has no claim module: the loader
// reports and index.js stays on the in-process Map.
test('index.js loads the claim store and consults it before handling a message', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'index.js'), 'utf8');
  assert.match(source, /loadClaimStore\(\{ via: 'ws', log:/);
  assert.match(source, /claimStore\.claim\(messageId\)/);
  assert.match(source, /claimStore\.sweep\(\)/);
  // The claim check must come before the message is recorded as seen.
  const claim = source.indexOf('claimStore.claim(messageId)');
  const record = source.indexOf('processedMessages.set(messageId, Date.now())');
  assert.ok(claim > -1 && record > claim);
});
