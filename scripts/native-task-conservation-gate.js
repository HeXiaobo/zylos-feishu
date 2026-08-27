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

const ERROR_SCHEMA = 'zylos.native-task-conservation-gate/error-v1';
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
  const appId = requireText(env.FEISHU_APP_ID, 'FEISHU_APP_ID');
  if (
    env.C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID
    && env.C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID.trim() !== agentId
  ) {
    throw new TypeError('C4 WorkIntake default assignee must equal ZYLOS_AGENT_ID');
  }
  const agentAppIds = parseJson(
    requireText(env.FEISHU_TASK_V2_AGENT_APP_IDS, 'FEISHU_TASK_V2_AGENT_APP_IDS'),
    'FEISHU_TASK_V2_AGENT_APP_IDS',
  );
  if (!agentAppIds || typeof agentAppIds !== 'object' || Array.isArray(agentAppIds)) {
    throw new TypeError('FEISHU_TASK_V2_AGENT_APP_IDS must be a JSON object');
  }
  return { agentId, appId, agentAppIds };
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
} = {}) {
  const parsed = parseArgs(args);
  const deployment = deploymentFromEnv(env);
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
        coreInventory, remote, deployment, signal: controller.signal,
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
