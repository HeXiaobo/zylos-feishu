#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';

import { getCredentials } from '../src/lib/config.js';
import {
  auditNativeTaskConservation,
} from '../src/lib/native-task-conservation-gate.js';
import {
  createSdkNativeTaskConservationReader,
} from '../src/lib/native-task-conservation-remote.js';
import {
  createSdkTaskV2LegacyAdoptionAdapter,
  createTaskV2LegacyAdoptionBootstrap,
  parseTaskV2LegacyAdoptionBootstrapManifest,
} from '../src/lib/task-v2-legacy-adoption-bootstrap.js';

const ERROR_SCHEMA = 'zylos.feishu-task-v2-legacy-adoption-run/error-v1';
const SILENT_SDK_LOGGER = Object.freeze({
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
});

function cliError(message, code = 'INVALID_ARGUMENT', cause) {
  const error = new TypeError(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw cliError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function parseArgs(args) {
  const options = {
    commit: false,
    manifest: null,
    envFile: null,
    gateInventory: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--commit') {
      if (options.commit) throw cliError('duplicate flag: --commit');
      options.commit = true;
      continue;
    }
    if (!['--manifest', '--env-file', '--gate-core-inventory'].includes(argument)) {
      throw cliError(`unknown flag: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw cliError(`${argument} requires a value`);
    }
    const key = argument === '--manifest'
      ? 'manifest'
      : argument === '--env-file' ? 'envFile' : 'gateInventory';
    if (options[key] !== null) throw cliError(`duplicate flag: ${argument}`);
    options[key] = requireText(value, argument);
    index += 1;
  }
  if (options.manifest === null) throw cliError('--manifest is required');
  if (options.gateInventory !== null && !options.commit) {
    throw cliError('--gate-core-inventory requires --commit');
  }
  return options;
}

function readJson(filePath, field) {
  try {
    return JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
  } catch (error) {
    throw cliError(`${field} is not readable JSON`, 'INVALID_MANIFEST', error);
  }
}

function defaultEnvPath(env = process.env) {
  const zylosDir = env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
  return path.join(zylosDir, '.env');
}

export function createBootstrapSdkClient() {
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

function gateDeployment(env, appId) {
  const agentId = requireText(env.ZYLOS_AGENT_ID, 'ZYLOS_AGENT_ID');
  const rawMappings = requireText(
    env.FEISHU_TASK_V2_AGENT_APP_IDS,
    'FEISHU_TASK_V2_AGENT_APP_IDS',
  );
  let agentAppIds;
  try {
    agentAppIds = JSON.parse(rawMappings);
  } catch (error) {
    throw cliError('FEISHU_TASK_V2_AGENT_APP_IDS is not valid JSON', 'GATE_INPUT_INVALID', error);
  }
  if (!agentAppIds || typeof agentAppIds !== 'object' || Array.isArray(agentAppIds)) {
    throw cliError('FEISHU_TASK_V2_AGENT_APP_IDS must be a JSON object', 'GATE_INPUT_INVALID');
  }
  if (agentAppIds[agentId] !== appId) {
    throw cliError('gate Agent/App mapping does not match the bootstrap manifest', 'GATE_INPUT_INVALID');
  }
  return { agentId, appId, agentAppIds };
}

async function runGate({ inventoryPath, client, appId, env }) {
  const coreInventory = readJson(inventoryPath, 'Core inventory');
  const deployment = gateDeployment(env, appId);
  const remote = createSdkNativeTaskConservationReader({ client, appId });
  return auditNativeTaskConservation({ coreInventory, remote, deployment });
}

export async function runTaskV2LegacyAdoptionBootstrapCli({
  args = process.argv.slice(2),
  env = process.env,
  client,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(args);
  const rawManifest = readJson(options.manifest, 'adoption manifest');
  const manifest = parseTaskV2LegacyAdoptionBootstrapManifest(rawManifest);
  if (options.envFile !== null) dotenv.config({ path: path.resolve(options.envFile) });
  else dotenv.config({ path: defaultEnvPath(env) });
  if (!client && process.env.FEISHU_APP_ID !== manifest.appId) {
    throw cliError('FEISHU_APP_ID does not match the bootstrap manifest appId', 'GATE_INPUT_INVALID');
  }
  const sdkClient = client ?? createBootstrapSdkClient();
  const adapter = createSdkTaskV2LegacyAdoptionAdapter({ client: sdkClient });
  const bootstrap = createTaskV2LegacyAdoptionBootstrap({
    adapter,
    appId: manifest.appId,
  });
  const report = options.commit
    ? await bootstrap.commit(manifest, options.gateInventory === null
      ? {}
      : {
        conservationGate: ({ manifest: committedManifest }) => runGate({
          inventoryPath: options.gateInventory,
          client: sdkClient,
          appId: committedManifest.appId,
          env,
        }),
      })
    : await bootstrap.plan(manifest);
  stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

async function main() {
  try {
    const report = await runTaskV2LegacyAdoptionBootstrapCli();
    process.exitCode = report.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      schema: ERROR_SCHEMA,
      passed: false,
      failureCodes: [error?.code ?? 'BOOTSTRAP_RUNTIME_ERROR'],
      error: {
        name: error?.name ?? 'Error',
        message: String(error?.message ?? error),
      },
    })}\n`);
    process.exitCode = error?.code === 'INVALID_MANIFEST' || error?.code === 'INVALID_ARGUMENT'
      ? 2
      : 1;
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
