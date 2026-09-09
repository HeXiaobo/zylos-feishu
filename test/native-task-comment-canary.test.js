import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import test from 'node:test';

const SCRIPT = path.resolve('scripts/native-task-comment-canary.js');
const APP_ID = 'cli_observed_app';
const TASK_GUID = 'task-guid-canary';
const CONTENT = 'Please close this canary.';

function createFakeLarkCli(directory) {
  const logPath = path.join(directory, 'invocations.ndjson');
  const scriptPath = path.join(directory, 'fake-lark-cli');
  writeFileSync(scriptPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LARK_LOG, JSON.stringify(args) + '\\n');
const taskIndex = args.indexOf('--task-id');
const contentIndex = args.indexOf('--content');
const taskGuid = args[taskIndex + 1];
const content = args[contentIndex + 1];
if (args.includes('--dry-run')) {
  process.stdout.write(JSON.stringify({
    ok: true,
    identity: 'user',
    dry_run: true,
    data: {
      api: [{
        method: 'POST',
        url: '/open-apis/task/v2/comments',
        params: { user_id_type: 'open_id' },
        body: { content, resource_id: taskGuid, resource_type: 'task' },
      }],
      context: { app_id: '${APP_ID}', user_open_id: 'ou_canary_user' },
    },
    _notice: { update: { current: 'test', latest: 'test' } },
  }));
} else if (process.env.FAKE_LARK_MODE === 'fail') {
  process.stdout.write(JSON.stringify({
    ok: false,
    identity: 'user',
    error: { type: 'api', message: 'simulated send failure' },
  }));
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    identity: 'user',
    data: { id: 'comment-returned-by-cli' },
    _notice: { update: { current: 'test', latest: 'test' } },
  }));
}
`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return { logPath, scriptPath };
}

function runCanary({ directory, cliPath, outputPath, mode, expectedAppId = APP_ID } = {}) {
  return spawnSync(process.execPath, [
    SCRIPT,
    '--task-id', TASK_GUID,
    '--content', CONTENT,
    '--app-id', expectedAppId,
    '--lark-cli', cliPath,
    ...(outputPath ? ['--output', outputPath] : []),
  ], {
    cwd: path.dirname(SCRIPT),
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_LARK_LOG: path.join(directory, 'invocations.ndjson'),
      ...(mode ? { FAKE_LARK_MODE: mode } : {}),
    },
  });
}

function invocationLog(logPath) {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('CLI adapter validates the real dry-run and send envelopes and emits a bound receipt', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-canary-cli-'));
  const { logPath, scriptPath } = createFakeLarkCli(directory);
  const outputPath = path.join(directory, 'sender-receipt.json');
  try {
    const result = runCanary({ directory, cliPath: scriptPath, outputPath });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(receipt.schema, 'zylos.native-task-comment-sender/v1');
    assert.equal(receipt.hostname, os.hostname());
    assert.equal(receipt.appId, APP_ID);
    assert.equal(receipt.taskGuid, TASK_GUID);
    assert.equal(receipt.commentId, 'comment-returned-by-cli');
    assert.deepEqual(receipt.dryRun, {
      ok: true,
      identity: 'user',
      context: { appId: APP_ID, userOpenId: 'ou_canary_user' },
      request: {
        method: 'POST',
        url: '/open-apis/task/v2/comments',
        resourceType: 'task',
        taskGuid: TASK_GUID,
      },
    });
    assert.deepEqual(receipt.response, {
      ok: true,
      identity: 'user',
      data: { id: 'comment-returned-by-cli' },
    });
    assert.deepEqual(receipt.responseBinding, {
      appId: APP_ID,
      taskGuid: TASK_GUID,
      commentId: 'comment-returned-by-cli',
    });
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);

    const calls = invocationLog(logPath);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].at(-1), '--json');
    assert.ok(calls[0].includes('--dry-run'));
    assert.ok(!calls[1].includes('--dry-run'));
    for (const call of calls) {
      assert.deepEqual(call.slice(0, 4), ['task', '+comment', '--as', 'user']);
      assert.equal(call[call.indexOf('--task-id') + 1], TASK_GUID);
      assert.equal(call[call.indexOf('--content') + 1], CONTENT);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('CLI reserves --output before any dry-run or live send and preserves an existing file', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-canary-existing-'));
  const { scriptPath } = createFakeLarkCli(directory);
  const outputPath = path.join(directory, 'existing.json');
  writeFileSync(outputPath, 'keep me\n', 'utf8');
  try {
    const result = runCanary({ directory, cliPath: scriptPath, outputPath });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /EEXIST|file already exists/);
    assert.equal(readFileSync(outputPath, 'utf8'), 'keep me\n');
    assert.equal(existsSync(path.join(directory, 'invocations.ndjson')), false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('CLI rejects an observed dry-run App mismatch before the live command', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-canary-app-mismatch-'));
  const { logPath, scriptPath } = createFakeLarkCli(directory);
  const outputPath = path.join(directory, 'sender-error.json');
  try {
    const result = runCanary({
      directory,
      cliPath: scriptPath,
      outputPath,
      expectedAppId: 'cli_expected_other_app',
    });

    assert.equal(result.status, 2);
    const artifact = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(artifact.stage, 'reserve-output');
    assert.equal(artifact.uncertain, false);
    assert.equal(artifact.error.response.data.context.app_id, APP_ID);
    assert.equal(invocationLog(logPath).length, 1);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('a failed live response leaves raw response evidence and an uncertain artifact without retrying', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-canary-failure-'));
  const { logPath, scriptPath } = createFakeLarkCli(directory);
  const outputPath = path.join(directory, 'sender-error.json');
  try {
    const result = runCanary({
      directory,
      cliPath: scriptPath,
      outputPath,
      mode: 'fail',
    });

    assert.equal(result.status, 2);
    const artifact = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(artifact.schema, 'zylos.native-task-comment-sender/error-v1');
    assert.equal(artifact.uncertain, true);
    assert.equal(artifact.stage, 'send');
    assert.equal(artifact.sendResponse.ok, false);
    assert.equal(artifact.error.response.ok, false);
    assert.equal(invocationLog(logPath).length, 2);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
