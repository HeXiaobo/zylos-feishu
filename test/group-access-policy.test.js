import assert from 'node:assert/strict';
import test from 'node:test';

import { decideGroupAccess } from '../src/lib/group-access-policy.js';

function decision(overrides = {}) {
  return decideGroupAccess({
    groupPolicy: 'open',
    groupAllowed: true,
    groupConfigured: false,
    senderIsOwner: false,
    senderAllowedByGroup: true,
    memberAccessAllowed: true,
    explicitActivation: false,
    ...overrides,
  });
}

test('an explicitly configured group owns its sender policy across tenant boundaries', () => {
  assert.deepEqual(decision({
    groupConfigured: true,
    memberAccessAllowed: false,
  }), {
    allowed: true,
    reasonCode: 'ACCESS_CONFIGURED_GROUP',
    notifySender: false,
  });
});

test('an unconfigured open group still obeys the global member access policy', () => {
  assert.deepEqual(decision({ memberAccessAllowed: false }), {
    allowed: false,
    reasonCode: 'ACCESS_GLOBAL_MEMBER_POLICY',
    notifySender: false,
  });
});

test('a configured per-group sender restriction stays authoritative', () => {
  assert.deepEqual(decision({
    groupConfigured: true,
    senderAllowedByGroup: false,
  }), {
    allowed: false,
    reasonCode: 'ACCESS_GROUP_SENDER_POLICY',
    notifySender: false,
  });
});

test('only an explicit activation receives a visible denial', () => {
  assert.equal(decision({ memberAccessAllowed: false }).notifySender, false);
  assert.equal(decision({
    memberAccessAllowed: false,
    explicitActivation: true,
  }).notifySender, true);
});

test('owner bypasses membership filters but not a disabled group policy', () => {
  assert.equal(decision({
    groupAllowed: false,
    memberAccessAllowed: false,
    senderAllowedByGroup: false,
    senderIsOwner: true,
  }).allowed, true);
  assert.deepEqual(decision({
    groupPolicy: 'disabled',
    senderIsOwner: true,
    explicitActivation: true,
  }), {
    allowed: false,
    reasonCode: 'ACCESS_GROUP_DISABLED',
    notifySender: true,
  });
});
