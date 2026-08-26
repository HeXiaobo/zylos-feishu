#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

import { getClient } from '../src/lib/client.js';
import { evaluateNativeTaskCompletionClosure } from '../src/lib/native-task-completion-gate.js';
import { createSdkNativeTaskGateReader } from '../src/lib/native-task-closure-gate-remote.js';

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--input') {
    throw new TypeError('usage: native-task-completion-gate.js --input <json>');
  }
  return args[1];
}

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new TypeError(`gate input is not readable JSON: ${error.message}`);
  }
}

async function main(args = process.argv.slice(2)) {
  const input = readJson(parseArgs(args));
  dotenv.config({ path: path.join(process.env.HOME || os.homedir(), 'zylos/.env') });
  const report = await evaluateNativeTaskCompletionClosure({
    ...input,
    remoteReader: createSdkNativeTaskGateReader({ client: getClient() }),
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    schema: 'zylos.native-task-completion-gate/error-v1',
    passed: false,
    failureCodes: ['GATE_INPUT_OR_RUNTIME_ERROR'],
    error: { message: String(error?.message ?? error ?? 'unknown gate error') },
  })}\n`);
  process.exitCode = 2;
});
