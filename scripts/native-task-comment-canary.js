#!/usr/bin/env node

import {
  closeSync,
  fchmodSync,
  ftruncateSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

import {
  createNativeTaskCanarySender,
  NATIVE_TASK_CANARY_SENDER_SCHEMA,
} from '../src/lib/native-task-canary-sender.js';

const ERROR_SCHEMA = 'zylos.native-task-comment-sender/error-v1';
const MAX_EVIDENCE_LENGTH = 20_000;

function requireText(value, field, maxLength = 4_096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !['--task-id', '--content', '--output', '--as', '--app-id', '--lark-cli'].includes(name)
      || value === undefined
    ) {
      throw new TypeError(
        'usage: native-task-comment-canary.js --task-id <guid> --content <text>'
          + ' [--output <json>] [--as user] [--app-id <app-id>] [--lark-cli <path>]',
      );
    }
    if (values.has(name)) throw new TypeError(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const name of ['--task-id', '--content']) {
    if (!values.has(name)) throw new TypeError(`native Task canary requires ${name}`);
  }
  return values;
}

function parseJsonOutput(text) {
  const output = String(text ?? '').trim();
  if (!output) throw new TypeError('lark-cli returned empty output');
  try {
    return JSON.parse(output);
  } catch {
    for (let index = output.indexOf('{'); index >= 0; index = output.indexOf('{', index + 1)) {
      try {
        return JSON.parse(output.slice(index));
      } catch {
        // A notifier or diagnostic prefix may contain braces; keep scanning.
      }
    }
  }
  throw new TypeError('lark-cli returned output that is not JSON');
}

function boundedText(value) {
  const text = String(value ?? '');
  return text.length <= MAX_EVIDENCE_LENGTH
    ? text
    : `${text.slice(0, MAX_EVIDENCE_LENGTH)}\n[truncated]`;
}

function attachResponse(error, response) {
  error.responseEvidence = response;
  return error;
}

function commandFailure(error, args, { stdout = '', stderr = '' } = {}) {
  const boundedStdout = boundedText(stdout || error?.stdout);
  const boundedStderr = boundedText(stderr || error?.stderr);
  let response = null;
  for (const candidate of [boundedStdout, boundedStderr]) {
    if (!candidate) continue;
    try {
      response = parseJsonOutput(candidate);
      break;
    } catch {
      // Keep the raw streams below when the command did not emit JSON.
    }
  }
  const wrapped = new Error(
    `lark-cli ${args.join(' ')} failed${error?.status === undefined ? '' : ` with exit ${error.status}`}`,
  );
  wrapped.uncertain = false;
  wrapped.commandEvidence = { stdout: boundedStdout, stderr: boundedStderr, response };
  wrapped.cause = error;
  throw wrapped;
}

function executeLarkCli(executable, args) {
  let output;
  try {
    output = execFileSync(executable, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1_000_000,
    });
  } catch (error) {
    commandFailure(error, args);
  }
  try {
    return parseJsonOutput(output);
  } catch (error) {
    commandFailure(error, args, { stdout: output });
  }
}

function validateDryRunResponse(payload, { taskGuid, content, expectedAppId }) {
  const root = requireRecord(payload, 'lark-cli dry-run response');
  if (root.ok !== true) throw attachResponse(
    new TypeError('lark-cli dry-run response.ok must be true'),
    payload,
  );
  if (root.identity !== 'user') throw attachResponse(
    new TypeError('lark-cli dry-run response.identity must be user'),
    payload,
  );
  if (root.dry_run !== true) throw attachResponse(
    new TypeError('lark-cli dry-run response.dry_run must be true'),
    payload,
  );
  const data = requireRecord(root.data, 'lark-cli dry-run response.data');
  const context = requireRecord(data.context, 'lark-cli dry-run response.data.context');
  const appId = requireText(context.app_id, 'lark-cli dry-run response.data.context.app_id');
  const userOpenId = requireText(
    context.user_open_id,
    'lark-cli dry-run response.data.context.user_open_id',
  );
  if (expectedAppId !== undefined && appId !== expectedAppId) {
    throw attachResponse(
      new TypeError('lark-cli dry-run context.app_id does not match the expected App'),
      payload,
    );
  }
  if (!Array.isArray(data.api) || data.api.length !== 1) throw attachResponse(
    new TypeError('lark-cli dry-run response.data.api must contain one request'),
    payload,
  );
  const request = requireRecord(data.api[0], 'lark-cli dry-run response.data.api[0]');
  if (request.method !== 'POST' || request.url !== '/open-apis/task/v2/comments') {
    throw attachResponse(
      new TypeError('lark-cli dry-run request is not Task v2 comment create'),
      payload,
    );
  }
  const body = requireRecord(request.body, 'lark-cli dry-run request.body');
  if (body.resource_type !== 'task') throw attachResponse(
    new TypeError('lark-cli dry-run request resource_type must be task'),
    payload,
  );
  if (body.resource_id !== taskGuid) throw attachResponse(
    new TypeError('lark-cli dry-run request resource_id does not match --task-id'),
    payload,
  );
  if (body.content !== content) throw attachResponse(
    new TypeError('lark-cli dry-run request content does not match --content'),
    payload,
  );
  return {
    ok: true,
    identity: 'user',
    context: { appId, userOpenId },
    request: {
      method: 'POST',
      url: '/open-apis/task/v2/comments',
      resourceType: 'task',
      taskGuid,
    },
  };
}

function validateSendResponse(payload) {
  const root = requireRecord(payload, 'lark-cli send response');
  if (root.ok !== true) throw attachResponse(
    new TypeError('lark-cli send response.ok must be true'),
    payload,
  );
  if (root.identity !== 'user') throw attachResponse(
    new TypeError('lark-cli send response.identity must be user'),
    payload,
  );
  const data = requireRecord(root.data, 'lark-cli send response.data');
  const commentId = requireText(data.id, 'lark-cli send response.data.id');
  return {
    ok: true,
    identity: 'user',
    data: { id: commentId },
  };
}

function reserveOutput(filePath) {
  const resolved = path.resolve(requireText(filePath, '--output'));
  const fd = openSync(resolved, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    return { fd, path: resolved };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function writeReservedJson(reservation, value) {
  ftruncateSync(reservation.fd, 0);
  writeFileSync(reservation.fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fchmodSync(reservation.fd, 0o600);
}

function closeReservation(reservation) {
  if (reservation) closeSync(reservation.fd);
}

function errorArtifact({ error, context }) {
  return {
    schema: ERROR_SCHEMA,
    passed: false,
    uncertain: Boolean(context.stage === 'send' || error?.uncertain),
    stage: context.stage,
    hostname: context.hostname,
    taskGuid: context.taskGuid,
    ...(context.appId ? { appId: context.appId } : {}),
    ...(context.dryRun ? { dryRun: context.dryRun } : {}),
    ...(context.sendResponse ? { sendResponse: context.sendResponse } : {}),
    error: {
      message: String(error?.message ?? error ?? 'unknown canary sender error'),
      ...(error?.responseEvidence === undefined
        ? {}
        : { response: error.responseEvidence }),
      ...(error?.commandEvidence === undefined
        ? {}
        : { command: error.commandEvidence }),
    },
  };
}

async function main(args = process.argv.slice(2)) {
  const values = parseArgs(args);
  dotenv.config({ path: path.join(os.homedir(), 'zylos/.env') });
  const taskGuid = requireText(values.get('--task-id'), '--task-id');
  const content = requireText(values.get('--content'), '--content', 20_000);
  const identity = values.get('--as') ?? 'user';
  if (identity !== 'user') throw new TypeError('--as must be user');
  const executable = values.get('--lark-cli') ?? 'lark-cli';
  const expectedAppId = values.get('--app-id') ?? process.env.FEISHU_APP_ID;
  if (expectedAppId !== undefined) requireText(expectedAppId, '--app-id or FEISHU_APP_ID');
  const hostname = os.hostname();
  const context = {
    stage: 'reserve-output',
    hostname,
    taskGuid,
    appId: null,
    dryRun: null,
    sendResponse: null,
  };
  let reservation = null;
  try {
    const outputPath = values.get('--output');
    if (outputPath !== undefined) reservation = reserveOutput(outputPath);

    const commonArgs = [
      'task', '+comment', '--as', 'user',
      '--task-id', taskGuid, '--content', content,
    ];
    const dryRunPayload = executeLarkCli(executable, [...commonArgs, '--dry-run', '--json']);
    const dryRun = validateDryRunResponse(dryRunPayload, {
      taskGuid,
      content,
      expectedAppId,
    });
    context.stage = 'send';
    context.appId = dryRun.context.appId;
    context.dryRun = dryRun;
    const sender = createNativeTaskCanarySender({
      appId: dryRun.context.appId,
      hostname,
      dryRun: async () => dryRun,
      sendComment: async () => {
        const sendPayload = executeLarkCli(executable, [...commonArgs, '--json']);
        context.sendResponse = sendPayload;
        return validateSendResponse(sendPayload);
      },
    });
    const receipt = await sender.send({ taskGuid, content });
    if (reservation) writeReservedJson(reservation, receipt);
    process.stdout.write(`${JSON.stringify({
      schema: NATIVE_TASK_CANARY_SENDER_SCHEMA,
      receipt,
      ...(reservation ? { outputPath: reservation.path } : {}),
    })}\n`);
    return receipt;
  } catch (error) {
    const artifact = errorArtifact({ error, context });
    if (reservation) {
      try {
        writeReservedJson(reservation, artifact);
      } catch (writeError) {
        artifact.error.outputWrite = String(writeError?.message ?? writeError);
      }
    }
    process.stderr.write(`${JSON.stringify(artifact)}\n`);
    process.exitCode = 2;
    return null;
  } finally {
    closeReservation(reservation);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    schema: ERROR_SCHEMA,
    passed: false,
    uncertain: false,
    stage: 'input',
    error: { message: String(error?.message ?? error ?? 'unknown canary sender error') },
  })}\n`);
  process.exitCode = 2;
});
