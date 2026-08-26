#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import dotenv from 'dotenv';

import { getClient } from './client.js';
import { createTaskV2MemberMapper } from './task-v2-member-mapper.js';
import {
  createTaskV2Projection,
  TASK_V2_LINK_BACKEND,
  TASK_V2_PROJECTION,
} from './task-v2-projection.js';
import { collectTaskV2ReconciliationSnapshot } from './task-v2-reconciliation-snapshot.js';
import { createSdkTaskV2Gateway } from './task-v2-sdk-adapter.js';
import {
  createTaskV2StatusInbox,
  processTaskV2StatusInboxOnce,
} from './task-v2-status-inbox.js';
import { createTaskV2StatusEventHandler } from './task-v2-status-event.js';
import { isTaskV2Enabled } from './task-v2-runtime-policy.js';

const REGISTRATION_ACTOR = 'commitment-feishu-task-v2-projection';
const DEFAULTS = Object.freeze({
  limit: 25,
  leaseMs: 30_000,
  retryAfterMs: 5_000,
  maxAttempts: 5,
  intervalMs: 2_000,
});

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function envInteger(value, fallback, field) {
  if (value === undefined || value === '') return fallback;
  return requirePositiveInteger(Number(value), field);
}

function parseAgentAppIds(rawValue) {
  if (rawValue === undefined || rawValue === '') return {};
  let parsed;
  try { parsed = JSON.parse(rawValue); } catch { throw new TypeError('FEISHU_TASK_V2_AGENT_APP_IDS must be JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('FEISHU_TASK_V2_AGENT_APP_IDS must be a JSON object');
  }
  return parsed;
}

function sleep(intervalMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, intervalMs);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export async function loadCommitmentProjectionDependencies({
  env = process.env,
  importModule = specifier => import(specifier),
} = {}) {
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  const scripts = path.join(zylosDir, '.claude/skills/commitment-core/scripts');
  const [
    coreModule,
    workerModule,
    reconciliationModule,
    externalTaskModule,
  ] = await Promise.all([
    importModule(pathToFileURL(path.join(scripts, 'core.js')).href),
    importModule(pathToFileURL(path.join(scripts, 'projection-worker.js')).href),
    importModule(pathToFileURL(path.join(scripts, 'reconcile-projection.js')).href),
    importModule(pathToFileURL(path.join(scripts, 'external-task-adapter.js')).href),
  ]);
  if (typeof coreModule.openCommitmentCore !== 'function') {
    throw new TypeError('installed Commitment Core has no openCommitmentCore');
  }
  if (typeof workerModule.processProjectionBatch !== 'function') {
    throw new TypeError('installed Commitment Core has no processProjectionBatch');
  }
  if (typeof reconciliationModule.reconcileProjection !== 'function') {
    throw new TypeError('installed Commitment Core has no reconcileProjection');
  }
  if (typeof externalTaskModule.mapExternalTaskEvent !== 'function') {
    throw new TypeError('installed Commitment Core has no mapExternalTaskEvent');
  }
  return Object.freeze({
    openCore: coreModule.openCommitmentCore,
    processBatch: workerModule.processProjectionBatch,
    reconcile: reconciliationModule.reconcileProjection,
    mapExternalTaskEvent: externalTaskModule.mapExternalTaskEvent,
  });
}

export function createTaskV2ProjectionRuntime({ env = process.env, client, statusInbox } = {}) {
  const appId = requireText(env.FEISHU_APP_ID, 'FEISHU_APP_ID');
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  return Object.freeze({
    appId,
    gateway: createSdkTaskV2Gateway({ client: client ?? getClient() }),
    memberMapper: createTaskV2MemberMapper({
      appId,
      agentId: env.ZYLOS_AGENT_ID?.trim() || null,
      agentAppIds: parseAgentAppIds(env.FEISHU_TASK_V2_AGENT_APP_IDS),
      requireGatewayAppAssignee: true,
    }),
    statusInbox: statusInbox ?? createTaskV2StatusInbox({
      directory: path.join(zylosDir, 'components/feishu/task-v2-status-inbox'),
    }),
  });
}

export function initializeTaskV2Projection({ bootstrapPolicy, openCore } = {}) {
  if (bootstrapPolicy !== 'from_now' && bootstrapPolicy !== 'from_beginning') {
    throw new TypeError('bootstrapPolicy must be from_now or from_beginning');
  }
  if (typeof openCore !== 'function') throw new TypeError('openCore must be a function');
  const core = openCore();
  try {
    return core.outbox.register({
      projection: TASK_V2_PROJECTION,
      bootstrapPolicy,
      actorId: REGISTRATION_ACTOR,
      idempotencyKey: `${REGISTRATION_ACTOR}:register:${bootstrapPolicy}:v1`,
    });
  } finally {
    core.close();
  }
}

export async function runTaskV2ProjectionOnce({
  workerId,
  limit = DEFAULTS.limit,
  leaseMs = DEFAULTS.leaseMs,
  retryAfterMs = DEFAULTS.retryAfterMs,
  maxAttempts = DEFAULTS.maxAttempts,
  operationId = randomUUID(),
  gateway,
  memberMapper,
  appId,
  statusInbox,
  openCore,
  processBatch,
  mapExternalTaskEvent,
} = {}) {
  requireText(workerId, 'workerId');
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(leaseMs, 'leaseMs');
  requirePositiveInteger(retryAfterMs, 'retryAfterMs');
  requirePositiveInteger(maxAttempts, 'maxAttempts');
  if (typeof openCore !== 'function') throw new TypeError('openCore must be a function');
  if (typeof processBatch !== 'function') throw new TypeError('processBatch must be a function');
  const core = openCore();
  try {
    const receipts = [];
    const projection = createTaskV2Projection({ core, gateway, memberMapper });
    const summary = await processBatch({
      core,
      projection: TASK_V2_PROJECTION,
      workerId,
      limit,
      leaseMs,
      retryAfterMs,
      maxAttempts,
      operationId,
      adapter: {
        async publishDelivery({ delivery }) {
          const [receipt] = await projection.publishBatch({ deliveries: [delivery] });
          receipts.push(receipt);
          return receipt;
        },
      },
    });
    const statusInboxSummary = statusInbox === undefined
      ? null
      : await processTaskV2StatusInboxOnce({
        inbox: statusInbox,
        handler: createTaskV2StatusEventHandler({
          core,
          gateway,
          appId,
          mapExternalTaskEvent,
        }),
        limit,
        retryAfterMs,
        maxAttempts,
      });
    return Object.freeze({
      ...summary,
      receipts: Object.freeze(receipts),
      ...(statusInboxSummary === null ? {} : { statusInbox: statusInboxSummary }),
    });
  } finally {
    core.close();
  }
}

export async function runTaskV2Reconciliation({
  openCore,
  reconcile,
  gateway,
  tasks,
  repairStatus = false,
  appId,
  mapExternalTaskEvent,
} = {}) {
  if (typeof openCore !== 'function') throw new TypeError('openCore must be a function');
  if (typeof reconcile !== 'function') throw new TypeError('reconcile must be a function');
  if (typeof repairStatus !== 'boolean') throw new TypeError('repairStatus must be a boolean');
  const core = openCore();
  try {
    const snapshot = await collectTaskV2ReconciliationSnapshot({ core, gateway, tasks });
    const repairs = [];
    if (repairStatus) {
      const handler = createTaskV2StatusEventHandler({
        core,
        gateway,
        appId,
        mapExternalTaskEvent,
      });
      for (const candidate of snapshot.statusRepairCandidates) {
        repairs.push(await handler.handle({
          event_id: `reconcile:${candidate.taskGuid}:${candidate.completedAt}`,
          task_id: candidate.taskGuid,
          app_id: appId,
        }));
      }
    }
    return Object.freeze({
      ...reconcile({ expected: snapshot.expected, actual: snapshot.actual }),
      missingLinks: snapshot.missingLinks,
      linkMismatches: snapshot.linkMismatches,
      repairs: Object.freeze(repairs),
    });
  } finally {
    core.close();
  }
}

export async function resolveTaskV2Url({ taskId, openCore, gateway } = {}) {
  const normalizedTaskId = requireText(taskId, 'taskId');
  if (typeof openCore !== 'function') throw new TypeError('openCore must be a function');
  if (!gateway || typeof gateway.getTask !== 'function') {
    throw new TypeError('gateway.getTask must be a function');
  }
  const core = openCore();
  try {
    if (!core.query({ taskId: normalizedTaskId })) {
      throw new TypeError(`Core task not found: ${normalizedTaskId}`);
    }
    const links = core.externalLinks.query({
      taskId: normalizedTaskId,
      backend: TASK_V2_LINK_BACKEND,
    });
    if (!Array.isArray(links)) throw new TypeError('Core ExternalLink query must return an array');
    if (links.length === 0) {
      return Object.freeze({
        status: 'unlinked', taskId: normalizedTaskId, taskGuid: null, url: null,
      });
    }
    if (links.length > 1) throw new TypeError(`multiple Task v2 links found for ${normalizedTaskId}`);
    const taskGuid = requireText(links[0].externalId, 'Task v2 ExternalLink externalId');
    const remoteTask = await gateway.getTask(taskGuid);
    return Object.freeze({
      status: 'linked',
      taskId: normalizedTaskId,
      taskGuid,
      url: requireText(remoteTask?.url, 'Task v2 URL'),
    });
  } finally {
    core.close();
  }
}

export async function superviseTaskV2Projection({
  intervalMs = DEFAULTS.intervalMs,
  signal,
  runOnce,
  sleepUntilNext = sleep,
  log = event => console.log(JSON.stringify(event)),
  ...cycleOptions
} = {}) {
  requirePositiveInteger(intervalMs, 'intervalMs');
  if (typeof runOnce !== 'function') throw new TypeError('runOnce must be a function');
  let cycles = 0;
  while (!signal?.aborted) {
    cycles += 1;
    try {
      log({ event: 'commitment_feishu_task_v2_projection', cycle: cycles, ...await runOnce({
        ...cycleOptions,
        operationId: randomUUID(),
      }) });
    } catch (error) {
      log({
        event: 'commitment_feishu_task_v2_projection_failed',
        cycle: cycles,
        error: error?.stack || error?.message || String(error),
      });
    }
    if (!signal?.aborted) await sleepUntilNext(intervalMs, signal);
  }
  return { cycles, stopReason: 'aborted' };
}

async function main(args = process.argv.slice(2), env = process.env) {
  dotenv.config({ path: path.join(env.HOME || os.homedir(), 'zylos/.env') });
  const dependencies = await loadCommitmentProjectionDependencies({ env });
  if (args[0] === 'register' && args[1] === '--bootstrap-policy' && args.length === 3) {
    const result = initializeTaskV2Projection({
      bootstrapPolicy: args[2],
      openCore: dependencies.openCore,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!isTaskV2Enabled(env)) {
    throw new TypeError('COMMITMENT_FEISHU_TASK_V2_ENABLED=1 is required for Task v2 runtime commands');
  }
  if (
    args[0] === 'reconcile'
    && (args.length === 1 || (args.length === 2 && args[1] === '--repair-status'))
  ) {
    const runtime = createTaskV2ProjectionRuntime({ env });
    const result = await runTaskV2Reconciliation({
      openCore: dependencies.openCore,
      reconcile: dependencies.reconcile,
      gateway: runtime.gateway,
      appId: runtime.appId,
      mapExternalTaskEvent: dependencies.mapExternalTaskEvent,
      repairStatus: args[1] === '--repair-status',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.length === 2 && args[0] === 'url') {
    const runtime = createTaskV2ProjectionRuntime({ env });
    const result = await resolveTaskV2Url({
      taskId: args[1],
      openCore: dependencies.openCore,
      gateway: runtime.gateway,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const once = args.length === 2 && args[0] === 'run' && args[1] === '--once';
  if (!once && !(args.length === 1 && args[0] === 'run')) {
    throw new TypeError('usage: task-v2-projection-worker.js register --bootstrap-policy <from_now|from_beginning> | run [--once] | reconcile [--repair-status] | url <core-task-id>');
  }
  const runtime = createTaskV2ProjectionRuntime({ env });
  const cycleOptions = {
    workerId: env.COMMITMENT_FEISHU_TASK_V2_WORKER_ID
      || `feishu-task-v2:${os.hostname()}:${process.pid}`,
    limit: envInteger(env.COMMITMENT_FEISHU_TASK_V2_BATCH_SIZE, DEFAULTS.limit, 'batch size'),
    leaseMs: envInteger(env.COMMITMENT_FEISHU_TASK_V2_LEASE_MS, DEFAULTS.leaseMs, 'lease ms'),
    retryAfterMs: envInteger(env.COMMITMENT_FEISHU_TASK_V2_RETRY_AFTER_MS, DEFAULTS.retryAfterMs, 'retry ms'),
    maxAttempts: envInteger(env.COMMITMENT_FEISHU_TASK_V2_MAX_ATTEMPTS, DEFAULTS.maxAttempts, 'max attempts'),
    ...runtime,
    ...dependencies,
  };
  if (once) {
    process.stdout.write(`${JSON.stringify(await runTaskV2ProjectionOnce(cycleOptions))}\n`);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await superviseTaskV2Projection({
    ...cycleOptions,
    intervalMs: envInteger(env.COMMITMENT_FEISHU_TASK_V2_INTERVAL_MS, DEFAULTS.intervalMs, 'interval ms'),
    signal: controller.signal,
    runOnce: runTaskV2ProjectionOnce,
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const shouldAutostart = process.env.COMMITMENT_FEISHU_TASK_V2_PROJECTION_AUTOSTART === '1' || isMain;
if (shouldAutostart) {
  main().catch((error) => {
    process.stderr.write(`task-v2-projection-worker: ${error.message}\n`);
    process.exitCode = 1;
  });
}
