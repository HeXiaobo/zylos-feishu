import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkCoreCompatibility } from '../src/lib/core-compatibility.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function fakeZylos(t, capabilities) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-core-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, 'zylos');
  fs.writeFileSync(
    cli,
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(capabilities))});\n`,
    { mode: 0o700 },
  );
  return cli;
}

test('accepts a Core that satisfies every required protocol', (t) => {
  const cli = fakeZylos(t, {
    schemaVersion: 1,
    product: 'zylos-core',
    release: '0.7.2-rc.3',
    protocols: {
      'c4.reply': 2,
      'c4.reply.argv-compat': 1,
      'c4.assistant-response-stream': 1,
      'work-intake': 1,
      'commitment-core': 1,
      'projection-outbox': 1,
    },
  });

  const result = checkCoreCompatibility({
    env: { ...process.env, ZYLOS_CLI_PATH: cli },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.core.release, '0.7.2-rc.3');
});

test('reports every missing or outdated protocol before upgrade', (t) => {
  const cli = fakeZylos(t, {
    schemaVersion: 1,
    product: 'zylos-core',
    release: '0.7.1',
    protocols: {
      'c4.reply': 1,
      'c4.assistant-response-stream': 1,
    },
  });

  const result = checkCoreCompatibility({
    env: { ...process.env, ZYLOS_CLI_PATH: cli },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'Protocol c4.reply requires >= 2, found 1',
    'Protocol c4.reply.argv-compat requires >= 1, found missing',
    'Protocol work-intake requires >= 1, found missing',
    'Protocol commitment-core requires >= 1, found missing',
    'Protocol projection-outbox requires >= 1, found missing',
  ]);
});

test('pre-upgrade aborts before backing up config when Core is incompatible', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-pre-upgrade-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, 'zylos', 'components', 'feishu');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), '{"enabled":true}\n');

  const cli = fakeZylos(t, {
    schemaVersion: 1,
    product: 'zylos-core',
    release: '0.7.1',
    protocols: {},
  });
  const result = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'pre-upgrade.js')], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ZYLOS_CLI_PATH: cli },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Incompatible zylos-core/);
  assert.equal(fs.existsSync(path.join(configDir, 'config.json.backup')), false);
});
