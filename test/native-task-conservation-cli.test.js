import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveNativeTaskConservationEnvPath,
  runNativeTaskConservationGate,
} from '../scripts/native-task-conservation-gate.js';

const APP_ID = 'cli_a9f4963828b89bdf';
const AGENT_ID = 'agent:yueran';

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
