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

function stableKey(prefix, values) {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(values)).digest('base64url')}`;
}

function canonicalInstant(value, field) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} must be a valid instant`);
  return parsed.toISOString();
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

export function createTaskCommentReplyEndpoint({ appId, taskGuid, replyToCommentId }) {
  return `${REPLY_ENDPOINT_PREFIX}|app:${encodeOpaque(appId)}`
    + `|task:${encodeOpaque(taskGuid)}`
    + `|comment:${encodeOpaque(replyToCommentId)}`;
}

export function parseTaskCommentReplyEndpoint(endpoint, { appId: expectedAppId } = {}) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith(`${REPLY_ENDPOINT_PREFIX}|`)) {
    return null;
  }
  const parts = endpoint.split('|');
  if (
    parts.length !== 4
    || !parts[1].startsWith('app:')
    || !parts[2].startsWith('task:')
    || !parts[3].startsWith('comment:')
  ) {
    throw new TypeError('Task comment reply endpoint is malformed');
  }
  const parsed = {
    appId: decodeOpaque(parts[1].slice(4), 'Task comment appId'),
    taskGuid: decodeOpaque(parts[2].slice(5), 'Task comment taskGuid'),
    replyToCommentId: decodeOpaque(parts[3].slice(8), 'Task comment replyToCommentId'),
  };
  if (expectedAppId !== undefined && parsed.appId !== requireText(expectedAppId, 'expected appId')) {
    throw new TypeError('Task comment reply endpoint belongs to another Feishu app');
  }
  return Object.freeze(parsed);
}

export function taskCommentReplyIdempotencyKey({ appId, taskGuid, replyToCommentId, content }) {
  const normalized = [
    requireText(appId, 'Task comment reply appId'),
    requireText(taskGuid, 'Task comment reply taskGuid'),
    requireText(replyToCommentId, 'Task comment reply parent ID'),
    requireText(content, 'Task comment reply content', 20_000),
  ];
  return stableKey('task-comment-reply', normalized);
}

export function createCoreFirstTaskCommentReply({
  appId,
  taskMapping,
  commentQuery,
  conversation,
  replyAdapter,
  clock = () => new Date(),
}) {
  const normalizedAppId = requireText(appId, 'Core-first Task comment appId');
  requireFunction(taskMapping?.resolve, 'Task comment mapping.resolve');
  requireFunction(commentQuery?.query, 'Core comment query.query');
  requireFunction(conversation?.record, 'Core conversation.record');
  requireFunction(replyAdapter?.reply, 'Task comment reply adapter.reply');
  requireFunction(clock, 'Core-first Task comment clock');

  function persistedOccurredAt(taskId, commentId) {
    const existing = commentQuery.query({ taskId, commentId });
    if (!existing) return null;
    return canonicalInstant(
      requireRecord(existing, 'existing Core Agent comment').occurredAt,
      'existing Core Agent comment occurredAt',
    );
  }

  return Object.freeze({
    async reply(rawRequest) {
      const request = requireRecord(rawRequest, 'Core-first Task comment reply');
      const normalized = {
        taskGuid: requireText(request.taskGuid, 'Task comment reply taskGuid'),
        replyToCommentId: requireText(
          request.replyToCommentId,
          'Task comment reply parent ID',
        ),
        content: requireText(request.content, 'Task comment reply content', 20_000),
      };
      const mapping = requireRecord(await taskMapping.resolve({
        appId: normalizedAppId,
        taskGuid: normalized.taskGuid,
      }), 'Task GUID mapping');
      const taskId = requireText(mapping.taskId, 'Task GUID mapping.taskId');
      const actorId = requireText(
        mapping.wakeTarget?.agentId,
        'Task GUID mapping Agent assignee',
      );
      if (!actorId.startsWith('agent:')) {
        throw permanentMappingError(`Task comment reply target is not an Agent: ${actorId}`);
      }
      const replyToCommentId = stableKey('external-comment', [
        normalizedAppId,
        normalized.replyToCommentId,
      ]);
      const commentId = stableKey('agent-comment', [
        normalizedAppId,
        normalized.taskGuid,
        normalized.replyToCommentId,
        normalized.content,
      ]);
      const coreKey = taskCommentReplyIdempotencyKey({
        appId: normalizedAppId,
        ...normalized,
      });
      const expected = {
        actorId,
        body: normalized.content,
        replyToCommentId,
      };
      const occurredAt = persistedOccurredAt(taskId, commentId)
        ?? canonicalInstant(clock(), 'Core-first Task comment clock result');
      // Always enter the coordinator, including on retry. Commitment Core's
      // receipt returns the same event for this stable command, while the
      // coordinator can replay a persisted notification decision whose first
      // ledger publication failed.
      const command = {
        type: 'AddComment',
        taskId,
        commentId,
        ...expected,
        occurredAt,
        idempotencyKey: `${coreKey}:core`,
      };
      let result;
      try {
        result = await conversation.record(command);
      } catch (error) {
        if (error?.code !== 'IDEMPOTENCY_CONFLICT') throw error;
        const winningOccurredAt = persistedOccurredAt(taskId, commentId);
        if (!winningOccurredAt || winningOccurredAt === occurredAt) throw error;
        // A concurrent first delivery may have won after this process read an
        // empty snapshot. Retry the coordinator with that persisted timestamp;
        // any other fingerprint conflict still fails closed in Core.
        result = await conversation.record({ ...command, occurredAt: winningOccurredAt });
      }
      const coreEventId = requireText(result?.event?.id, 'Core Agent comment event ID');
      const projection = await replyAdapter.reply({
        ...normalized,
        idempotencyKey: `task-comment-core-event:${coreEventId}`,
      });
      return Object.freeze({ coreEventId, projection });
    },
  });
}

export function createCoreTaskV2CommentMapping({ core }) {
  const canonical = requireRecord(core, 'Commitment Core');
  requireFunction(canonical.query, 'core.query');
  requireFunction(canonical.externalLinks?.query, 'core.externalLinks.query');
  let listCursor = null;

  function taskForLink(link) {
    const task = canonical.query({ taskId: requireText(link.taskId, 'Task v2 link.taskId') });
    if (!task) throw permanentMappingError(`Core task not found for Task v2 link: ${link.taskId}`);
    return task;
  }

  function mappingFor(task, link) {
    return Object.freeze({
      taskId: requireText(task.id, 'Core task.id'),
      taskGuid: requireText(link.externalId, 'Task v2 link.externalId'),
      state: requireText(task.state, 'Core task.state'),
      updatedAt: requireText(task.updatedAt, 'Core task.updatedAt'),
      eventCoverage: 'app',
    });
  }

  return Object.freeze({
    async resolve({ taskGuid }) {
      const guid = requireText(taskGuid, 'Task v2 taskGuid');
      const link = canonical.externalLinks.query({
        backend: TASK_V2_LINK_BACKEND,
        externalId: guid,
      });
      if (!link) throw permanentMappingError(`Task v2 GUID is not linked to Core: ${guid}`);
      const task = taskForLink(requireRecord(link, 'Task v2 ExternalLink'));
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
      const mappings = [];
      let cursor = listCursor;
      while (mappings.length < limit) {
        const tasks = canonical.query({ limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(tasks)) throw new TypeError('core.query list mode must return an array');
        if (tasks.length === 0) {
          listCursor = null;
          break;
        }
        for (const [index, rawTask] of tasks.entries()) {
          const task = requireRecord(rawTask, 'Core task list item');
          listCursor = {
            updatedAt: requireText(task.updatedAt, 'Core task.updatedAt'),
            taskId: requireText(task.id, 'Core task.id'),
          };
          const links = canonical.externalLinks.query({
            taskId: task.id,
            backend: TASK_V2_LINK_BACKEND,
            limit: 2,
          });
          if (!Array.isArray(links)) {
            throw new TypeError('core.externalLinks.query task mode must return an array');
          }
          if (links.length > 1) {
            throw permanentMappingError(`multiple Task v2 GUIDs map to Core Task: ${task.id}`);
          }
          if (links.length === 1) mappings.push(mappingFor(task, links[0]));
          if (mappings.length === limit) {
            if (index === tasks.length - 1 && tasks.length < 100) listCursor = null;
            return mappings;
          }
        }
        if (tasks.length < 100) {
          listCursor = null;
          break;
        }
        cursor = listCursor;
      }
      return mappings;
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
        appId: replyContext.appId,
        taskGuid: replyContext.taskGuid,
        replyToCommentId: replyContext.replyToCommentId,
      }),
      content,
      priority: 2,
      requireIdle: false,
    });
  };
}
