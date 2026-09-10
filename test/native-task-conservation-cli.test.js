import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readNativeTaskConservationPm2Processes,
  readNativeTaskConservationRuntimeEnv,
  resolveNativeTaskConservationEnvPath,
  resolveNativeTaskConservationPolicy,
  runNativeTaskConservationGate,
} from '../scripts/native-task-conservation-gate.js';

const APP_ID = 'cli_a9f4963828b89bdf';
const AGENT_ID = 'agent:yueran';

function managedProcess(runtime, {
  status = 'online',
  cwd = path.join(runtime, '.claude/skills/feishu'),
  script = path.join(runtime, '.claude/skills/feishu/src/index.js'),
  flag,
  pm2Flag,
} = {}) {
  return {
    valid: true,
    name: 'zylos-feishu',
    status,
    cwd,
    script,
    envFlag: flag === undefined
      ? { present: false, enabled: null }
      : { present: true, enabled: flag },
    pm2Flag: pm2Flag === undefined
      ? { present: false, enabled: null }
      : { present: true, enabled: pm2Flag },
  };
}

function runtimeEnv({ present = true, flag } = {}) {
  return {
    path: '/runtime/xiaochen/.env',
    present,
    flag: flag === undefined
      ? { present: false, enabled: null }
      : { present: true, enabled: flag },
  };
}

function runtimePolicyInputs({ runtime = '/runtime/xiaochen', status, processFlag, fileFlag } = {}) {
  return {
    env: {
      ZYLOS_DIR: runtime,
      COMMITMENT_FEISHU_TASK_V2_ENABLED: '0',
    },
    runtimeEnv: runtimeEnv({ flag: fileFlag }),
    pm2: {
      ok: true,
      processes: [managedProcess(runtime, { status, flag: processFlag })],
    },
  };
}

test('resolves the runtime env from ZYLOS_DIR and preserves the default layout', () => {
  assert.equal(
    resolveNativeTaskConservationEnvPath({ ZYLOS_DIR: '/runtime/custom', HOME: '/ignored' }),
    '/runtime/custom/.env',
  );
  assert.equal(
    resolveNativeTaskConservationEnvPath({ HOME: '/runtime/home' }),
    '/runtime/home/zylos/.env',
  );
});

test('reads only the Task v2 flag from the target runtime .env', () => {
  const result = readNativeTaskConservationRuntimeEnv({
    env: { ZYLOS_DIR: '/runtime/xiaochen' },
    readFile(filePath) {
      assert.equal(filePath, '/runtime/xiaochen/.env');
      return 'FEISHU_APP_SECRET=do-not-return\nCOMMITMENT_FEISHU_TASK_V2_ENABLED=0\n';
    },
  });

  assert.deepEqual(result, {
    path: '/runtime/xiaochen/.env',
    present: true,
    flag: { present: true, enabled: false },
  });
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
});

test('parses PM2 jlist without retaining process secrets', () => {
  const result = readNativeTaskConservationPm2Processes({
    execFile(command, args) {
      assert.equal(command, 'pm2');
      assert.deepEqual(args, ['jlist']);
      return JSON.stringify([{
        name: 'zylos-feishu',
        pm2_env: {
          status: 'online',
          pm_cwd: '/runtime/xiaochen/.claude/skills/feishu',
          pm_exec_path: '/runtime/xiaochen/.claude/skills/feishu/src/index.js',
          env: {
            COMMITMENT_FEISHU_TASK_V2_ENABLED: '1',
            FEISHU_APP_SECRET: 'do-not-return',
          },
          COMMITMENT_FEISHU_TASK_V2_ENABLED: '1',
        },
      }]);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.processes, [managedProcess('/runtime/xiaochen', {
    flag: true,
    pm2Flag: true,
  })]);
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
});

test('treats a present runtime .env with no Task v2 flag as verified default-disabled', () => {
  const policy = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs(),
  });

  assert.deepEqual(policy, {
    schema: 'zylos.native-task-conservation-policy/v1',
    projectionRequired: false,
    taskV2Enabled: false,
    verified: true,
    source: 'runtime-default',
    reasonCode: 'TASK_V2_RUNTIME_DEFAULT_DISABLED',
  });
});

test('requires projection when the target runtime is enabled, regardless of caller env', () => {
  const policy = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({ fileFlag: true }),
  });

  assert.equal(policy.projectionRequired, true);
  assert.equal(policy.taskV2Enabled, true);
  assert.equal(policy.verified, true);
  assert.equal(policy.source, 'runtime-dotenv');
});

test('gives an online PM2 process precedence over dotenv', () => {
  const enabled = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({ fileFlag: false, processFlag: true }),
  });
  assert.equal(enabled.projectionRequired, true);
  assert.equal(enabled.source, 'pm2-environment');

  const disabled = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({ fileFlag: true, processFlag: false }),
  });
  assert.equal(disabled.projectionRequired, false);
  assert.equal(disabled.source, 'pm2-environment');
});

test('reads PM2 top-level flags and fails closed on conflicting PM2 flag layers', () => {
  const topLevelEnabled = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs(),
    pm2: {
      ok: true,
      processes: [managedProcess('/runtime/xiaochen', { pm2Flag: true })],
    },
  });
  assert.equal(topLevelEnabled.projectionRequired, true);
  assert.equal(topLevelEnabled.source, 'pm2-environment');

  const topLevelDisabled = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({ fileFlag: true }),
    pm2: {
      ok: true,
      processes: [managedProcess('/runtime/xiaochen', { pm2Flag: false })],
    },
  });
  assert.equal(topLevelDisabled.projectionRequired, false);
  assert.equal(topLevelDisabled.source, 'pm2-environment');

  const conflict = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs(),
    pm2: {
      ok: true,
      processes: [managedProcess('/runtime/xiaochen', { flag: false, pm2Flag: true })],
    },
  });
  assert.equal(conflict.projectionRequired, true);
  assert.equal(conflict.verified, false);
  assert.equal(conflict.reasonCode, 'TASK_V2_PM2_FLAG_CONFLICT');
});

test('holds when an exact Task v2 projection worker is online with its flag enabled', () => {
  const runtime = '/runtime/xiaochen';
  const policy = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs(),
    pm2: {
      ok: true,
      processes: [
        managedProcess(runtime),
        managedProcess(runtime, {
          script: path.join(runtime, '.claude/skills/feishu/src/lib/task-v2-projection-worker.js'),
          pm2Flag: true,
        }),
      ],
    },
  });

  assert.equal(policy.projectionRequired, true);
  assert.equal(policy.verified, false);
  assert.equal(policy.reasonCode, 'TASK_V2_WORKER_MAIN_FLAG_CONFLICT');
});

test('keeps policy strict for wrong runtime, no online process, and conflicting matches', () => {
  const wrongRuntime = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({
      pm2: undefined,
    }),
    pm2: {
      ok: true,
      processes: [managedProcess('/runtime/other')],
    },
  });
  assert.equal(wrongRuntime.projectionRequired, true);
  assert.equal(wrongRuntime.verified, false);

  const noOnline = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({ status: 'stopped', fileFlag: false }),
  });
  assert.equal(noOnline.projectionRequired, true);
  assert.equal(noOnline.verified, false);

  const conflicting = resolveNativeTaskConservationPolicy({
    ...runtimePolicyInputs({ fileFlag: false }),
    pm2: {
      ok: true,
      processes: [
        managedProcess('/runtime/xiaochen', { flag: false }),
        managedProcess('/runtime/xiaochen', { flag: true }),
      ],
    },
  });
  assert.equal(conflicting.projectionRequired, true);
  assert.equal(conflicting.verified, false);
});

test('cannot produce disabled policy from a caller flag when runtime evidence is unavailable', () => {
  const policy = resolveNativeTaskConservationPolicy({
    env: {
      ZYLOS_DIR: '/runtime/xiaochen',
      COMMITMENT_FEISHU_TASK_V2_ENABLED: '0',
    },
    runtimeEnv: runtimeEnv({ present: false }),
    pm2: {
      ok: true,
      processes: [managedProcess('/runtime/xiaochen')],
    },
  });

  assert.equal(policy.projectionRequired, true);
  assert.equal(policy.taskV2Enabled, null);
  assert.equal(policy.verified, false);
});

test('runs an unlinked active task through the verified disabled policy and keeps it in the report', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-conservation-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryPath = path.join(directory, 'core.json');
  writeFileSync(inventoryPath, JSON.stringify({
    schema: 'zylos.native-task-core-inventory/v1',
    capturedAt: '2026-08-27T03:00:00.000Z',
    snapshot: {
      stable: true,
      strategy: 'double-read-fingerprint',
      fingerprint: 'c'.repeat(64),
    },
    identity: { agentId: AGENT_ID },
    tasks: [{
      id: 'task-disabled-cli',
      state: 'review',
      assigneeId: AGENT_ID,
      updatedAt: '2026-08-27T03:00:00.000Z',
    }],
    externalLinks: [],
  }));

  const report = await runNativeTaskConservationGate({
    args: ['--core-inventory-file', inventoryPath, '--timeout-ms', '5000'],
    env: {
      ...runtimePolicyInputs().env,
      ZYLOS_AGENT_ID: AGENT_ID,
      FEISHU_APP_ID: APP_ID,
      FEISHU_TASK_V2_AGENT_APP_IDS: JSON.stringify({ [AGENT_ID]: APP_ID }),
      C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: AGENT_ID,
    },
    readRuntimeEnv: () => runtimeEnv(),
    readPm2Processes: () => runtimePolicyInputs().pm2,
    createReader() {
      return { async capture() {
        return { identity: { kind: 'app', appId: APP_ID }, tasks: [] };
      } };
    },
  });

  assert.equal(report.passed, true);
  assert.equal(report.policy.projectionRequired, false);
  assert.equal(report.counts.unprojectedLocalTasks, 1);
  assert.deepEqual(report.inventory.core.tasks.map(task => task.id), ['task-disabled-cli']);
});

test('holds the same unlinked active task when target runtime evidence enables Task v2', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-conservation-policy-enabled-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryPath = path.join(directory, 'core.json');
  writeFileSync(inventoryPath, JSON.stringify({
    schema: 'zylos.native-task-core-inventory/v1',
    capturedAt: '2026-08-27T03:00:00.000Z',
    snapshot: {
      stable: true,
      strategy: 'double-read-fingerprint',
      fingerprint: 'd'.repeat(64),
    },
    identity: { agentId: AGENT_ID },
    tasks: [{
      id: 'task-enabled-cli',
      state: 'ready',
      assigneeId: AGENT_ID,
      updatedAt: '2026-08-27T03:00:00.000Z',
    }],
    externalLinks: [],
  }));

  const report = await runNativeTaskConservationGate({
    args: ['--core-inventory-file', inventoryPath, '--timeout-ms', '5000'],
    env: {
      ...runtimePolicyInputs().env,
      ZYLOS_AGENT_ID: AGENT_ID,
      FEISHU_APP_ID: APP_ID,
      FEISHU_TASK_V2_AGENT_APP_IDS: JSON.stringify({ [AGENT_ID]: APP_ID }),
      C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: AGENT_ID,
    },
    readRuntimeEnv: () => runtimeEnv({ flag: true }),
    readPm2Processes: () => runtimePolicyInputs().pm2,
    createReader() {
      return { async capture() {
        return { identity: { kind: 'app', appId: APP_ID }, tasks: [] };
      } };
    },
  });

  assert.equal(report.passed, false);
  assert.deepEqual(report.failureCodes, ['CORE_TASK_LINK_CARDINALITY_MISMATCH']);
  assert.equal(report.policy.projectionRequired, true);
});

test('constructs the gate SDK client without writing SDK info logs to stdout', () => {
  const scriptUrl = new URL('../scripts/native-task-conservation-gate.js', import.meta.url).href;
  const stdout = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { createNativeTaskConservationClient } from ${JSON.stringify(scriptUrl)};`
      + 'createNativeTaskConservationClient();process.stdout.write(JSON.stringify({ok:true}));',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FEISHU_APP_ID: APP_ID,
      FEISHU_APP_SECRET: 'test-secret',
    },
  });

  assert.deepEqual(JSON.parse(stdout), { ok: true });
  assert.equal(stdout, '{"ok":true}');
});

test('runs the read-only gate from a Core inventory file using deployment env identity', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-conservation-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryPath = path.join(directory, 'core.json');
  writeFileSync(inventoryPath, JSON.stringify({
    schema: 'zylos.native-task-core-inventory/v1',
    capturedAt: '2026-08-27T03:00:00.000Z',
    snapshot: {
      stable: true,
      strategy: 'double-read-fingerprint',
      fingerprint: 'a'.repeat(64),
    },
    identity: { agentId: AGENT_ID },
    tasks: [],
    externalLinks: [],
  }));
  let captures = 0;

  const report = await runNativeTaskConservationGate({
    args: ['--core-inventory-file', inventoryPath, '--timeout-ms', '5000'],
    env: {
      ZYLOS_AGENT_ID: AGENT_ID,
      FEISHU_APP_ID: APP_ID,
      FEISHU_TASK_V2_AGENT_APP_IDS: JSON.stringify({ [AGENT_ID]: APP_ID }),
      C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: AGENT_ID,
    },
    createReader({ appId }) {
      assert.equal(appId, APP_ID);
      return {
        async capture() {
          captures += 1;
          return { identity: { kind: 'app', appId: APP_ID }, tasks: [] };
        },
      };
    },
  });

  assert.equal(report.passed, true);
  assert.equal(captures, 2);
});

test('runs the gate with an exact derived single-Agent mapping', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-conservation-derived-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryPath = path.join(directory, 'core.json');
  writeFileSync(inventoryPath, JSON.stringify({
    schema: 'zylos.native-task-core-inventory/v1',
    capturedAt: '2026-08-27T03:00:00.000Z',
    snapshot: {
      stable: true,
      strategy: 'double-read-fingerprint',
      fingerprint: 'b'.repeat(64),
    },
    identity: { agentId: AGENT_ID },
    tasks: [],
    externalLinks: [],
  }));

  const report = await runNativeTaskConservationGate({
    args: ['--core-inventory-file', inventoryPath, '--timeout-ms', '5000'],
    env: {
      ZYLOS_AGENT_ID: AGENT_ID,
      FEISHU_APP_ID: APP_ID,
      C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: AGENT_ID,
    },
    createReader() {
      return {
        async capture() {
          return { identity: { kind: 'app', appId: APP_ID }, tasks: [] };
        },
      };
    },
  });

  assert.equal(report.passed, true);
});

test('rejects ambiguous inventory sources and a default assignee identity mismatch', async () => {
  await assert.rejects(
    runNativeTaskConservationGate({
      args: ['--core-inventory-stdin', '--core-inventory-file', 'core.json'],
      env: {},
    }),
    /exactly one Core inventory source/,
  );
  await assert.rejects(
    runNativeTaskConservationGate({
      args: ['--core-inventory-stdin'],
      env: {
        ZYLOS_AGENT_ID: AGENT_ID,
        FEISHU_APP_ID: APP_ID,
        FEISHU_TASK_V2_AGENT_APP_IDS: JSON.stringify({ [AGENT_ID]: APP_ID }),
        C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: 'agent:ss',
      },
      stdin: '{}',
    }),
    /default assignee must equal ZYLOS_AGENT_ID/,
  );
});

test('enforces the CLI timeout even when a remote dependency ignores AbortSignal', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-task-conservation-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventoryPath = path.join(directory, 'core.json');
  writeFileSync(inventoryPath, JSON.stringify({
    schema: 'zylos.native-task-core-inventory/v1',
    capturedAt: '2026-08-27T03:00:00.000Z',
    snapshot: {
      stable: true,
      strategy: 'double-read-fingerprint',
      fingerprint: 'a'.repeat(64),
    },
    identity: { agentId: AGENT_ID },
    tasks: [],
    externalLinks: [],
  }));

  await assert.rejects(
    runNativeTaskConservationGate({
      args: ['--core-inventory-file', inventoryPath, '--timeout-ms', '10'],
      env: {
        ZYLOS_AGENT_ID: AGENT_ID,
        FEISHU_APP_ID: APP_ID,
        FEISHU_TASK_V2_AGENT_APP_IDS: JSON.stringify({ [AGENT_ID]: APP_ID }),
      },
      createReader() {
        return { capture: () => new Promise(() => {}) };
      },
    }),
    error => error.name === 'AbortError',
  );
});
