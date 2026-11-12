import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GROUP_REJECT_TEXT,
  getGroupRejectMode,
  groupRejectAction,
  isSenderAllowedInGroup,
} from '../src/lib/feishu-group-policy.js';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const TENANT_C = 'tenant-c';

function config(overrides = {}) {
  return {
    groupPolicy: 'allowlist',
    groupAllowTenants: [],
    internalCrossTenantUsers: [],
    groupRejectMode: 'silent',
    groupRejectText: '',
    groups: {
      'oc-configured': { name: 'configured', mode: 'mention' },
    },
    ...overrides,
  };
}

function allowed(value, { chatId = 'oc-configured', userId, openId, tenantKey } = {}) {
  return isSenderAllowedInGroup(value, chatId, { userId, openId, tenantKey });
}

test('a global tenant allowlist admits its tenants and denies others', () => {
  const value = config({ groupAllowTenants: [TENANT_A, TENANT_B] });

  assert.equal(allowed(value, { userId: 'u1', tenantKey: TENANT_A }), true);
  assert.equal(allowed(value, { userId: 'u2', tenantKey: TENANT_B }), true);
  assert.equal(allowed(value, { userId: 'u3', tenantKey: TENANT_C }), false);
});

test('a per-group allowTenants list replaces the global list for that chat', () => {
  const value = config({
    groupAllowTenants: [TENANT_A],
    groups: {
      'oc-configured': { name: 'configured', mode: 'mention', allowTenants: [TENANT_B] },
      'oc-other': { name: 'other', mode: 'mention' },
    },
  });

  assert.equal(allowed(value, { userId: 'u1', tenantKey: TENANT_A }), false);
  assert.equal(allowed(value, { userId: 'u2', tenantKey: TENANT_B }), true);
  // Another group without its own list keeps using the global list.
  assert.equal(allowed(value, { userId: 'u1', tenantKey: TENANT_A, chatId: 'oc-other' }), true);
  assert.equal(allowed(value, { userId: 'u3', tenantKey: TENANT_B, chatId: 'oc-other' }), false);
});

test('internalCrossTenantUsers admits named teammates from any tenant', () => {
  const value = config({
    groupAllowTenants: [TENANT_A],
    internalCrossTenantUsers: ['ou_x'],
  });

  assert.equal(allowed(value, { openId: 'ou_x', tenantKey: TENANT_C }), true);
  assert.equal(allowed(value, { openId: 'ou_y', tenantKey: TENANT_C }), false);
  // A per-group cross-tenant addition is additive to the global list.
  value.groups['oc-configured'].internalCrossTenantUsers = ['ou_z'];
  assert.equal(allowed(value, { openId: 'ou_z', tenantKey: TENANT_C }), true);
  assert.equal(allowed(value, { openId: 'ou_x', tenantKey: TENANT_C }), true);
});

test('allowFrom keeps its legacy meaning: wildcard admits all, one name admits only it', () => {
  const wildcard = config({
    groups: { 'oc-configured': { mode: 'mention', allowFrom: ['*'] } },
  });
  assert.equal(allowed(wildcard, { userId: 'u1', tenantKey: TENANT_C }), true);
  assert.equal(allowed(wildcard, { openId: 'ou_anyone' }), true);

  const single = config({
    groups: { 'oc-configured': { mode: 'mention', allowFrom: ['ou_allowed'] } },
  });
  assert.equal(allowed(single, { openId: 'ou_allowed', tenantKey: TENANT_C }), true);
  assert.equal(allowed(single, { openId: 'ou_other' }), false);
});

test('allowFrom, cross-tenant, and tenant grants are a union, not a veto', () => {
  const value = config({
    groupAllowTenants: [TENANT_A],
    internalCrossTenantUsers: ['ou_cross'],
    groups: { 'oc-configured': { mode: 'mention', allowFrom: ['ou_old'] } },
  });

  // An allowFrom miss must not skip the two supplementary grants.
  assert.equal(allowed(value, { openId: 'ou_new', tenantKey: TENANT_A }), true);
  assert.equal(allowed(value, { openId: 'ou_cross', tenantKey: TENANT_C }), true);
  // allowFrom itself still admits, and a sender with no grant is still denied.
  assert.equal(allowed(value, { openId: 'ou_old', tenantKey: TENANT_C }), true);
  assert.equal(allowed(value, { openId: 'ou_stranger', tenantKey: TENANT_C }), false);
});

test('allowFrom is the only configured restriction, so a stranger is still denied', () => {
  const value = config({
    groups: { 'oc-configured': { mode: 'mention', allowFrom: ['ou_allowed'] } },
  });

  assert.equal(allowed(value, { openId: 'ou_allowed' }), true);
  assert.equal(allowed(value, { openId: 'ou_stranger' }), false);
});

test('no sender policy configured keeps the legacy allow-all behavior', () => {
  const value = config();
  assert.equal(allowed(value, { userId: 'u1', tenantKey: TENANT_C }), true);
  assert.equal(allowed(value, { userId: 'u2' }), true);
  assert.equal(allowed(value, { userId: 'u3' }, { chatId: 'oc-unconfigured' }), true);
});

test('an empty tenant key cannot be admitted by a tenant allowlist', () => {
  const value = config({ groupAllowTenants: [TENANT_A] });

  assert.equal(allowed(value, { userId: 'u1' }), false);
  assert.equal(allowed(value, { userId: 'u1', tenantKey: '' }), false);
  assert.equal(allowed(value, { openId: 'ou_1', tenantKey: '   ' }), false);

  // With no list configured the legacy allow-all still applies.
  assert.equal(allowed(config(), { userId: 'u1', tenantKey: '' }), true);
});

test('tenant compare is case-insensitive and trims surrounding spaces', () => {
  const value = config({ groupAllowTenants: [' 1237F138330F9740 '] });
  assert.equal(allowed(value, { userId: 'u1', tenantKey: '1237f138330f9740' }), true);
  assert.equal(allowed(value, { userId: 'u1', tenantKey: '1237f138330f9741' }), false);
});

test('groupRejectAction defaults to silent', () => {
  assert.equal(getGroupRejectMode({}), 'silent');
  assert.equal(getGroupRejectMode({ groupRejectMode: 'silent' }), 'silent');
  assert.equal(getGroupRejectMode({ groupRejectMode: 'nonsense' }), 'silent');
  assert.equal(groupRejectAction({}), 'silent');
  assert.equal(groupRejectAction({ groupRejectMode: 'silent', groupRejectText: 'ignored' }), 'silent');
});

test('groupRejectAction returns the configured reply text, or the default one', () => {
  assert.deepEqual(groupRejectAction({
    groupRejectMode: 'reply',
    groupRejectText: '这个群暂时只对内部同事开放。',
  }), { reply: '这个群暂时只对内部同事开放。' });

  assert.deepEqual(
    groupRejectAction({ groupRejectMode: 'reply' }),
    { reply: DEFAULT_GROUP_REJECT_TEXT },
  );
  assert.deepEqual(
    groupRejectAction({ groupRejectMode: 'reply', groupRejectText: '   ' }),
    { reply: DEFAULT_GROUP_REJECT_TEXT },
  );
});

test('new sender-policy fields ship with safe defaults', () => {
  assert.deepEqual(DEFAULT_CONFIG.groupAllowTenants, []);
  assert.deepEqual(DEFAULT_CONFIG.internalCrossTenantUsers, []);
  assert.equal(DEFAULT_CONFIG.groupRejectMode, 'silent');
  assert.equal(DEFAULT_CONFIG.groupRejectText, '');
});
