#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

import { getClient } from '../src/lib/client.js';
import { evaluateNativeTaskClosure } from '../src/lib/native-task-closure-gate.js';
import {
  createFixtureNativeTaskGateReader,
  createSdkNativeTaskGateReader,
} from '../src/lib/native-task-closure-gate-remote.js';

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--input', '--remote-fixture'].includes(name) || value === undefined) {
      throw new TypeError(
        'usage: native-task-closure-gate.js --input <json> [--remote-fixture <json>]',
      );
    }
    if (values.has(name)) throw new TypeError(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  if (!values.has('--input')) {
    throw new TypeError('native Task closure gate requires --input <json>');
  }
  return values;
}

function readJson(filePath, field) {
  const resolved = path.resolve(filePath);
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new TypeError(`${field} is not readable JSON: ${error.message}`);
  }
}

async function main(args = process.argv.slice(2)) {
  const values = parseArgs(args);
  const input = readJson(values.get('--input'), 'gate input');
  let remoteReader;
  if (values.has('--remote-fixture')) {
    remoteReader = createFixtureNativeTaskGateReader(
      readJson(values.get('--remote-fixture'), 'remote fixture'),
    );
  } else {
    dotenv.config({ path: path.join(process.env.HOME || os.homedir(), 'zylos/.env') });
    remoteReader = createSdkNativeTaskGateReader({ client: getClient() });
  }
  const report = await evaluateNativeTaskClosure({ ...input, remoteReader });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    schema: 'zylos.native-task-closure-gate/error-v1',
    passed: false,
    failureCodes: ['GATE_INPUT_OR_RUNTIME_ERROR'],
    error: { message: String(error?.message ?? error ?? 'unknown gate error') },
  })}\n`);
  process.exitCode = 2;
});
