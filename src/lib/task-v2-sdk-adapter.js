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

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Task v2 managed Task scan aborted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeEffectIdentity(value, task) {
  if (value === undefined || value === null) return null;
  const identity = requireRecord(value, 'effectIdentity');
  const allowed = new Set([
    'tenantRef', 'accountRef', 'effectId', 'payloadHash', 'coreTaskId', 'coreTaskVersion',
  ]);
  const unknown = Object.keys(identity).find(key => !allowed.has(key));
  if (unknown || Object.keys(identity).length !== allowed.size) {
    throw new TypeError('effectIdentity contains unsupported or missing fields');
  }
  if (identity.coreTaskId !== task.id || identity.coreTaskVersion !== task.version) {
    throw new TypeError('effectIdentity does not match task identity/version');
  }
  const payloadHash = requireText(identity.payloadHash, 'effectIdentity.payloadHash');
  if (!/^sha256:[a-f0-9]{64}$/.test(payloadHash)) {
    throw new TypeError('effectIdentity.payloadHash must be a sha256 digest');
  }
  return {
    tenantRef: requireText(identity.tenantRef, 'effectIdentity.tenantRef'),
    accountRef: requireText(identity.accountRef, 'effectIdentity.accountRef'),
    effectId: requireText(identity.effectId, 'effectIdentity.effectId'),
    payloadHash,
  };
}

function taskMarker(task, rawEffectIdentity) {
  const identity = normalizeEffectIdentity(rawEffectIdentity, task);
  return JSON.stringify({
    schema: MARKER_SCHEMA,
    coreTaskId: requireText(task.id, 'task.id'),
    coreTaskVersion: task.version,
    ...(identity ?? {}),
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

function reminderFromTask(task) {
  const reminder = optionalNonNegativeInteger(
    task.reminderMinutesBeforeDue,
    'task.reminderMinutesBeforeDue',
  );
  if (reminder !== null && dueFromTask(task) === undefined) {
    throw new TypeError('task.reminderMinutesBeforeDue requires task.dueAt');
  }
  return reminder;
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

function normalizeReminder(value, field = 'reminders') {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (value.length > 1) throw new TypeError(`${field} must contain at most one reminder`);
  if (value.length === 0) return null;
  const reminder = requireRecord(value[0], `${field}[0]`);
  return Object.freeze({
    id: requireText(reminder.id, `${field}[0].id`),
    minutesBeforeDue: optionalNonNegativeInteger(
      reminder.relative_fire_minute,
      `${field}[0].relative_fire_minute`,
    ),
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
  const reminder = normalizeReminder(
    task.reminders ?? [],
    'Feishu Task v2 reminders',
  );
  return Object.freeze({
    guid: requireText(task.guid, `Feishu Task v2 ${operation} guid`),
    url: requireText(task.url, `Feishu Task v2 ${operation} url`),
    summary: optionalText(task.summary, 'Feishu Task v2 summary'),
    description: optionalText(task.description, 'Feishu Task v2 description'),
    dueAt: task.due?.timestamp ? new Date(Number(task.due.timestamp)).toISOString() : null,
    reminderMinutesBeforeDue: reminder?.minutesBeforeDue ?? null,
    reminderId: reminder?.id ?? null,
    members: Object.freeze(normalizeMembers(task.members ?? [], 'Feishu Task v2 members')),
    completedAt: optionalText(task.completed_at, 'Feishu Task v2 completed_at') ?? '0',
    coreTaskId: marker?.coreTaskId ?? null,
    coreTaskVersion: marker?.coreTaskVersion ?? null,
    tenantRef: marker?.tenantRef ?? null,
    accountRef: marker?.accountRef ?? null,
    effectId: marker?.effectId ?? null,
    payloadHash: marker?.payloadHash ?? null,
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

function createPayload(task, members, clientToken, effectIdentity) {
  const due = dueFromTask(task);
  return {
    summary: requireText(task.title, 'task.title'),
    description: descriptionFromTask(task),
    ...(due ? { due } : {}),
    completed_at: completionFromTask(task),
    members: normalizeMembers(members),
    client_token: requireText(clientToken, 'clientToken'),
    extra: taskMarker(task, effectIdentity),
    origin: {
      platform_i18n_name: { zh_cn: 'Zylos 任务', en_us: 'Zylos Task' },
    },
  };
}

function patchPayload(task, current, effectIdentity) {
  if ((effectIdentity === undefined || effectIdentity === null) && current.effectId !== null) {
    throw new FeishuTaskV2Error(
      'Task v2 update requires the current TaskEffect identity; refusing a legacy writer',
      { retryable: false },
    );
  }
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
  const desiredMarker = JSON.parse(taskMarker(task, effectIdentity));
  if (current.coreTaskId !== desiredMarker.coreTaskId
      || current.coreTaskVersion !== desiredMarker.coreTaskVersion
      || current.tenantRef !== (desiredMarker.tenantRef ?? null)
      || current.accountRef !== (desiredMarker.accountRef ?? null)
      || current.effectId !== (desiredMarker.effectId ?? null)
      || current.payloadHash !== (desiredMarker.payloadHash ?? null)) {
    patch.extra = JSON.stringify(desiredMarker);
    updateFields.push('extra');
  }
  return { task: patch, update_fields: updateFields };
}

/** SDK-backed tenant/bot Adapter. Tests inject a fake SDK client; no OAuth user token is used. */
export function createSdkTaskV2Gateway({ client } = {}) {
  const sdk = requireRecord(client, 'client');
  const taskApi = sdk.task?.v2?.task;
  for (const operation of [
    'create',
    'patch',
    'get',
    'addMembers',
    'removeMembers',
    'addReminders',
    'removeReminders',
    'list',
  ]) {
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

  async function scanManagedTasks(expectedCoreTaskId = null, signal) {
    const tasks = [];
    const seenTaskGuids = new Set();
    for (const completed of [false, true]) {
      const seenPageTokens = new Set();
      let pageToken;
      let exhausted = false;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        throwIfAborted(signal);
        const response = await taskApi.list({
          params: {
            user_id_type: USER_ID_TYPE,
            type: 'my_tasks',
            completed,
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
          // list(my_tasks) includes extra in production. Filter on that marker
          // before the authoritative get, avoiding reads of unrelated tasks.
          const listedMarker = parseTaskMarker(candidate.extra);
          if (candidate.extra !== undefined) {
            if (listedMarker === null) continue;
            if (
              expectedCoreTaskId !== null
              && listedMarker.coreTaskId !== expectedCoreTaskId
            ) continue;
          }
          throwIfAborted(signal);
          const snapshot = await getTask(taskGuid);
          if (
            snapshot.coreTaskId !== null
            && (
              expectedCoreTaskId === null
              || snapshot.coreTaskId === expectedCoreTaskId
            )
          ) tasks.push(snapshot);
        }
        if (!response?.data?.has_more) {
          exhausted = true;
          break;
        }
        const nextPageToken = requireText(response?.data?.page_token, 'Task v2 list page_token');
        if (seenPageTokens.has(nextPageToken)) {
          throw new FeishuTaskV2Error('Feishu Task v2 list repeated a page token', {
            retryable: false,
          });
        }
        seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      if (!exhausted) {
        throw new FeishuTaskV2Error('Feishu Task v2 list exceeded the page safety limit', {
          retryable: false,
        });
      }
    }
    return tasks;
  }

  async function syncReminder(taskGuid, current, desired) {
    if (current.reminderMinutesBeforeDue === desired) return false;
    if (current.reminderMinutesBeforeDue !== null) {
      taskFromResponse(await taskApi.removeReminders({
        path: { task_guid: taskGuid },
        params: { user_id_type: USER_ID_TYPE },
        data: { reminder_ids: [requireText(current.reminderId, 'current reminder id')] },
      }), 'remove_reminders');
      if (desired === null) {
        const confirmed = await getTask(taskGuid);
        if (confirmed.reminderMinutesBeforeDue !== null) {
          throw new FeishuTaskV2Error(
            `Feishu Task v2 reminder readback mismatch for ${taskGuid}`,
          );
        }
      }
    }
    if (desired !== null) {
      taskFromResponse(await taskApi.addReminders({
        path: { task_guid: taskGuid },
        params: { user_id_type: USER_ID_TYPE },
        data: { reminders: [{ relative_fire_minute: desired }] },
      }), 'add_reminders');
    }
    return true;
  }

  return Object.freeze({
    async createTask({ task, members, clientToken, effectIdentity } = {}) {
      try {
        const normalizedTask = requireRecord(task, 'task');
        const created = taskFromResponse(await taskApi.create({
          params: { user_id_type: USER_ID_TYPE },
          data: createPayload(normalizedTask, members, clientToken, effectIdentity),
        }), 'create');
        const reminderMinutesBeforeDue = reminderFromTask(normalizedTask);
        if (reminderMinutesBeforeDue === null) return created;
        taskFromResponse(await taskApi.addReminders({
          path: { task_guid: created.guid },
          params: { user_id_type: USER_ID_TYPE },
          data: { reminders: [{ relative_fire_minute: reminderMinutesBeforeDue }] },
        }), 'add_reminders');
        const confirmed = await getTask(created.guid);
        if (confirmed.reminderMinutesBeforeDue !== reminderMinutesBeforeDue) {
          throw new FeishuTaskV2Error(
            `Feishu Task v2 reminder readback mismatch for ${created.guid}`,
          );
        }
        return confirmed;
      } catch (error) {
        return wrapSdkFailure('create', error);
      }
    },

    async updateTask({ taskGuid, task, members, clientToken, effectIdentity } = {}) {
      const guid = requireText(taskGuid, 'taskGuid');
      const desiredMembers = normalizeMembers(members);
      try {
        const current = await getTask(guid);
        const normalizedTask = requireRecord(task, 'task');
        const patch = patchPayload(normalizedTask, current, effectIdentity);
        const desiredReminder = reminderFromTask(normalizedTask);
        const normalizedClientToken = requireText(clientToken, 'clientToken');
        // A reminder update is a separate native API operation. Complete the
        // reminder transition first so a rejected close cannot leave a Task
        // completed while its old alarm remains active. A retry can safely
        // resume from the authoritative Task state after a partial transition.
        const reminderChanged = await syncReminder(
          guid,
          current,
          desiredReminder,
        );
        const patched = patch.update_fields.length === 0
          ? current
          : taskFromResponse(await taskApi.patch({
            path: { task_guid: guid },
            params: { user_id_type: USER_ID_TYPE },
            data: patch,
          }), 'patch');
        await syncMembers(
          guid,
          current.members,
          desiredMembers,
          normalizedClientToken,
        );
        if (!reminderChanged && desiredReminder === null) {
          return Object.freeze({ ...patched, members: Object.freeze(desiredMembers) });
        }
        const confirmed = await getTask(guid);
        if (confirmed.reminderMinutesBeforeDue !== desiredReminder) {
          throw new FeishuTaskV2Error(`Feishu Task v2 reminder readback mismatch for ${guid}`);
        }
        return confirmed;
      } catch (error) {
        return wrapSdkFailure('update', error);
      }
    },

    getTask,

    async listManagedTasks({ signal } = {}) {
      try {
        return await scanManagedTasks(null, signal);
      } catch (error) {
        return wrapSdkFailure('list', error);
      }
    },

    async findTasksByCoreTaskId(coreTaskId, { signal } = {}) {
      const expectedId = requireText(coreTaskId, 'coreTaskId');
      try {
        return await scanManagedTasks(expectedId, signal);
      } catch (error) {
        return wrapSdkFailure('list', error);
      }
    },
  });
}

export const TASK_V2_MARKER_SCHEMA = MARKER_SCHEMA;
