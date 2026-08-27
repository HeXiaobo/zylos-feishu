import { createSdkTaskV2CommentApi } from './task-v2-comment-api.js';

const MAX_LIST_PAGES = 1_000;
const liveReaders = new WeakSet();

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

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field);
}

function parseCoreTaskId(extra) {
  if (typeof extra !== 'string' || extra === '') return null;
  try {
    const marker = JSON.parse(extra);
    return marker?.schema === 'zylos.task-v2-projection/v1'
      ? optionalText(marker.coreTaskId, 'Task v2 marker.coreTaskId')
      : null;
  } catch {
    return null;
  }
}

function missingResponse(value) {
  const status = value?.response?.status ?? value?.status;
  if (status === 404) return true;
  const text = String(value?.msg ?? value?.message ?? '').toLowerCase();
  return text.includes('not found')
    || text.includes('deleted')
    || text.includes('不存在')
    || text.includes('已删除');
}

function responseError(response, operation) {
  const error = new Error(response?.msg || `Feishu Task v2 ${operation} failed`);
  error.code = response?.code ?? 'FEISHU_API_ERROR';
  return error;
}

function taskSnapshot(rawTask, field = 'Feishu Task v2 task') {
  const task = requireRecord(rawTask, field);
  const completedAt = optionalText(task.completed_at, `${field}.completed_at`);
  return Object.freeze({
    guid: requireText(task.guid, `${field}.guid`),
    summary: optionalText(task.summary, `${field}.summary`),
    coreTaskId: parseCoreTaskId(task.extra),
    ...(completedAt === null ? {} : { completedAt }),
  });
}

/** Read-only production Adapter for the native Task closure gate. */
export function createSdkNativeTaskGateReader({ client } = {}) {
  const sdk = requireRecord(client, 'Feishu SDK client');
  const taskApi = sdk.task?.v2?.task;
  if (typeof taskApi?.get !== 'function' || typeof taskApi?.list !== 'function') {
    throw new TypeError('Feishu SDK task.v2.task read API is unavailable');
  }
  const comments = createSdkTaskV2CommentApi({ client: sdk });

  const reader = Object.freeze({
    async getTask({ taskGuid }) {
      const guid = requireText(taskGuid, 'native Task gate taskGuid');
      let response;
      try {
        response = await taskApi.get({
          path: { task_guid: guid },
          params: { user_id_type: 'open_id' },
        });
      } catch (error) {
        if (missingResponse(error)) return { kind: 'missing' };
        throw error;
      }
      if (response?.code !== 0) {
        if (missingResponse(response)) return { kind: 'missing' };
        throw responseError(response, 'get');
      }
      return { kind: 'found', task: taskSnapshot(response.data?.task) };
    },

    async findTasksBySummary({ summary }) {
      const expectedSummary = requireText(summary, 'native Task gate summary');
      const matches = [];
      const seenGuids = new Set();
      const seenTokens = new Set();
      let pageToken;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const response = await taskApi.list({
          params: {
            user_id_type: 'open_id',
            type: 'my_tasks',
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        if (response?.code !== 0) throw responseError(response, 'list');
        for (const rawTask of response.data?.items ?? []) {
          const task = taskSnapshot(rawTask, 'Feishu Task v2 list item');
          if (task.summary !== expectedSummary || seenGuids.has(task.guid)) continue;
          seenGuids.add(task.guid);
          matches.push(task);
        }
        if (!response.data?.has_more) return matches;
        const nextToken = requireText(response.data?.page_token, 'Task v2 list page_token');
        if (seenTokens.has(nextToken)) throw new Error('Feishu Task v2 list repeated a page token');
        seenTokens.add(nextToken);
        pageToken = nextToken;
      }
      throw new Error('Feishu Task v2 list exceeded the page safety limit');
    },

    getComment(request) {
      return comments.getComment(request);
    },
  });
  liveReaders.add(reader);
  return reader;
}

export function isLiveNativeTaskGateReader(reader) {
  return Boolean(reader && typeof reader === 'object' && liveReaders.has(reader));
}
