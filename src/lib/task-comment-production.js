import { createHash } from 'node:crypto';

const TASK_V2_LINK_BACKEND = 'feishu-task-v2';
const REPLY_ENDPOINT_PREFIX = 'task-comment';

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
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function encodeOpaque(value) {
  return Buffer.from(requireText(value, 'reply endpoint identity'), 'utf8').toString('base64url');
}

function decodeOpaque(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${field} is malformed`);
  }
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (encodeOpaque(decoded) !== value) throw new TypeError(`${field} is not canonical`);
  return requireText(decoded, field);
}

function permanentMappingError(message) {
  const error = new Error(message);
  error.code = 'TASK_COMMENT_MAPPING_FAILED';
  error.retryable = false;
  return error;
}

export function createTaskCommentReplyEndpoint({ taskGuid, replyToCommentId }) {
  return `${REPLY_ENDPOINT_PREFIX}|task:${encodeOpaque(taskGuid)}`
    + `|comment:${encodeOpaque(replyToCommentId)}`;
}

export function parseTaskCommentReplyEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith(`${REPLY_ENDPOINT_PREFIX}|`)) {
    return null;
  }
  const parts = endpoint.split('|');
  if (parts.length !== 3 || !parts[1].startsWith('task:') || !parts[2].startsWith('comment:')) {
    throw new TypeError('Task comment reply endpoint is malformed');
  }
  return Object.freeze({
    taskGuid: decodeOpaque(parts[1].slice(5), 'Task comment taskGuid'),
    replyToCommentId: decodeOpaque(parts[2].slice(8), 'Task comment replyToCommentId'),
  });
}

export function taskCommentReplyIdempotencyKey({ taskGuid, replyToCommentId, content }) {
  const normalized = [
    requireText(taskGuid, 'Task comment reply taskGuid'),
    requireText(replyToCommentId, 'Task comment reply parent ID'),
    requireText(content, 'Task comment reply content', 20_000),
  ];
  return `task-comment-reply:${createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('base64url')}`;
}

export function createCoreTaskV2CommentMapping({ core }) {
  const canonical = requireRecord(core, 'Commitment Core');
  requireFunction(canonical.query, 'core.query');
  requireFunction(canonical.externalLinks?.query, 'core.externalLinks.query');

  function taskForLink(link) {
    const task = canonical.query({ taskId: requireText(link.taskId, 'Task v2 link.taskId') });
    if (!task) throw permanentMappingError(`Core task not found for Task v2 link: ${link.taskId}`);
    return task;
  }

  return Object.freeze({
    async resolve({ taskGuid }) {
      const guid = requireText(taskGuid, 'Task v2 taskGuid');
      const links = canonical.externalLinks.query({
        backend: TASK_V2_LINK_BACKEND,
        externalId: guid,
        limit: 2,
      });
      if (!Array.isArray(links) || links.length !== 1) {
        throw permanentMappingError(
          links?.length > 1
            ? `multiple Core tasks map to Task v2 GUID: ${guid}`
            : `Task v2 GUID is not linked to Core: ${guid}`,
        );
      }
      const task = taskForLink(links[0]);
      return Object.freeze({
        taskId: task.id,
        wakeTarget: typeof task.assigneeId === 'string' && task.assigneeId.startsWith('agent:')
          ? Object.freeze({ agentId: task.assigneeId })
          : null,
      });
    },
    async list({ limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('Task v2 mapping limit must be between 1 and 100');
      }
      const links = canonical.externalLinks.query({ backend: TASK_V2_LINK_BACKEND, limit });
      if (!Array.isArray(links)) throw new TypeError('core.externalLinks.query must return an array');
      return links.map((link) => {
        const task = taskForLink(link);
        return Object.freeze({
          taskId: task.id,
          taskGuid: requireText(link.externalId, 'Task v2 link.externalId'),
          state: requireText(task.state, 'Core task.state'),
          updatedAt: requireText(task.updatedAt, 'Core task.updatedAt'),
          eventCoverage: 'app',
        });
      });
    },
  });
}

export function createC4TaskCommentWake({ queue }) {
  requireFunction(queue?.enqueue, 'C4 idempotent inbound queue.enqueue');
  return async function wakeAgent(rawWake) {
    const wake = requireRecord(rawWake, 'Task comment Agent wake');
    const target = requireRecord(wake.target, 'Task comment Agent wake.target');
    const agentId = requireText(target.agentId, 'Task comment Agent wake.target.agentId');
    if (!agentId.startsWith('agent:')) {
      throw permanentMappingError(`Task comment wake target is not an Agent identity: ${agentId}`);
    }
    const replyContext = requireRecord(wake.replyContext, 'Task comment Agent wake.replyContext');
    if (replyContext.channel !== 'feishu-task-v2') {
      throw permanentMappingError(`unsupported Task comment reply channel: ${replyContext.channel}`);
    }
    const content = [
      '[Zylos Task Comment]',
      `Task: ${requireText(wake.taskId, 'Task comment Agent wake.taskId')}`,
      `Agent: ${agentId}`,
      `Author: ${requireText(wake.actorId, 'Task comment Agent wake.actorId')}`,
      `At: ${requireText(wake.occurredAt, 'Task comment Agent wake.occurredAt')}`,
      '',
      requireText(wake.body, 'Task comment Agent wake.body', 20_000),
      '',
      '请处理这条任务评论；正常回复会自动写回该飞书任务评论线程。',
    ].join('\n');
    return queue.enqueue({
      idempotencyKey: requireText(wake.idempotencyKey, 'Task comment Agent wake.idempotencyKey'),
      channel: 'feishu',
      endpointId: createTaskCommentReplyEndpoint({
        taskGuid: replyContext.taskGuid,
        replyToCommentId: replyContext.replyToCommentId,
      }),
      content,
      priority: 2,
      requireIdle: false,
    });
  };
}
