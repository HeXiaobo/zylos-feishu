function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function parseMappings(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      throw new TypeError('FEISHU_TASK_V2_AGENT_APP_IDS must be valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('FEISHU_TASK_V2_AGENT_APP_IDS must be a JSON object');
  }
  return parsed;
}

export function resolveTaskV2DeploymentIdentity({
  agentId: rawAgentId,
  appId: rawAppId,
  rawAgentAppIds,
} = {}) {
  const agentId = requireText(rawAgentId, 'ZYLOS_AGENT_ID');
  const appId = requireText(rawAppId, 'FEISHU_APP_ID');
  const explicitMappings = parseMappings(rawAgentAppIds);
  if (explicitMappings === null) {
    return Object.freeze({
      agentId,
      appId,
      agentAppIds: Object.freeze({ [agentId]: appId }),
      source: 'derived-single-agent',
    });
  }

  const agentAppIds = {};
  for (const [mappedAgentId, mappedAppId] of Object.entries(explicitMappings)) {
    agentAppIds[requireText(mappedAgentId, 'mapped agent ID')] = requireText(
      mappedAppId,
      `FEISHU_TASK_V2_AGENT_APP_IDS.${mappedAgentId}`,
    );
  }
  if (agentAppIds[agentId] !== appId) {
    throw new TypeError('FEISHU_TASK_V2_AGENT_APP_IDS must map ZYLOS_AGENT_ID to FEISHU_APP_ID');
  }
  return Object.freeze({
    agentId,
    appId,
    agentAppIds: Object.freeze(agentAppIds),
    source: 'explicit',
  });
}
