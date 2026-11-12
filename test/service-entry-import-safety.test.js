import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = new URL('../src/index.js', import.meta.url).href;

test('importing the service rejects before reading credentials or writing runtime state', () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-import-safety-'));
  try {
    fs.mkdirSync(path.join(isolatedHome, 'zylos'));
    fs.writeFileSync(path.join(isolatedHome, 'zylos/.env'), 'FEISHU_IMPORT_SAFETY_SENTINEL=loaded\n');
    const env = { ...process.env, HOME: isolatedHome };
    for (const key of Object.keys(env)) {
      if (/^(FEISHU_|C4_|ZYLOS_)/.test(key)) delete env[key];
    }
    const script = `
      import fs from 'node:fs';
      try {
        await import(${JSON.stringify(entry)});
        process.exitCode = 2;
      } catch (error) {
        console.log(JSON.stringify({
          message: error.message,
          credentialsLoaded: Boolean(process.env.FEISHU_IMPORT_SAFETY_SENTINEL),
          stateCreated: fs.existsSync(process.env.HOME + '/zylos/components'),
        }));
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.match(report.message, /service entry point/);
    assert.equal(report.credentialsLoaded, false);
    assert.equal(report.stateCreated, false);
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
});
