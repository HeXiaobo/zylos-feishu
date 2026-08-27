import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import packageJson from '../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);

test('ordinary Feishu ecosystem cannot implicitly start task projection', () => {
  const ecosystem = require('../ecosystem.config.cjs');
  const [ordinaryFeishu] = ecosystem.apps;

  assert.deepEqual(ecosystem.apps.map(({ name }) => name), ['zylos-feishu']);
  assert.equal(
    Object.hasOwn(ordinaryFeishu.env, 'COMMITMENT_FEISHU_PROJECTION_AUTOSTART'),
    false,
  );
  assert.equal(
    Object.hasOwn(ordinaryFeishu.env, 'COMMITMENT_FEISHU_TASK_V2_PROJECTION_AUTOSTART'),
    false,
  );
  assert.equal(
    Object.hasOwn(ordinaryFeishu.env, 'COMMITMENT_FEISHU_TASK_V2_ENABLED'),
    false,
  );
  assert.equal(Object.hasOwn(ordinaryFeishu.env, 'FEISHU_TASK_COMMENTS_ENABLED'), false);
});

test('Task comment processes consume capability flags from the shared dotenv config', () => {
  const ecosystem = require('../ecosystem.task-comments.config.cjs');
  const [comments] = ecosystem.apps;

  assert.equal(comments.env.FEISHU_TASK_COMMENTS_WORKER_AUTOSTART, '1');
  assert.equal(Object.hasOwn(comments.env, 'FEISHU_TASK_COMMENTS_ENABLED'), false);
  assert.equal(Object.hasOwn(comments.env, 'COMMITMENT_FEISHU_TASK_V2_ENABLED'), false);
  assert.doesNotMatch(packageJson.scripts['task-comments:once'], /FEISHU_TASK_COMMENTS_ENABLED=/);
});

test('ships Task v2 as a second explicit projection process', () => {
  const ecosystem = require('../ecosystem.task-v2-projection.config.cjs');
  const [projection] = ecosystem.apps;

  assert.equal(ecosystem.apps.length, 1);
  assert.equal(projection.name, 'zylos-feishu-task-v2-projection');
  assert.equal(
    projection.script,
    path.join(
      os.homedir(),
      'zylos/.claude/skills/feishu/src/lib/task-v2-projection-worker.js',
    ),
  );
  assert.deepEqual(projection.args, ['run']);
  assert.equal(projection.instances, 1);
  assert.equal(projection.exec_mode, 'fork');
  assert.equal(projection.env.ZYLOS_DIR, path.join(os.homedir(), 'zylos'));
  assert.equal(projection.env.COMMITMENT_FEISHU_TASK_V2_PROJECTION_AUTOSTART, '1');
  assert.equal(
    Object.hasOwn(projection.env, 'COMMITMENT_FEISHU_TASK_V2_ENABLED'),
    false,
  );
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
  assert.equal(projection.env.COMMITMENT_FEISHU_PROJECTION_AUTOSTART, '1');
});
