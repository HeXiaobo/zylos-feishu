const USER_ID_TYPE = 'open_id';
const MARKER_SCHEMA = 'zylos.task-v2-projection/v1';
const PERMANENT_FEISHU_CODES = new Set([99992402]);
const MAX_LIST_PAGES = 1_000;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field);
}

function taskMarker(task) {
  return JSON.stringify({
    schema: MARKER_SCHEMA,
    coreTaskId: requireText(task.id, 'task.id'),
    coreTaskVersion: task.version,
  });
}

function parseTaskMarker(extra) {
  if (typeof extra !== 'string' || extra === '') return null;
  try {
    const marker = JSON.parse(extra);
    if (marker?.schema !== MARKER_SCHEMA || typeof marker.coreTaskId !== 'string') return null;
    return marker;
  } catch {
    return null;
  }
}

function dueFromTask(task) {
  if (task.dueAt === undefined || task.dueAt === null) return undefined;
  const milliseconds = Date.parse(requireText(task.dueAt, 'task.dueAt'));
  if (!Number.isFinite(milliseconds)) throw new TypeError('task.dueAt must be a timestamp');
  return { timestamp: String(milliseconds), is_all_day: false };
}

function completionFromTask(task) {
  if (!['review', 'done', 'cancelled'].includes(task.state)) return '0';
  const milliseconds = Date.parse(requireText(task.updatedAt, 'task.updatedAt'));
  if (!Number.isFinite(milliseconds)) throw new TypeError('task.updatedAt must be a timestamp');
  return String(milliseconds);
}

function descriptionFromTask(task) {
  const marker = `Zylos Core Task: ${requireText(task.id, 'task.id')}`;
  const description = optionalText(task.description, 'task.description');
  return description === null ? marker : `${description}\n\n${marker}`;
}

function memberKey(member) {
  return `${member.type}:${member.id}:${member.role}`;
}

function normalizeMembers(value, field = 'members') {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const seen = new Set();
  return value.map((member, index) => {
    const input = requireRecord(member, `${field}[${index}]`);
    const normalized = {
      id: requireText(input.id, `${field}[${index}].id`),
      type: requireText(input.type, `${field}[${index}].type`),
      role: requireText(input.role, `${field}[${index}].role`),
    };
    const key = memberKey(normalized);
    if (seen.has(key)) throw new TypeError(`${field} contains a duplicate member`);
    seen.add(key);
    return normalized;
  });
}

export class FeishuTaskV2Error extends Error {
  constructor(message, { retryable = true, code, cause } = {}) {
    super(message, { cause });
    this.name = 'FeishuTaskV2Error';
    this.retryable = retryable;
    if (code !== undefined) this.code = code;
  }
}

function taskFromResponse(response, operation) {
  if (response?.code !== 0) {
    const code = response?.code;
    throw new FeishuTaskV2Error(response?.msg || `Feishu Task v2 ${operation} failed`, {
      code,
      retryable: !PERMANENT_FEISHU_CODES.has(code),
    });
  }
  const task = response?.data?.task;
  if (!task || typeof task !== 'object') {
    throw new FeishuTaskV2Error(`Feishu Task v2 ${operation} returned no task`);
  }
  const marker = parseTaskMarker(task.extra);
  return Object.freeze({
    guid: requireText(task.guid, `Feishu Task v2 ${operation} guid`),
    url: requireText(task.url, `Feishu Task v2 ${operation} url`),
    summary: optionalText(task.summary, 'Feishu Task v2 summary'),
    description: optionalText(task.description, 'Feishu Task v2 description'),
    dueAt: task.due?.timestamp ? new Date(Number(task.due.timestamp)).toISOString() : null,
    members: Object.freeze(normalizeMembers(task.members ?? [], 'Feishu Task v2 members')),
    completedAt: optionalText(task.completed_at, 'Feishu Task v2 completed_at') ?? '0',
    coreTaskId: marker?.coreTaskId ?? null,
    coreTaskVersion: marker?.coreTaskVersion ?? null,
  });
}

function wrapSdkFailure(operation, error) {
  if (error instanceof FeishuTaskV2Error) throw error;
  const status = error?.response?.status;
  const retryable = status === undefined || status === 429 || status >= 500;
  throw new FeishuTaskV2Error(error?.message || `Feishu Task v2 ${operation} failed`, {
    retryable,
    code: status,
    cause: error,
  });
}

function createPayload(task, members, clientToken) {
  const due = dueFromTask(task);
  return {
    summary: requireText(task.title, 'task.title'),
    description: descriptionFromTask(task),
    ...(due ? { due } : {}),
    completed_at: completionFromTask(task),
    members: normalizeMembers(members),
    client_token: requireText(clientToken, 'clientToken'),
    extra: taskMarker(task),
    origin: {
      platform_i18n_name: { zh_cn: 'Zylos 任务', en_us: 'Zylos Task' },
    },
  };
}

function patchPayload(task, current) {
  const patch = {};
  const updateFields = [];
  const summary = requireText(task.title, 'task.title');
  if (current.summary !== summary) {
    patch.summary = summary;
    updateFields.push('summary');
  }
  const description = descriptionFromTask(task);
  if (current.description !== description) {
    patch.description = description;
    updateFields.push('description');
  }
  const due = dueFromTask(task);
  const dueAt = due ? new Date(Number(due.timestamp)).toISOString() : null;
  if (current.dueAt !== dueAt) {
    if (due) patch.due = due;
    updateFields.push('due');
  }
  const completedAt = completionFromTask(task);
  const currentCompleted = current.completedAt !== null && current.completedAt !== '0';
  const desiredCompleted = completedAt !== '0';
  if (currentCompleted !== desiredCompleted) {
    patch.completed_at = completedAt;
    updateFields.push('completed_at');
  }
  if (current.coreTaskId !== task.id || current.coreTaskVersion !== task.version) {
    patch.extra = taskMarker(task);
    updateFields.push('extra');
  }
  return { task: patch, update_fields: updateFields };
}

/** SDK-backed tenant/bot Adapter. Tests inject a fake SDK client; no OAuth user token is used. */
export function createSdkTaskV2Gateway({ client } = {}) {
  const sdk = requireRecord(client, 'client');
  const taskApi = sdk.task?.v2?.task;
  for (const operation of ['create', 'patch', 'get', 'addMembers', 'removeMembers', 'list']) {
    if (typeof taskApi?.[operation] !== 'function') {
      throw new TypeError(`client.task.v2.task.${operation} must be a function`);
    }
  }

  async function getTask(taskGuid) {
    try {
      return taskFromResponse(await taskApi.get({
        path: { task_guid: requireText(taskGuid, 'taskGuid') },
        params: { user_id_type: USER_ID_TYPE },
      }), 'get');
    } catch (error) {
      return wrapSdkFailure('get', error);
    }
  }

  async function syncMembers(taskGuid, current, desired, clientToken) {
    const currentKeys = new Set(current.map(memberKey));
    const desiredKeys = new Set(desired.map(memberKey));
    const additions = desired.filter(member => !currentKeys.has(memberKey(member)));
    const removals = current.filter(member => (
      (member.role === 'assignee' || member.role === 'follower')
      && !desiredKeys.has(memberKey(member))
    ));
    if (additions.length > 0) {
      const response = await taskApi.addMembers({
        path: { task_guid: taskGuid },
        params: { user_id_type: USER_ID_TYPE },
        data: { members: additions, client_token: `${clientToken}:add` },
      });
      taskFromResponse(response, 'add_members');
    }
    if (removals.length > 0) {
      const response = await taskApi.removeMembers({
        path: { task_guid: taskGuid },
        params: { user_id_type: USER_ID_TYPE },
        data: { members: removals },
      });
      taskFromResponse(response, 'remove_members');
    }
  }

  return Object.freeze({
    async createTask({ task, members, clientToken } = {}) {
      try {
        return taskFromResponse(await taskApi.create({
          params: { user_id_type: USER_ID_TYPE },
          data: createPayload(requireRecord(task, 'task'), members, clientToken),
        }), 'create');
      } catch (error) {
        return wrapSdkFailure('create', error);
      }
    },

    async updateTask({ taskGuid, task, members, clientToken } = {}) {
      const guid = requireText(taskGuid, 'taskGuid');
      const desiredMembers = normalizeMembers(members);
      try {
        const current = await getTask(guid);
        const normalizedTask = requireRecord(task, 'task');
        const patch = patchPayload(normalizedTask, current);
        const patched = patch.update_fields.length === 0
          ? current
          : taskFromResponse(await taskApi.patch({
            path: { task_guid: guid },
            params: { user_id_type: USER_ID_TYPE },
            data: patch,
          }), 'patch');
        await syncMembers(guid, current.members, desiredMembers, requireText(clientToken, 'clientToken'));
        return Object.freeze({ ...patched, members: Object.freeze(desiredMembers) });
      } catch (error) {
        return wrapSdkFailure('update', error);
      }
    },

    getTask,

    async findTasksByCoreTaskId(coreTaskId) {
      const expectedId = requireText(coreTaskId, 'coreTaskId');
      try {
        const tasks = [];
        const seenTaskGuids = new Set();
        const seenPageTokens = new Set();
        let pageToken;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
          const response = await taskApi.list({
            params: {
              user_id_type: USER_ID_TYPE,
              type: 'my_tasks',
              page_size: 50,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });
          if (response?.code !== 0) {
            throw new FeishuTaskV2Error(response?.msg || 'Feishu Task v2 list failed', {
              code: response?.code,
              retryable: !PERMANENT_FEISHU_CODES.has(response?.code),
            });
          }
          const candidates = response?.data?.items ?? [];
          for (const candidate of candidates) {
            const taskGuid = requireText(candidate.guid, 'Task v2 list item guid');
            if (seenTaskGuids.has(taskGuid)) continue;
            seenTaskGuids.add(taskGuid);
            // list(my_tasks) includes extra in production. Filter on that
            // marker before the authoritative get, avoiding one API request
            // for every unrelated task visible to the App.
            const listedMarker = parseTaskMarker(candidate.extra);
            if (candidate.extra !== undefined && listedMarker?.coreTaskId !== expectedId) continue;
            const snapshot = await getTask(taskGuid);
            if (snapshot.coreTaskId === expectedId) tasks.push(snapshot);
          }
          if (!response?.data?.has_more) return tasks;
          const nextPageToken = requireText(response?.data?.page_token, 'Task v2 list page_token');
          if (seenPageTokens.has(nextPageToken)) {
            throw new FeishuTaskV2Error('Feishu Task v2 list repeated a page token', {
              retryable: false,
            });
          }
          seenPageTokens.add(nextPageToken);
          pageToken = nextPageToken;
        }
        throw new FeishuTaskV2Error('Feishu Task v2 list exceeded the page safety limit', {
          retryable: false,
        });
      } catch (error) {
        return wrapSdkFailure('list', error);
      }
    },
  });
}

export const TASK_V2_MARKER_SCHEMA = MARKER_SCHEMA;
