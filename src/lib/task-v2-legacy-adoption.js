import { isDeepStrictEqual } from 'node:util';
import { TASK_V2_MARKER_SCHEMA } from './task-v2-sdk-adapter.js';

export const TASK_V2_ADOPTION_MARKER_SCHEMA = TASK_V2_MARKER_SCHEMA;

const DESCRIPTION_MARKER_PREFIX = 'Zylos Core Task:';
const DESCRIPTION_MARKER_PATTERN = /Zylos Core Task:\s*([^\s\n]+)/g;

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
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`);
  return value;
}

function cloneJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeMember(value, field) {
  const member = requireRecord(value, field);
  return {
    id: requireText(member.id, `${field}.id`),
    type: requireText(member.type, `${field}.type`),
    role: requireText(member.role, `${field}.role`),
  };
}

function normalizeMembers(value) {
  if (!Array.isArray(value)) throw new TypeError('Task v2 members must be an array');
  const members = value.map((member, index) => normalizeMember(member, `Task v2 members[${index}]`));
  const seen = new Set();
  for (const member of members) {
    const key = `${member.type}:${member.id}:${member.role}`;
    if (seen.has(key)) throw new TypeError('Task v2 members contain a duplicate member');
    seen.add(key);
  }
  return members.sort((left, right) => (
    left.type.localeCompare(right.type)
    || left.id.localeCompare(right.id)
    || left.role.localeCompare(right.role)
  ));
}

function dueValue(task) {
  if (Object.hasOwn(task, 'due')) return cloneJson(task.due);
  if (Object.hasOwn(task, 'dueAt')) return cloneJson(task.dueAt);
  return null;
}

function normalizeTask(value, field = 'Task v2 task') {
  const task = requireRecord(value, field);
  const creator = requireRecord(task.creator, `${field}.creator`);
  const description = optionalText(task.description, `${field}.description`);
  const extra = optionalText(task.extra, `${field}.extra`);
  return {
    guid: requireText(task.guid, `${field}.guid`),
    summary: optionalText(task.summary, `${field}.summary`),
    due: dueValue(task),
    members: normalizeMembers(task.members),
    status: requireText(task.status, `${field}.status`),
    creator: {
      id: requireText(creator.id, `${field}.creator.id`),
      type: requireText(creator.type, `${field}.creator.type`),
    },
    description,
    extra,
  };
}

function markerFor(coreTaskId, coreTaskVersion) {
  return JSON.stringify({
    schema: TASK_V2_ADOPTION_MARKER_SCHEMA,
    coreTaskId,
    coreTaskVersion,
  });
}

function markerLineFor(coreTaskId) {
  return `${DESCRIPTION_MARKER_PREFIX} ${coreTaskId}`;
}

function descriptionMarkers(description) {
  if (description === null) return [];
  return [...description.matchAll(DESCRIPTION_MARKER_PATTERN)].map(match => match[1]);
}

function markerPrefixCount(description) {
  if (description === null) return 0;
  return description.match(/Zylos Core Task:/g)?.length ?? 0;
}

function hasCanonicalDescriptionMarker(description, markerLine) {
  if (description === markerLine) return true;
  return description?.endsWith(`\n\n${markerLine}`) === true;
}

function appendDescriptionMarker(description, markerLine) {
  if (description === null || description === '') return markerLine;
  return `${description}\n\n${markerLine}`;
}

function freezeResult(result) {
  return Object.freeze({
    ...result,
    changedFields: Object.freeze([...(result.changedFields ?? [])]),
  });
}

function isTimeoutError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const status = Number(error?.status ?? error?.response?.status);
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
    || status === 408
    || status === 504
    || /timeout|timed?\s*out/i.test(String(error?.message ?? ''));
}

export class TaskV2AdoptionError extends Error {
  constructor(message, { code = 'TASK_V2_ADOPTION_FAILED', retryable = false, hold = false, cause } = {}) {
    super(message, { cause });
    this.name = 'TaskV2AdoptionError';
    this.code = code;
    this.retryable = retryable;
    this.hold = hold;
  }
}

function hold(message, code) {
  throw new TaskV2AdoptionError(message, { code, hold: true });
}

function validateCandidate(task, { taskGuid, appId }) {
  if (task.guid !== taskGuid) {
    hold('Task v2 GUID does not match the requested legacy task', 'GUID_MISMATCH');
  }
  if (task.creator.type !== 'app' || task.creator.id !== appId) {
    hold('legacy Task creator is not the expected App', 'CREATOR_MISMATCH');
  }
  if (!task.members.some(member => (
    member.type === 'app' && member.id === appId && member.role === 'assignee'
  ))) {
    hold('legacy Task does not have the expected App assignee', 'ASSIGNEE_MISMATCH');
  }
  if (task.status !== 'todo') {
    hold('legacy Task is not open todo', 'STATUS_NOT_TODO');
  }
}

function validateMarkerState(task, { coreTaskId, marker, markerLine }) {
  const markers = descriptionMarkers(task.description);
  if (markerPrefixCount(task.description) !== markers.length || markers.length > 1) {
    hold('legacy Task description has an invalid or duplicate Core marker', 'DESCRIPTION_MARKER_CONFLICT');
  }
  if (markers.length === 1 && markers[0] !== coreTaskId) {
    hold('legacy Task description has a conflicting Core marker', 'DESCRIPTION_MARKER_CONFLICT');
  }
  if (markers.length === 1 && !hasCanonicalDescriptionMarker(task.description, markerLine)) {
    hold('legacy Task description marker is not in canonical form', 'DESCRIPTION_MARKER_CONFLICT');
  }

  const extraPresent = task.extra !== null && task.extra !== '';
  if (extraPresent && task.extra !== marker) {
    hold('legacy Task extra contains an unknown or conflicting marker', 'EXTRA_MARKER_CONFLICT');
  }
  return {
    descriptionNeedsPatch: !hasCanonicalDescriptionMarker(task.description, markerLine),
    extraNeedsPatch: task.extra !== marker,
  };
}

function readbackMismatches(before, after, expectedDescription, marker) {
  const mismatches = [];
  if (after.guid !== before.guid) mismatches.push('guid');
  if (!isDeepStrictEqual(after.summary, before.summary)) mismatches.push('summary');
  if (!isDeepStrictEqual(after.due, before.due)) mismatches.push('due');
  if (!isDeepStrictEqual(after.members, before.members)) mismatches.push('members');
  if (after.status !== before.status) mismatches.push('status');
  if (!isDeepStrictEqual(after.creator, before.creator)) mismatches.push('creator');
  if (after.description !== expectedDescription) mismatches.push('description');
  if (after.extra !== marker) mismatches.push('extra');
  return mismatches;
}

function postcheck(before, afterValue, expectedDescription, marker, taskGuid) {
  let after;
  try {
    after = normalizeTask(afterValue, 'Task v2 adoption readback');
  } catch (error) {
    throw new TaskV2AdoptionError('Task v2 adoption readback is invalid', {
      code: 'POSTCHECK_INVALID',
      hold: true,
      cause: error,
    });
  }
  const mismatches = readbackMismatches(before, after, expectedDescription, marker);
  if (mismatches.length > 0) {
    throw new TaskV2AdoptionError(
      `Task v2 adoption readback mismatch for ${taskGuid}: ${mismatches.join(',')}`,
      { code: 'POSTCHECK_MISMATCH', hold: true },
    );
  }
  return after;
}

/**
 * Deep, Core-independent adoption Module for a pre-existing Feishu Task v2.
 *
 * The injected Adapter only needs getTask(guid) and patchTask(request). This
 * Module never creates a Task and only changes description and extra after a
 * strict App-owned todo precheck. A timeout is treated as ambiguous and is
 * resolved by one authoritative readback; a mismatch remains a HOLD.
 */
export function createTaskV2LegacyAdoption({ adapter, appId } = {}) {
  if (!adapter || typeof adapter.getTask !== 'function' || typeof adapter.patchTask !== 'function') {
    throw new TypeError('adapter must provide getTask and patchTask functions');
  }
  const expectedAppId = requireText(appId, 'appId');

  async function inspectTaskMarker({ taskGuid, coreTaskId, coreTaskVersion = 1 } = {}) {
    const expectedGuid = requireText(taskGuid, 'taskGuid');
    const expectedCoreTaskId = requireText(coreTaskId, 'coreTaskId');
    if (!Number.isSafeInteger(coreTaskVersion) || coreTaskVersion < 0) {
      throw new TypeError('coreTaskVersion must be a non-negative safe integer');
    }

    let before;
    try {
      before = normalizeTask(
        await adapter.getTask(expectedGuid),
        'Task v2 adoption precheck',
      );
    } catch (error) {
      if (error instanceof TaskV2AdoptionError) throw error;
      throw new TaskV2AdoptionError('Task v2 adoption precheck failed', {
        code: 'PRECHECK_FAILED',
        hold: true,
        cause: error,
      });
    }
    validateCandidate(before, { taskGuid: expectedGuid, appId: expectedAppId });
    const marker = markerFor(expectedCoreTaskId, coreTaskVersion);
    const markerLine = markerLineFor(expectedCoreTaskId);
    const state = validateMarkerState(before, {
      coreTaskId: expectedCoreTaskId,
      marker,
      markerLine,
    });
    const expectedDescription = state.descriptionNeedsPatch
      ? appendDescriptionMarker(before.description, markerLine)
      : before.description;
    const changedFields = [
      ...(state.descriptionNeedsPatch ? ['description'] : []),
      ...(state.extraNeedsPatch ? ['extra'] : []),
    ];
    return {
      taskGuid: expectedGuid,
      coreTaskId: expectedCoreTaskId,
      coreTaskVersion,
      status: changedFields.length === 0 ? 'noop' : 'planned',
      changedFields,
      before,
      expectedDescription,
      marker,
    };
  }

  return Object.freeze({
    inspectTaskMarker,
    async adoptTaskMarker({ taskGuid, coreTaskId, coreTaskVersion = 1 } = {}) {
      const plan = await inspectTaskMarker({ taskGuid, coreTaskId, coreTaskVersion });
      if (plan.status === 'noop') {
        return freezeResult({
          status: 'noop',
          taskGuid: plan.taskGuid,
          coreTaskId: plan.coreTaskId,
          recovered: false,
        });
      }

      const {
        before,
        expectedDescription,
        marker,
        changedFields: updateFields,
      } = plan;
      const request = {
        taskGuid: plan.taskGuid,
        updateFields,
        ...(updateFields.includes('description') ? { description: expectedDescription } : {}),
        ...(updateFields.includes('extra') ? { extra: marker } : {}),
      };

      let recovered = false;
      try {
        await adapter.patchTask(request);
      } catch (error) {
        if (!isTimeoutError(error)) {
          throw new TaskV2AdoptionError('Task v2 adoption patch failed', {
            code: 'PATCH_FAILED',
            retryable: error?.retryable !== false,
            cause: error,
          });
        }
        let readback;
        try {
          readback = await adapter.getTask(plan.taskGuid);
        } catch (readbackError) {
          throw new TaskV2AdoptionError('Task v2 patch timed out and readback failed', {
            code: 'PATCH_TIMEOUT_READBACK_FAILED',
            hold: true,
            cause: readbackError,
          });
        }
        postcheck(before, readback, expectedDescription, marker, plan.taskGuid);
        recovered = true;
      }

      if (!recovered) {
        let readback;
        try {
          readback = await adapter.getTask(plan.taskGuid);
        } catch (error) {
          throw new TaskV2AdoptionError('Task v2 adoption postcheck failed', {
            code: 'POSTCHECK_FAILED',
            hold: true,
            cause: error,
          });
        }
        postcheck(before, readback, expectedDescription, marker, plan.taskGuid);
      }
      return freezeResult({
        status: 'adopted',
        taskGuid: plan.taskGuid,
        coreTaskId: plan.coreTaskId,
        changedFields: updateFields,
        recovered,
      });
    },
  });
}
