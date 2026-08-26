import assert from 'node:assert/strict';
import test from 'node:test';

import { decideGroupAccess } from '../src/lib/group-access-policy.js';
import { decideGroupActivation } from '../src/lib/group-activation-policy.js';
import { isSilentResponse } from '../src/lib/silent-response.js';

function evaluate({
  mentionedBot = false,
  groupConfigured = true,
  senderAllowedByGroup = true,
  memberAccessAllowed = false,
  runtimeResponse = '[SKIP]',
} = {}) {
  const activation = decideGroupActivation({
    chatType: 'group',
    mentionedBot,
    smartMode: true,
  });
  if (!activation.process) return { outbound: 0, activation, access: null };

  const access = decideGroupAccess({
    groupPolicy: 'open',
    groupAllowed: true,
    groupConfigured,
    senderIsOwner: false,
    senderAllowedByGroup,
    memberAccessAllowed,
    explicitActivation: mentionedBot,
  });
  if (!access.allowed) {
    return { outbound: access.notifySender ? 1 : 0, activation, access };
  }
  return {
    outbound: isSilentResponse(runtimeResponse) ? 0 : 1,
    activation,
    access,
  };
}

test('passive Smart skip decisions are zero-outbound across runtime text variants', () => {
  assert.equal(evaluate({ runtimeResponse: '[SKIP]' }).outbound, 0);
  assert.equal(evaluate({
    runtimeResponse: 'Just a stray "A", not for me.\n\n[SKIP]',
  }).outbound, 0);
});

test('passive denial is silent while an explicit bot mention gets one denial', () => {
  assert.equal(evaluate({
    groupConfigured: false,
    memberAccessAllowed: false,
  }).outbound, 0);
  assert.equal(evaluate({
    mentionedBot: true,
    groupConfigured: false,
    memberAccessAllowed: false,
  }).outbound, 1);
});

test('a trusted external Smart group can chat but passive traffic cannot enter task intake', () => {
  const result = evaluate({
    groupConfigured: true,
    senderAllowedByGroup: true,
    memberAccessAllowed: false,
    runtimeResponse: '我来处理。',
  });

  assert.equal(result.access.allowed, true);
  assert.equal(result.activation.allowTaskIntake, false);
  assert.equal(result.activation.showImmediateResponse, false);
  assert.equal(result.outbound, 1);
});

test('a message aimed at another Agent stays silent when the runtime declines it', () => {
  const result = evaluate({
    mentionedBot: false,
    runtimeResponse: 'The message is addressed to another Agent.\n[SKIP]',
  });

  assert.equal(result.outbound, 0);
});
