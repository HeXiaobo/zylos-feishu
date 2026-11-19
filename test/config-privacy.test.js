import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

test('saving configuration keeps tokens private even when an old temp file was public', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-config-mode-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'zylos/components/feishu');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ verification_token: 'test-only' }), { mode: 0o644 });
  fs.writeFileSync(`${file}.tmp`, 'old', { mode: 0o644 });
  const code = `import { loadConfig, saveConfig } from ${JSON.stringify(new URL('../src/lib/config.js', import.meta.url).href)};
    const config=loadConfig(); if (!saveConfig(config)) process.exit(1);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { HOME: home, PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).verification_token, 'test-only');
});
