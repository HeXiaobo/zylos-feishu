const REPORT_SCHEMA = 'zylos.native-task-conservation-gate/v1';
const CORE_SCHEMA = 'zylos.native-task-core-inventory/v1';
const PROJECTION_MARKER_SCHEMA = 'zylos.task-v2-projection/v1';
const LINK_BACKEND = 'feishu-task-v2';
const ACTIVE_STATES = new Set(['ready', 'in_progress', 'review']);
const TERMINAL_STATES = new Set(['done', 'cancelled']);
const CORE_STATES = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);
const AGENT_ID = /^agent:[a-z0-9][a-z0-9._-]*$/;

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
  const error = new Error('native Task conservation gate aborted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeDeployment(input) {
  const deployment = requireRecord(input, 'deployment');
  const agentId = requireText(deployment.agentId, 'deployment.agentId');
  const appId = requireText(deployment.appId, 'deployment.appId');
  if (!AGENT_ID.test(agentId)) {
    throw new TypeError('deployment.agentId must be a logical Agent identity');
  }
  const mappings = requireRecord(deployment.agentAppIds, 'deployment.agentAppIds');
  const agentAppIds = {};
  for (const key of Object.keys(mappings).sort()) {
    if (!AGENT_ID.test(key)) throw new TypeError(`invalid Agent identity: ${key}`);
    agentAppIds[key] = requireText(mappings[key], `deployment.agentAppIds.${key}`);
  }
  if (agentAppIds[agentId] !== appId) {
    throw new TypeError('deployment mapping must bind agentId to appId');
  }
  return { agentId, appId, agentAppIds };
}

function normalizeCoreInventory(input, deployment) {
  const inventory = requireRecord(input, 'coreInventory');
  if (inventory.schema !== CORE_SCHEMA) {
    throw new TypeError(`coreInventory.schema must be ${CORE_SCHEMA}`);
  }
  const snapshot = requireRecord(inventory.snapshot, 'coreInventory.snapshot');
  if (snapshot.stable !== true) throw new TypeError('coreInventory snapshot must be stable');
  const snapshotStrategy = requireText(snapshot.strategy, 'coreInventory.snapshot.strategy');
  const snapshotFingerprint = requireText(
    snapshot.fingerprint,
    'coreInventory.snapshot.fingerprint',
  );
  if (!/^[0-9a-f]{64}$/.test(snapshotFingerprint)) {
    throw new TypeError('coreInventory.snapshot.fingerprint must be SHA-256');
  }
  const capturedAt = requireText(inventory.capturedAt, 'coreInventory.capturedAt');
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new TypeError('coreInventory.capturedAt must be a timestamp');
  }
  const identity = requireRecord(inventory.identity, 'coreInventory.identity');
  const inventoryAgentId = requireText(identity.agentId, 'coreInventory.identity.agentId');
  if (inventoryAgentId !== deployment.agentId) {
    throw new TypeError('coreInventory identity does not match deployment.agentId');
  }
  if (!Array.isArray(inventory.tasks)) throw new TypeError('coreInventory.tasks must be an array');
  if (!Array.isArray(inventory.externalLinks)) {
    throw new TypeError('coreInventory.externalLinks must be an array');
  }

  const taskIds = new Set();
  const tasks = inventory.tasks.map((value, index) => {
    const task = requireRecord(value, `coreInventory.tasks[${index}]`);
    const id = requireText(task.id, `coreInventory.tasks[${index}].id`);
    const state = requireText(task.state, `coreInventory.tasks[${index}].state`);
    if (!CORE_STATES.has(state)) {
      throw new TypeError(`coreInventory.tasks[${index}].state is unsupported`);
    }
    if (taskIds.has(id)) throw new TypeError(`coreInventory contains duplicate task id: ${id}`);
    taskIds.add(id);
    return {
      id,
      state,
      assigneeId: optionalText(task.assigneeId, `coreInventory.tasks[${index}].assigneeId`),
      updatedAt: optionalText(task.updatedAt, `coreInventory.tasks[${index}].updatedAt`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const links = inventory.externalLinks.map((value, index) => {
    const link = requireRecord(value, `coreInventory.externalLinks[${index}]`);
    const backend = requireText(link.backend, `coreInventory.externalLinks[${index}].backend`);
    if (backend !== LINK_BACKEND) {
      throw new TypeError(`coreInventory.externalLinks[${index}].backend must be ${LINK_BACKEND}`);
    }
    return {
      taskId: requireText(link.taskId, `coreInventory.externalLinks[${index}].taskId`),
      backend,
      externalId: requireText(
        link.externalId,
        `coreInventory.externalLinks[${index}].externalId`,
      ),
    };
  }).sort((left, right) => (
    left.taskId.localeCompare(right.taskId) || left.externalId.localeCompare(right.externalId)
  ));

  return {
    schema: CORE_SCHEMA,
    capturedAt,
    snapshot: {
      stable: true,
      strategy: snapshotStrategy,
      fingerprint: snapshotFingerprint,
    },
    identity: { agentId: inventoryAgentId },
    tasks,
    externalLinks: links,
  };
}

function normalizeMember(value, field) {
  const member = requireRecord(value, field);
  const type = requireText(member.type, `${field}.type`);
  const role = requireText(member.role, `${field}.role`);
  if (!['app', 'user'].includes(type)) throw new TypeError(`${field}.type is unsupported`);
  if (!['assignee', 'follower'].includes(role)) throw new TypeError(`${field}.role is unsupported`);
  return { id: requireText(member.id, `${field}.id`), type, role };
}

function normalizeRemoteTask(value, index) {
  const field = `remote inventory tasks[${index}]`;
  const task = requireRecord(value, field);
  const status = requireText(task.status, `${field}.status`);
  if (!['todo', 'done'].includes(status)) throw new TypeError(`${field}.status is unsupported`);
  const creator = requireRecord(task.creator, `${field}.creator`);
  const creatorType = requireText(creator.type, `${field}.creator.type`);
  if (!['app', 'user'].includes(creatorType)) {
    throw new TypeError(`${field}.creator.type is unsupported`);
  }
  if (!Array.isArray(task.members)) throw new TypeError(`${field}.members must be an array`);
  const members = task.members.map((member, memberIndex) => (
    normalizeMember(member, `${field}.members[${memberIndex}]`)
  )).sort((left, right) => (
    left.type.localeCompare(right.type)
    || left.id.localeCompare(right.id)
    || left.role.localeCompare(right.role)
  ));
  const memberKeys = new Set();
  for (const member of members) {
    const key = `${member.type}:${member.id}:${member.role}`;
    if (memberKeys.has(key)) throw new TypeError(`${field}.members contains a duplicate member`);
    memberKeys.add(key);
  }
  return {
    guid: requireText(task.guid, `${field}.guid`),
    summary: optionalText(task.summary, `${field}.summary`),
    description: optionalText(task.description, `${field}.description`),
    extra: optionalText(task.extra, `${field}.extra`),
    status,
    completedAt: optionalText(task.completed_at ?? task.completedAt, `${field}.completed_at`) ?? '0',
    creator: {
      id: requireText(creator.id, `${field}.creator.id`),
      type: creatorType,
    },
    members,
    updatedAt: optionalText(task.updated_at ?? task.updatedAt, `${field}.updated_at`),
  };
}

function normalizeRemoteInventory(input, deployment) {
  const inventory = requireRecord(input, 'remote inventory');
  const identity = requireRecord(inventory.identity, 'remote inventory.identity');
  if (identity.kind !== 'app') throw new TypeError('remote inventory identity.kind must be app');
  const appId = requireText(identity.appId, 'remote inventory.identity.appId');
  if (appId !== deployment.appId) {
    throw new TypeError('remote inventory appId does not match deployment.appId');
  }
  if (!Array.isArray(inventory.tasks)) throw new TypeError('remote inventory.tasks must be an array');
  const tasks = inventory.tasks.map(normalizeRemoteTask).sort((left, right) => (
    left.guid.localeCompare(right.guid)
  ));
  return { identity: { kind: 'app', appId }, tasks };
}

function canonical(value) {
  return JSON.stringify(value);
}

function descriptionMarkers(description) {
  if (description === null) return [];
  const ids = [];
  const marker = /Zylos Core Task:\s*([^\s]+)/g;
  for (const match of description.matchAll(marker)) ids.push(match[1]);
  return ids;
}

function extraMarker(extra) {
  if (extra === null) return { present: false, valid: false, coreTaskId: null };
  try {
    const marker = JSON.parse(extra);
    if (
      !marker
      || typeof marker !== 'object'
      || Array.isArray(marker)
      || marker.schema !== PROJECTION_MARKER_SCHEMA
      || typeof marker.coreTaskId !== 'string'
      || marker.coreTaskId.trim() === ''
    ) {
      return { present: true, valid: false, coreTaskId: null };
    }
    return { present: true, valid: true, coreTaskId: marker.coreTaskId.trim() };
  } catch {
    return { present: true, valid: false, coreTaskId: null };
  }
}

function finding(code, fields = {}) {
  return { code, ...fields };
}

function findingSort(left, right) {
  return left.code.localeCompare(right.code)
    || String(left.taskId ?? '').localeCompare(String(right.taskId ?? ''))
    || String(left.taskGuid ?? '').localeCompare(String(right.taskGuid ?? ''))
    || canonical(left).localeCompare(canonical(right));
}

function buildReport({ deployment, core, remoteFirst, remote, findings }) {
  const sortedFindings = [...findings].sort(findingSort);
  const activeAgentTasks = core.tasks.filter(task => (
    ACTIVE_STATES.has(task.state) && task.assigneeId?.startsWith('agent:')
  ));
  const scopedRemoteTasks = remote.tasks.filter(task => task.members.some(member => (
    member.id === deployment.appId && member.type === 'app' && member.role === 'assignee'
  )));
  return deepFreeze({
    schema: REPORT_SCHEMA,
    passed: sortedFindings.length === 0,
    deployment,
    failureCodes: [...new Set(sortedFindings.map(item => item.code))].sort(),
    counts: {
      coreTasks: core.tasks.length,
      activeAgentTasks: activeAgentTasks.length,
      persistentLinks: core.externalLinks.length,
      remoteTasks: remote.tasks.length,
      scopedRemoteTasks: scopedRemoteTasks.length,
    },
    findings: sortedFindings,
    inventory: {
      core,
      remote,
      remoteSnapshot: {
        stable: canonical(remoteFirst) === canonical(remote),
        first: canonical(remoteFirst) === canonical(remote) ? null : remoteFirst,
        second: remote,
      },
    },
  });
}

/**
 * Read-only conservation gate for Core Task / persistent link / native Task v2.
 * The remote Adapter is captured twice so a moving native inventory cannot pass.
 */
export async function auditNativeTaskConservation({
  coreInventory,
  remote,
  deployment: deploymentInput,
  signal,
} = {}) {
  const deployment = normalizeDeployment(deploymentInput);
  const core = normalizeCoreInventory(coreInventory, deployment);
  if (!remote || typeof remote.capture !== 'function') {
    throw new TypeError('remote must provide the capture Interface');
  }
  throwIfAborted(signal);
  const first = normalizeRemoteInventory(await remote.capture({ signal }), deployment);
  throwIfAborted(signal);
  const second = normalizeRemoteInventory(await remote.capture({ signal }), deployment);
  throwIfAborted(signal);

  const findings = [];
  if (canonical(first) !== canonical(second)) {
    findings.push(finding('SNAPSHOT_UNSTABLE'));
  }
  const native = second;
  const tasksById = new Map(core.tasks.map(task => [task.id, task]));
  const linksByTask = new Map();
  const linksByGuid = new Map();
  for (const link of core.externalLinks) {
    const byTask = linksByTask.get(link.taskId) ?? [];
    byTask.push(link);
    linksByTask.set(link.taskId, byTask);
    const byGuid = linksByGuid.get(link.externalId) ?? [];
    byGuid.push(link);
    linksByGuid.set(link.externalId, byGuid);
  }
  const nativeByGuid = new Map();
  for (const task of native.tasks) {
    const matches = nativeByGuid.get(task.guid) ?? [];
    matches.push(task);
    nativeByGuid.set(task.guid, matches);
  }

  for (const task of core.tasks) {
    if (!ACTIVE_STATES.has(task.state)) continue;
    if (task.assigneeId === null) {
      findings.push(finding('ACTIVE_CORE_TASK_ASSIGNEE_MISSING', { taskId: task.id }));
      continue;
    }
    if (!task.assigneeId.startsWith('agent:')) continue;
    const mappedAppId = deployment.agentAppIds[task.assigneeId];
    if (!mappedAppId) {
      findings.push(finding('UNMAPPED_AGENT_SCOPE', { taskId: task.id, agentId: task.assigneeId }));
      continue;
    }
    if (mappedAppId !== deployment.appId) {
      findings.push(finding('UNVALIDATED_AGENT_SCOPE', {
        taskId: task.id,
        agentId: task.assigneeId,
        appId: mappedAppId,
      }));
      continue;
    }
    const links = linksByTask.get(task.id) ?? [];
    if (links.length !== 1) {
      findings.push(finding('CORE_TASK_LINK_CARDINALITY_MISMATCH', {
        taskId: task.id,
        expected: 1,
        actual: links.length,
      }));
      continue;
    }
    const cards = nativeByGuid.get(links[0].externalId) ?? [];
    if (cards.length !== 1) {
      findings.push(finding('PERSISTENT_LINK_CARD_CARDINALITY_MISMATCH', {
        taskId: task.id,
        taskGuid: links[0].externalId,
        expected: 1,
        actual: cards.length,
      }));
      continue;
    }
    const expectedStatus = task.state === 'review' ? 'done' : 'todo';
    if (cards[0].status !== expectedStatus) {
      findings.push(finding('CORE_NATIVE_STATUS_MISMATCH', {
        taskId: task.id,
        taskGuid: cards[0].guid,
        expected: expectedStatus,
        actual: cards[0].status,
      }));
    }
  }

  const cardsByMarker = new Map();
  for (const task of native.tasks) {
    const appAssigned = task.members.some(member => (
      member.id === deployment.appId && member.type === 'app' && member.role === 'assignee'
    ));
    if (!appAssigned) {
      findings.push(finding('REMOTE_IDENTITY_SCOPE_MISMATCH', { taskGuid: task.guid }));
      continue;
    }
    const descriptionIds = descriptionMarkers(task.description);
    const marker = extraMarker(task.extra);
    const candidateCoreIds = new Set([
      ...descriptionIds,
      ...(marker.valid ? [marker.coreTaskId] : []),
      ...(linksByGuid.get(task.guid) ?? []).map(link => link.taskId),
    ]);
    const completedForActiveCore = [...candidateCoreIds].some((taskId) => {
      const coreTask = tasksById.get(taskId);
      return coreTask && ACTIVE_STATES.has(coreTask.state);
    });
    const relevant = task.status === 'todo' || completedForActiveCore;
    if (!relevant) continue;

    const isCompleted = task.completedAt !== '0';
    if ((task.status === 'done') !== isCompleted) {
      findings.push(finding('REMOTE_STATUS_INCONSISTENT', { taskGuid: task.guid }));
    }
    if (descriptionIds.length !== 1) {
      findings.push(finding('DESCRIPTION_MARKER_CARDINALITY_MISMATCH', {
        taskGuid: task.guid,
        expected: 1,
        actual: descriptionIds.length,
      }));
    }
    if (!marker.valid) {
      findings.push(finding('EXTRA_MARKER_INVALID', { taskGuid: task.guid }));
    }
    const descriptionId = descriptionIds.length === 1 ? descriptionIds[0] : null;
    if (descriptionId !== null && marker.valid && descriptionId !== marker.coreTaskId) {
      findings.push(finding('DESCRIPTION_EXTRA_CORE_TASK_MISMATCH', {
        taskGuid: task.guid,
        descriptionCoreTaskId: descriptionId,
        extraCoreTaskId: marker.coreTaskId,
      }));
    }
    const coreTaskId = marker.valid ? marker.coreTaskId : descriptionId;
    if (coreTaskId !== null) {
      const cards = cardsByMarker.get(coreTaskId) ?? [];
      cards.push(task.guid);
      cardsByMarker.set(coreTaskId, cards);
    }
    const markerCoreTask = coreTaskId === null ? null : tasksById.get(coreTaskId);
    let terminalOpenReported = false;
    if (markerCoreTask && TERMINAL_STATES.has(markerCoreTask.state) && task.status === 'todo') {
      findings.push(finding('TERMINAL_CORE_HAS_OPEN_CARD', {
        taskId: markerCoreTask.id,
        taskGuid: task.guid,
        coreState: markerCoreTask.state,
      }));
      terminalOpenReported = true;
    }
    const links = linksByGuid.get(task.guid) ?? [];
    if (links.length !== 1) {
      findings.push(finding('REMOTE_CARD_LINK_CARDINALITY_MISMATCH', {
        taskId: coreTaskId,
        taskGuid: task.guid,
        expected: 1,
        actual: links.length,
      }));
      continue;
    }
    if (coreTaskId !== null && links[0].taskId !== coreTaskId) {
      findings.push(finding('MARKER_LINK_CORE_TASK_MISMATCH', {
        taskGuid: task.guid,
        markerCoreTaskId: coreTaskId,
        linkCoreTaskId: links[0].taskId,
      }));
    }
    const coreTask = tasksById.get(links[0].taskId);
    if (!coreTask) {
      findings.push(finding('REMOTE_CARD_CORE_TASK_MISSING', {
        taskId: links[0].taskId,
        taskGuid: task.guid,
      }));
    } else if (
      !terminalOpenReported
      && TERMINAL_STATES.has(coreTask.state)
      && task.status === 'todo'
    ) {
      findings.push(finding('TERMINAL_CORE_HAS_OPEN_CARD', {
        taskId: coreTask.id,
        taskGuid: task.guid,
        coreState: coreTask.state,
      }));
    } else if (ACTIVE_STATES.has(coreTask.state) && !coreTask.assigneeId?.startsWith('agent:')) {
      findings.push(finding('APP_CARD_ASSIGNEE_SCOPE_MISMATCH', {
        taskId: coreTask.id,
        taskGuid: task.guid,
        coreAssigneeId: coreTask.assigneeId,
      }));
    }
  }
  for (const [taskId, taskGuids] of cardsByMarker) {
    if (taskGuids.length > 1) {
      findings.push(finding('CORE_TASK_CARDINALITY_MISMATCH', {
        taskId,
        expected: 1,
        actual: taskGuids.length,
        taskGuids: [...taskGuids].sort(),
      }));
    }
  }

  return buildReport({ deployment, core, remoteFirst: first, remote: native, findings });
}

export const NATIVE_TASK_CONSERVATION_GATE_SCHEMA = REPORT_SCHEMA;
