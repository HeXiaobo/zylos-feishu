#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import dotenv from 'dotenv';

import { getClient } from './client.js';
import { DATA_DIR } from './config.js';
import { createTaskCommentReconciler } from './task-comment-reconciliation.js';
import {
  createC4TaskCommentWake,
  createCoreTaskV2CommentMapping,
} from './task-comment-production.js';
import { createTaskCommentWorker } from './task-comment-runtime.js';
import { openTaskCommentStore } from './task-comment-store.js';
import {
  createFeishuNotificationAdapter,
  createRoutedNotificationSender,
  createSdkFeishuNotificationSender,
} from './task-notification-adapter.js';
import { createSdkTaskV2CommentApi } from './task-v2-comment-api.js';

const DEFAULTS = Object.freeze({
  intervalMs: 2_000,
  commentLimit: 25,
  reconciliationLimit: 50,
  notificationLimit: 50,
});

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 4_096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function positiveInteger(value, field, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 86_400_000) {
    throw new TypeError(`${field} must be a positive integer`);
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

export async function loadTaskCommentCoreDependencies({
  env = process.env,
  importModule = specifier => import(specifier),
} = {}) {
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  const coreScripts = path.join(zylosDir, '.claude/skills/commitment-core/scripts');
  const c4Scripts = path.join(zylosDir, '.claude/skills/comm-bridge/scripts');
  const [coreModule, coordinatorModule, queueModule] = await Promise.all([
    importModule(pathToFileURL(path.join(coreScripts, 'core.js')).href),
    importModule(pathToFileURL(path.join(coreScripts, 'task-comment-coordinator.js')).href),
    importModule(pathToFileURL(path.join(c4Scripts, 'c4-idempotent-inbound.js')).href),
  ]);
  requireFunction(coreModule?.openCommitmentCore, 'installed Commitment Core.openCommitmentCore');
  requireFunction(
    coordinatorModule?.createTaskCommentCoordinator,
    'installed Commitment Core.createTaskCommentCoordinator',
  );
  requireFunction(
    queueModule?.openIdempotentInboundQueue,
    'installed comm-bridge.openIdempotentInboundQueue',
  );
  return Object.freeze({
    openCore: coreModule.openCommitmentCore,
    createCoordinator: coordinatorModule.createTaskCommentCoordinator,
    openInboundQueue: queueModule.openIdempotentInboundQueue,
  });
}

export function createC4AgentNotificationSender({ queue }) {
  requireFunction(queue?.enqueue, 'C4 idempotent inbound queue.enqueue');
  return Object.freeze({
    async send({ agentId, text, idempotencyKey }) {
      const normalizedAgentId = requireText(agentId, 'Agent notification agentId');
      if (!normalizedAgentId.startsWith('agent:')) {
        const error = new Error(`notification target is not an Agent identity: ${normalizedAgentId}`);
        error.retryable = false;
        throw error;
      }
      return queue.enqueue({
        idempotencyKey: requireText(idempotencyKey, 'Agent notification idempotencyKey'),
        channel: 'system',
        endpointId: null,
        content: `[Zylos Task Notification]\nAgent: ${normalizedAgentId}\n\n${requireText(text, 'Agent notification text', 20_000)}`,
        priority: 2,
        requireIdle: false,
      });
    },
  });
}

export function createTaskCommentProductionRuntime({
  env = process.env,
  client = getClient(),
  dependencies,
  dbPath = path.join(DATA_DIR, 'task-comments.db'),
} = {}) {
  const installed = requireRecord(dependencies, 'Task comment Core dependencies');
  requireFunction(installed.openCore, 'Task comment dependencies.openCore');
  requireFunction(installed.createCoordinator, 'Task comment dependencies.createCoordinator');
  requireFunction(installed.openInboundQueue, 'Task comment dependencies.openInboundQueue');
  const appId = requireText(env.FEISHU_APP_ID, 'FEISHU_APP_ID');
  const core = installed.openCore();
  const queue = installed.openInboundQueue();
  const store = openTaskCommentStore({ dbPath });
  try {
    const commentApi = createSdkTaskV2CommentApi({ client });
    const taskMapping = createCoreTaskV2CommentMapping({ core });
    const notifications = createFeishuNotificationAdapter({
      store,
      sender: createRoutedNotificationSender({
        feishuSender: createSdkFeishuNotificationSender({ client }),
        agentSender: createC4AgentNotificationSender({ queue }),
      }),
    });
    const conversation = installed.createCoordinator({
      core,
      async publishNotification(publication) {
        notifications.enqueue(publication);
      },
    });
    const worker = createTaskCommentWorker({
      appId,
      store,
      commentApi,
      taskMapping,
      conversation,
      wakeAgent: createC4TaskCommentWake({ queue }),
    });
    const reconciler = createTaskCommentReconciler({
      appId,
      store,
      commentApi,
      taskMapping,
    });
    return Object.freeze({
      worker,
      reconciler,
      notifications,
      close() {
        store.close();
        queue.close();
        core.close();
      },
    });
  } catch (error) {
    store.close();
    queue.close();
    core.close();
    throw error;
  }
}

export async function runTaskCommentCycle({
  worker,
  reconciler,
  notifications,
  commentLimit = DEFAULTS.commentLimit,
  reconciliationLimit = DEFAULTS.reconciliationLimit,
  notificationLimit = DEFAULTS.notificationLimit,
} = {}) {
  requireFunction(worker?.processOnce, 'Task comment worker.processOnce');
  requireFunction(reconciler?.runOnce, 'Task comment reconciler.runOnce');
  requireFunction(notifications?.flushOnce, 'Task notification adapter.flushOnce');
  return Object.freeze({
    comments: await worker.processOnce({ limit: commentLimit }),
    reconciliation: await reconciler.runOnce({ limit: reconciliationLimit }),
    notifications: await notifications.flushOnce({ limit: notificationLimit }),
  });
}

export async function superviseTaskComments({
  runtime,
  intervalMs = DEFAULTS.intervalMs,
  signal,
  runCycle = runTaskCommentCycle,
  sleepUntilNext = sleep,
  log = event => console.log(JSON.stringify(event)),
} = {}) {
  const assembled = requireRecord(runtime, 'Task comment production runtime');
  requireFunction(runCycle, 'Task comment runCycle');
  const normalizedInterval = positiveInteger(intervalMs, 'Task comment intervalMs', DEFAULTS.intervalMs);
  let cycles = 0;
  while (!signal?.aborted) {
    cycles += 1;
    try {
      log({ event: 'task_comment_cycle', cycle: cycles, ...await runCycle(assembled) });
    } catch (error) {
      log({
        event: 'task_comment_cycle_failed',
        cycle: cycles,
        error: error?.stack || error?.message || String(error),
      });
    }
    if (!signal?.aborted) await sleepUntilNext(normalizedInterval, signal);
  }
  return Object.freeze({ cycles, stopReason: 'aborted' });
}

async function main(args = process.argv.slice(2), env = process.env) {
  dotenv.config({ path: path.join(env.HOME || os.homedir(), 'zylos/.env') });
  if (env.FEISHU_TASK_COMMENTS_ENABLED !== '1') {
    throw new Error('FEISHU_TASK_COMMENTS_ENABLED=1 is required');
  }
  const once = args.length === 2 && args[0] === 'run' && args[1] === '--once';
  if (!once && !(args.length === 1 && args[0] === 'run')) {
    throw new TypeError('usage: task-comment-worker.js run [--once]');
  }
  const dependencies = await loadTaskCommentCoreDependencies({ env });
  const runtime = createTaskCommentProductionRuntime({ env, dependencies });
  try {
    if (once) {
      process.stdout.write(`${JSON.stringify(await runTaskCommentCycle(runtime))}\n`);
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await superviseTaskComments({
      runtime,
      intervalMs: positiveInteger(
        env.FEISHU_TASK_COMMENTS_INTERVAL_MS,
        'FEISHU_TASK_COMMENTS_INTERVAL_MS',
        DEFAULTS.intervalMs,
      ),
      signal: controller.signal,
    });
  } finally {
    runtime.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain || process.env.FEISHU_TASK_COMMENTS_WORKER_AUTOSTART === '1') {
  main().catch((error) => {
    process.stderr.write(`task-comment-worker: ${error.message}\n`);
    process.exitCode = 1;
  });
}
