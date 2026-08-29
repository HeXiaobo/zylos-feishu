import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTaskV2DeploymentIdentity,
} from '../src/lib/task-v2-deployment-identity.js';

test('derives one exact Agent to App mapping when no explicit map exists', () => {
  assert.deepEqual(resolveTaskV2DeploymentIdentity({
    agentId: 'agent:veda',
    appId: 'cli_veda',
    rawAgentAppIds: undefined,
  }), {
    agentId: 'agent:veda',
    appId: 'cli_veda',
    agentAppIds: { 'agent:veda': 'cli_veda' },
    source: 'derived-single-agent',
  });
});

test('preserves an explicit multi-Agent map when the current identity matches', () => {
  const identity = resolveTaskV2DeploymentIdentity({
    agentId: 'agent:veda',
    appId: 'cli_veda',
    rawAgentAppIds: JSON.stringify({
      'agent:veda': 'cli_veda',
      'agent:ss': 'cli_ss',
    }),
  });

  assert.equal(identity.source, 'explicit');
  assert.deepEqual(identity.agentAppIds, {
    'agent:veda': 'cli_veda',
    'agent:ss': 'cli_ss',
  });
});

test('fails closed when an explicit map assigns the Agent to another App', () => {
  assert.throws(() => resolveTaskV2DeploymentIdentity({
    agentId: 'agent:veda',
    appId: 'cli_veda',
    rawAgentAppIds: '{"agent:veda":"cli_other"}',
  }), /must map ZYLOS_AGENT_ID to FEISHU_APP_ID/);
});
