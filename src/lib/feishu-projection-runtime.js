import path from 'node:path';

import dotenv from 'dotenv';

import { createTaskActionContextSigner } from './task-action-context.js';
import { createSdkTaskCardProjectionPublisher } from './task-card-projection-publisher.js';
import { getClient } from './client.js';

const ACTION_CONTEXT_TTL_MS = 10 * 60_000;
const RUNTIME_OPTION_FIELDS = new Set(['env', 'client', 'clock']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function loadDefaultEnvironment() {
  dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });
  return process.env;
}

function parseAgentLabels(env) {
  let labels = {};
  if (env.ZYLOS_AGENT_LABELS?.trim()) {
    try {
      labels = JSON.parse(env.ZYLOS_AGENT_LABELS);
    } catch {
      throw new TypeError('ZYLOS_AGENT_LABELS must be a JSON object');
    }
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
      throw new TypeError('ZYLOS_AGENT_LABELS must be a JSON object');
    }
  }
  const agentId = env.ZYLOS_AGENT_ID?.trim();
  const agentLabel = env.ZYLOS_AGENT_LABEL?.trim();
  if (agentId && agentLabel && labels[agentId] === undefined) {
    labels = { ...labels, [agentId]: agentLabel };
  }
  return labels;
}

/**
 * Component-owned production assembly for Commitment Core's projection worker.
 * Core imports this factory by an explicit local module path, so credentials,
 * the Feishu SDK, and card rendering remain outside the Core domain Module.
 */
export async function createFeishuProjectionRuntime(options = {}) {
  const runtime = requireRecord(options, 'Feishu projection runtime options');
  if (Object.keys(runtime).some(key => !RUNTIME_OPTION_FIELDS.has(key))) {
    throw new TypeError('Feishu projection runtime options contain unsupported fields');
  }
  const env = requireRecord(
    runtime.env ?? loadDefaultEnvironment(),
    'Feishu projection runtime environment',
  );
  const clock = runtime.clock ?? Date.now;
  const signer = createTaskActionContextSigner({
    secret: env.FEISHU_TASK_CONTEXT_SECRET,
    clock,
  });
  const client = runtime.client ?? getClient();
  const publisher = createSdkTaskCardProjectionPublisher({
    client,
    issueTaskActionContext: claims => signer.issue(claims),
    clock,
    actionContextTtlMs: ACTION_CONTEXT_TTL_MS,
    agentLabels: parseAgentLabels(env),
  });
  return Object.freeze({ publisher });
}
