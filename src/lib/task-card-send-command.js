import { createTaskActionContextSigner } from './task-action-context.js';
import { createTaskCardSender } from './task-card-runtime.js';

const DEFAULT_ACTION_CONTEXT_TTL_MS = 10 * 60_000;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function readActionContextTtl(env) {
  const raw = env.FEISHU_TASK_ACTION_TTL_MS;
  if (raw === undefined || raw === '') return DEFAULT_ACTION_CONTEXT_TTL_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new TypeError('FEISHU_TASK_ACTION_TTL_MS must be a positive integer');
  }
  const ttlMs = Number(raw);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('FEISHU_TASK_ACTION_TTL_MS must be a positive integer');
  }
  return ttlMs;
}

function parseTask(taskJson) {
  try {
    return JSON.parse(taskJson);
  } catch {
    throw new TypeError('task snapshot must be valid JSON');
  }
}

/**
 * Execute the local task-card sender command. Production passes the existing
 * zylos-feishu `sendMessage`; tests inject a network-free implementation.
 */
export async function sendTaskCardCommand(input, dependencies) {
  const request = requireRecord(input, 'task card command input');
  const runtime = requireRecord(dependencies, 'task card command dependencies');
  if (!Array.isArray(request.args) || request.args.length !== 3) {
    throw new TypeError(
      'usage: send-task-card.js <receive_id> <receive_id_type> <task_json>',
    );
  }
  const env = requireRecord(request.env, 'task card command environment');
  if (typeof runtime.clock !== 'function') {
    throw new TypeError('clock must be a function');
  }
  if (typeof runtime.sendMessage !== 'function') {
    throw new TypeError('sendMessage must be a function');
  }

  const signer = createTaskActionContextSigner({
    secret: env.FEISHU_TASK_CONTEXT_SECRET,
    clock: runtime.clock,
  });
  const sender = createTaskCardSender({
    sendMessage: runtime.sendMessage,
    issueTaskActionContext: (claims) => signer.issue(claims),
    clock: runtime.clock,
    actionContextTtlMs: readActionContextTtl(env),
  });
  const [receiveId, receiveIdType, taskJson] = request.args;
  const result = await sender.send({
    receiveId,
    receiveIdType,
    task: parseTask(taskJson),
  });
  if (!result?.success) {
    throw new Error(result?.message || 'Feishu task card send failed');
  }
  return result;
}
