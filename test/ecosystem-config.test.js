import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('ordinary Feishu ecosystem cannot implicitly start task projection', () => {
  const ecosystem = require('../ecosystem.config.cjs');

  assert.deepEqual(ecosystem.apps.map(({ name }) => name), ['zylos-feishu']);
});

test('ships a separate opt-in PM2 process for the durable Core projection worker', () => {
  const ecosystem = require('../ecosystem.task-projection.config.cjs');
  const [projection] = ecosystem.apps;

  assert.ok(projection);
  assert.equal(ecosystem.apps.length, 1);
  assert.equal(
    projection.script,
    path.join(
      os.homedir(),
      'zylos/.claude/skills/commitment-core/scripts/feishu-projection-worker.js',
    ),
  );
  assert.deepEqual(projection.args, [
    'run',
    '--runtime-module',
    path.join(
      os.homedir(),
      'zylos/.claude/skills/feishu/src/lib/feishu-projection-runtime.js',
    ),
  ]);
  assert.equal(projection.instances, 1);
  assert.equal(projection.exec_mode, 'fork');
  assert.equal(projection.env.ZYLOS_DIR, path.join(os.homedir(), 'zylos'));
});
