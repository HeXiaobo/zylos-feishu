const HUMAN_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
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

function humanMember(id, role, field) {
  const openId = requireText(id, field);
  if (!HUMAN_OPEN_ID.test(openId)) {
    throw new TypeError(`${field} must be a Feishu open_id`);
  }
  return Object.freeze({ id: openId, type: 'user', role });
}

function deduplicateMembers(members) {
  const seen = new Set();
  return members.filter((member) => {
    const key = `${member.type}:${member.id}:${member.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Translate Core business roles to Feishu Task v2 members.
 *
 * Core remains the owner of owner/acceptor/assignee. This Adapter projects
 * owners and distinct acceptors as followers, a human assignee as a user, and
 * a logical Agent assignee as the configured App identity.
 */
export function createTaskV2MemberMapper({ appId, agentAppIds = {} } = {}) {
  const gatewayAppId = requireText(appId, 'appId');
  const configuredAgents = requireRecord(agentAppIds, 'agentAppIds');
  const agentIds = new Map(Object.entries(configuredAgents).map(([agentId, mappedAppId]) => {
    if (!AGENT_ID.test(agentId)) throw new TypeError(`invalid Agent identity: ${agentId}`);
    return [agentId, requireText(mappedAppId, `agentAppIds.${agentId}`)];
  }));
  if (!agentIds.has('agent:yueran')) agentIds.set('agent:yueran', gatewayAppId);

  return Object.freeze({
    map(taskInput) {
      const task = requireRecord(taskInput, 'task');
      const members = [humanMember(task.ownerId, 'follower', 'task.ownerId')];
      if (task.acceptorId !== task.ownerId) {
        members.push(humanMember(task.acceptorId, 'follower', 'task.acceptorId'));
      }
      if (task.assigneeId !== null && task.assigneeId !== undefined) {
        const assigneeId = requireText(task.assigneeId, 'task.assigneeId');
        if (HUMAN_OPEN_ID.test(assigneeId)) {
          members.push(humanMember(assigneeId, 'assignee', 'task.assigneeId'));
        } else {
          const mappedAppId = agentIds.get(assigneeId);
          if (!mappedAppId) {
            throw new TypeError(`task.assigneeId has no Feishu App mapping: ${assigneeId}`);
          }
          members.push(Object.freeze({ id: mappedAppId, type: 'app', role: 'assignee' }));
        }
      }
      return Object.freeze(deduplicateMembers(members));
    },
  });
}
