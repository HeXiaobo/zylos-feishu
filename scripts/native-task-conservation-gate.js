#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';

import { getCredentials } from '../src/lib/config.js';
import { auditNativeTaskConservation } from '../src/lib/native-task-conservation-gate.js';
import { createSdkNativeTaskConservationReader } from '../src/lib/native-task-conservation-remote.js';
import { resolveTaskV2DeploymentIdentity } from '../src/lib/task-v2-deployment-identity.js';

const ERROR_SCHEMA = 'zylos.native-task-conservation-gate/error-v1';
const TASK_V2_FLAG = 'COMMITMENT_FEISHU_TASK_V2_ENABLED';
const PROJECTION_POLICY_SCHEMA = 'zylos.native-task-conservation-policy/v1';
const SILENT_SDK_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
});

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parsePositiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function parseArgs(args) {
  const parsed = {
    commandArgs: [],
    timeoutMs: 60_000,
    stdin: false,
    file: null,
    command: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--core-inventory-stdin') {
      parsed.stdin = true;
      continue;
    }
    if (
      arg === '--core-inventory-file'
      || arg === '--core-inventory-command'
      || arg === '--core-inventory-arg'
      || arg === '--timeout-ms'
    ) {
      const value = args[index + 1];
      if (value === undefined) throw new TypeError(`${arg} requires a value`);
      index += 1;
      if (arg === '--core-inventory-file') parsed.file = value;
      else if (arg === '--core-inventory-command') parsed.command = value;
      else if (arg === '--core-inventory-arg') parsed.commandArgs.push(value);
      else parsed.timeoutMs = parsePositiveInteger(value, '--timeout-ms');
      continue;
    }
    throw new TypeError(`unknown option: ${arg}`);
  }
  const sourceCount = Number(parsed.stdin) + Number(parsed.file !== null) + Number(parsed.command !== null);
  if (sourceCount !== 1) throw new TypeError('exactly one Core inventory source is required');
  if (parsed.command === null && parsed.commandArgs.length > 0) {
    throw new TypeError('--core-inventory-arg requires --core-inventory-command');
  }
  return parsed;
}

function parseJson(value, field) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new TypeError(`${field} is not valid JSON: ${error.message}`);
  }
}

function readCoreInventory(parsed, stdin) {
  if (parsed.stdin) {
    return parseJson(stdin ?? readFileSync(0, 'utf8'), 'Core inventory stdin');
  }
  if (parsed.file !== null) {
    return parseJson(readFileSync(path.resolve(parsed.file), 'utf8'), 'Core inventory file');
  }
  const stdout = execFileSync(requireText(parsed.command, '--core-inventory-command'), parsed.commandArgs, {
    encoding: 'utf8',
    timeout: parsed.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parseJson(stdout, 'Core inventory command output');
}

function deploymentFromEnv(env) {
  const agentId = requireText(env.ZYLOS_AGENT_ID, 'ZYLOS_AGENT_ID');
  if (
    env.C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID
    && env.C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID.trim() !== agentId
  ) {
    throw new TypeError('C4 WorkIntake default assignee must equal ZYLOS_AGENT_ID');
  }
  return resolveTaskV2DeploymentIdentity({
    agentId,
    appId: env.FEISHU_APP_ID,
    rawAgentAppIds: env.FEISHU_TASK_V2_AGENT_APP_IDS,
  });
}

function strictProjectionPolicy(reasonCode) {
  return {
    schema: PROJECTION_POLICY_SCHEMA,
    projectionRequired: true,
    taskV2Enabled: null,
    verified: false,
    source: 'runtime-probe',
    reasonCode,
  };
}

function parseTaskV2Flag(value, field) {
  if (value === undefined) return { present: false, enabled: null };
  if (typeof value !== 'string') return { present: true, invalid: true };
  const normalized = value.trim();
  if (normalized === '1') return { present: true, enabled: true };
  if (normalized === '0') return { present: true, enabled: false };
  return { present: true, invalid: true, field };
}

function runtimePaths(env = process.env) {
  const zylosDir = path.resolve(env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos'));
  const feishuDir = path.join(zylosDir, '.claude', 'skills', 'feishu');
  return {
    zylosDir,
    feishuDir,
    managedScriptPath: path.join(feishuDir, 'src', 'index.js'),
    envPath: path.join(zylosDir, '.env'),
  };
}

/** Read only the runtime flag from the target .env; never return credentials. */
export function readNativeTaskConservationRuntimeEnv({
  env = process.env,
  readFile = readFileSync,
} = {}) {
  const paths = runtimePaths(env);
  try {
    const parsed = dotenv.parse(readFile(paths.envPath, 'utf8'));
    return Object.freeze({
      path: paths.envPath,
      present: true,
      flag: parseTaskV2Flag(parsed[TASK_V2_FLAG], TASK_V2_FLAG),
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return Object.freeze({
        path: paths.envPath,
        present: false,
        flag: { present: false, enabled: null },
      });
    }
    return Object.freeze({
      path: paths.envPath,
      present: null,
      flag: { present: false, enabled: null },
      errorCode: 'RUNTIME_ENV_UNREADABLE',
    });
  }
}

function sanitizePm2Process(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false };
  }
  const pm2Env = value.pm2_env;
  if (!pm2Env || typeof pm2Env !== 'object' || Array.isArray(pm2Env)) {
    return { valid: false };
  }
  const processEnv = pm2Env.env;
  const hasProcessEnvFlag = processEnv
    && typeof processEnv === 'object'
    && !Array.isArray(processEnv)
    && Object.prototype.hasOwnProperty.call(processEnv, TASK_V2_FLAG);
  const hasTopLevelFlag = Object.prototype.hasOwnProperty.call(pm2Env, TASK_V2_FLAG);
  return {
    valid: true,
    name: typeof value.name === 'string' ? value.name : null,
    status: typeof pm2Env.status === 'string' ? pm2Env.status : null,
    cwd: typeof pm2Env.pm_cwd === 'string' ? pm2Env.pm_cwd : null,
    script: typeof pm2Env.pm_exec_path === 'string' ? pm2Env.pm_exec_path : null,
    envFlag: hasProcessEnvFlag
      ? parseTaskV2Flag(processEnv[TASK_V2_FLAG], `pm2.${TASK_V2_FLAG}`)
      : { present: false, enabled: null },
    pm2Flag: hasTopLevelFlag
      ? parseTaskV2Flag(pm2Env[TASK_V2_FLAG], `pm2_env.${TASK_V2_FLAG}`)
      : { present: false, enabled: null },
  };
}

/** Query PM2 without exposing its full process environment or command output. */
export function readNativeTaskConservationPm2Processes({
  execFile = execFileSync,
} = {}) {
  let stdout;
  try {
    stdout = execFile('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return Object.freeze({ ok: false, reasonCode: 'PM2_INVENTORY_UNAVAILABLE', processes: [] });
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return Object.freeze({ ok: false, reasonCode: 'PM2_INVENTORY_INVALID', processes: [] });
  }
  if (!Array.isArray(parsed)) {
    return Object.freeze({ ok: false, reasonCode: 'PM2_INVENTORY_INVALID', processes: [] });
  }
  return Object.freeze({
    ok: true,
    reasonCode: null,
    processes: Object.freeze(parsed.map(sanitizePm2Process)),
  });
}

function comparablePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function managedProcessMatches(processInfo, paths) {
  if (!processInfo?.valid || processInfo.status !== 'online') return false;
  const cwd = comparablePath(processInfo.cwd);
  const expectedCwd = comparablePath(paths.feishuDir);
  if (cwd === null || expectedCwd === null || cwd !== expectedCwd) return false;
  const script = typeof processInfo.script === 'string' && processInfo.script.trim() !== ''
    ? path.resolve(processInfo.cwd, processInfo.script)
    : null;
  const expectedScript = comparablePath(paths.managedScriptPath);
  return script !== null && expectedScript !== null && comparablePath(script) === expectedScript;
}

function pm2FlagForProcess(processInfo) {
  const envFlag = processInfo?.envFlag ?? processInfo?.flag ?? { present: false, enabled: null };
  const topLevelFlag = processInfo?.pm2Flag ?? { present: false, enabled: null };
  if (
    !envFlag
    || typeof envFlag !== 'object'
    || !topLevelFlag
    || typeof topLevelFlag !== 'object'
  ) {
    return { invalid: true };
  }
  if (envFlag.invalid || topLevelFlag.invalid) return { invalid: true };
  if (envFlag.present && topLevelFlag.present) {
    if (envFlag.enabled !== topLevelFlag.enabled) return { conflict: true };
    return { present: true, enabled: envFlag.enabled };
  }
  if (envFlag.present) return envFlag;
  if (topLevelFlag.present) return topLevelFlag;
  return { present: false, enabled: null };
}

function runtimeFlagForProcess(processInfo, targetEnv) {
  const pm2Flag = pm2FlagForProcess(processInfo);
  if (pm2Flag.invalid) return { ok: false, reasonCode: 'TASK_V2_FLAG_INVALID' };
  if (pm2Flag.conflict) return { ok: false, reasonCode: 'TASK_V2_PM2_FLAG_CONFLICT' };
  const fileFlag = targetEnv.flag && typeof targetEnv.flag === 'object'
    ? targetEnv.flag
    : { present: false, enabled: null, invalid: true };
  if (
    fileFlag.invalid
    || (fileFlag.present && typeof fileFlag.enabled !== 'boolean')
  ) {
    return { ok: false, reasonCode: 'TASK_V2_FLAG_INVALID' };
  }
  if (pm2Flag.present) {
    return {
      ok: true,
      present: true,
      enabled: pm2Flag.enabled,
      source: 'pm2-environment',
    };
  }
  if (fileFlag.present) {
    return {
      ok: true,
      present: true,
      enabled: fileFlag.enabled,
      source: 'runtime-dotenv',
    };
  }
  if (targetEnv.present === true) {
    return {
      ok: true,
      present: true,
      enabled: false,
      source: 'runtime-default',
    };
  }
  return { ok: false, reasonCode: 'RUNTIME_ENV_MISSING' };
}

/**
 * Resolve the actual Task v2 projection policy for the runtime being checked.
 * The caller's flag is deliberately ignored. PM2's process environment wins
 * over the target dotenv file, matching the service's effective environment.
 */
export function resolveNativeTaskConservationPolicy({
  env = process.env,
  runtimeEnv = null,
  pm2 = null,
  readRuntimeEnv = readNativeTaskConservationRuntimeEnv,
  readPm2Processes = readNativeTaskConservationPm2Processes,
} = {}) {
  const paths = runtimePaths(env);
  const targetEnv = runtimeEnv ?? readRuntimeEnv({ env });
  if (!targetEnv || targetEnv.present === null || targetEnv.errorCode) {
    return strictProjectionPolicy('RUNTIME_ENV_UNREADABLE');
  }
  const processInventory = pm2 ?? readPm2Processes();
  if (!processInventory?.ok) {
    return strictProjectionPolicy(processInventory?.reasonCode || 'PM2_INVENTORY_UNAVAILABLE');
  }
  if (!Array.isArray(processInventory.processes)) {
    return strictProjectionPolicy('PM2_INVENTORY_INVALID');
  }
  const managedProcesses = processInventory.processes.filter(processInfo => (
    managedProcessMatches(processInfo, paths)
  ));
  if (managedProcesses.length === 0) {
    return strictProjectionPolicy('NO_ONLINE_MANAGED_FEISHU_PROCESS');
  }
  if (managedProcesses.length !== 1) {
    return strictProjectionPolicy('MULTIPLE_ONLINE_MANAGED_FEISHU_PROCESSES');
  }

  const effectiveFlag = runtimeFlagForProcess(managedProcesses[0], targetEnv);
  if (!effectiveFlag.ok) return strictProjectionPolicy(effectiveFlag.reasonCode);

  const workerScriptPath = path.join(paths.feishuDir, 'src', 'lib', 'task-v2-projection-worker.js');
  const workerProcesses = processInventory.processes.filter(processInfo => (
    managedProcessMatches(processInfo, { ...paths, managedScriptPath: workerScriptPath })
  ));
  if (workerProcesses.length > 1) {
    return strictProjectionPolicy('MULTIPLE_ONLINE_MANAGED_TASK_V2_WORKERS');
  }
  if (workerProcesses.length === 1) {
    const workerFlag = runtimeFlagForProcess(workerProcesses[0], targetEnv);
    if (!workerFlag.ok) return strictProjectionPolicy(workerFlag.reasonCode);
    if (workerFlag.enabled && !effectiveFlag.enabled) {
      return strictProjectionPolicy('TASK_V2_WORKER_MAIN_FLAG_CONFLICT');
    }
  }

  if (effectiveFlag.present) {
    return {
      schema: PROJECTION_POLICY_SCHEMA,
      projectionRequired: effectiveFlag.enabled,
      taskV2Enabled: effectiveFlag.enabled,
      verified: true,
      source: effectiveFlag.source,
      reasonCode: effectiveFlag.enabled
        ? 'TASK_V2_RUNTIME_ENABLED'
        : effectiveFlag.source === 'runtime-default'
          ? 'TASK_V2_RUNTIME_DEFAULT_DISABLED'
          : 'TASK_V2_RUNTIME_DISABLED',
    };
  }
  return strictProjectionPolicy('RUNTIME_ENV_MISSING');
}

/** Construct a gate-only SDK client without polluting the JSON stdout contract. */
export function createNativeTaskConservationClient() {
  const credentials = getCredentials();
  const appId = requireText(credentials.app_id, 'FEISHU_APP_ID');
  const appSecret = requireText(credentials.app_secret, 'FEISHU_APP_SECRET');
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    logger: SILENT_SDK_LOGGER,
  });
}

export async function runNativeTaskConservationGate({
  args = process.argv.slice(2),
  env = process.env,
  stdin,
  client,
  createReader = createSdkNativeTaskConservationReader,
  projectionPolicy,
  readRuntimeEnv = readNativeTaskConservationRuntimeEnv,
  readPm2Processes = readNativeTaskConservationPm2Processes,
} = {}) {
  const parsed = parseArgs(args);
  const deployment = deploymentFromEnv(env);
  const resolvedProjectionPolicy = projectionPolicy ?? resolveNativeTaskConservationPolicy({
    env,
    readRuntimeEnv,
    readPm2Processes,
  });
  const coreInventory = readCoreInventory(parsed, stdin);
  const controller = new AbortController();
  const sdkClient = client ?? (
    createReader === createSdkNativeTaskConservationReader
      ? createNativeTaskConservationClient()
      : undefined
  );
  const remote = createReader({
    client: sdkClient,
    appId: deployment.appId,
  });
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error('native Task conservation gate timed out');
      error.name = 'AbortError';
      controller.abort(error);
      reject(error);
    }, parsed.timeoutMs);
  });
  try {
    return await Promise.race([
      auditNativeTaskConservation({
        coreInventory,
        remote,
        deployment,
        projectionPolicy: resolvedProjectionPolicy,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function resolveNativeTaskConservationEnvPath(env = process.env) {
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  return path.join(zylosDir, '.env');
}

async function main() {
  dotenv.config({ path: resolveNativeTaskConservationEnvPath() });
  try {
    const report = await runNativeTaskConservationGate();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: ERROR_SCHEMA,
      passed: false,
      failureCodes: ['GATE_INPUT_OR_RUNTIME_ERROR'],
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) },
    })}\n`);
    process.exitCode = 2;
  }
}

function sameFile(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

const isMain = process.argv[1]
  && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) await main();
