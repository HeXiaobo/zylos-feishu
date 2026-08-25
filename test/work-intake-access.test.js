import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemberAccessPolicy } from '../src/lib/work-intake-access.js';

function policy(mode, overrides = {}) {
  return {
    mode,
    tenantKey: overrides.tenantKey ?? (mode === 'owner' ? '' : 'tenant-a'),
    memberIds: overrides.memberIds ?? [],
    departmentIds: overrides.departmentIds ?? [],
  };
}

function identity(overrides = {}) {
  return {
    openId: overrides.openId ?? 'ou_colleague',
    userId: overrides.userId ?? null,
    tenantKey: overrides.tenantKey ?? 'tenant-a',
    isTenantMember: overrides.isTenantMember ?? true,
    departmentIds: overrides.departmentIds ?? ['od_sales'],
  };
}

function access(policyConfig, overrides = {}) {
  const audits = [];
  const module = createMemberAccessPolicy({
    policy: policyConfig,
    ownerIds: overrides.ownerIds ?? ['ou_owner'],
    audit: overrides.audit ?? ((entry) => audits.push(entry)),
    clock: () => '2026-08-25T03:00:00.000Z',
  });
  return { module, audits };
}

test('owner mode admits only configured owner identities and audits both outcomes', () => {
  const { module, audits } = access(policy('owner'));
  assert.equal(module.authorize(identity({ openId: 'ou_owner' })).allowed, true);
  assert.equal(module.authorize(identity()).allowed, false);
  assert.deepEqual(audits.map((entry) => entry.reasonCode), [
    'ACCESS_OWNER',
    'ACCESS_OWNER_ONLY',
  ]);
});

test('tenant_members admits ordinary colleagues only in the configured tenant', () => {
  const { module } = access(policy('tenant_members'));
  assert.deepEqual(module.authorize(identity()), {
    allowed: true,
    reasonCode: 'ACCESS_TENANT_MEMBER',
    audit: {
      occurredAt: '2026-08-25T03:00:00.000Z',
      mode: 'tenant_members',
      tenantKey: 'tenant-a',
      actorId: 'ou_colleague',
      allowed: true,
      reasonCode: 'ACCESS_TENANT_MEMBER',
    },
  });
  assert.equal(module.authorize(identity({ tenantKey: 'tenant-b' })).reasonCode, 'ACCESS_TENANT_MISMATCH');
  assert.equal(module.authorize(identity({ isTenantMember: false })).allowed, false);
});

test('department policy admits matching tenant departments and rejects others', () => {
  const { module } = access(policy('departments', { departmentIds: ['od_sales', 'od_crm'] }));
  assert.equal(module.authorize(identity({ departmentIds: ['od_crm'] })).reasonCode, 'ACCESS_DEPARTMENT');
  assert.equal(module.authorize(identity({ departmentIds: ['od_finance'] })).reasonCode, 'ACCESS_DEPARTMENT_MISMATCH');
});

test('allowlist accepts either open_id or user_id within the configured tenant', () => {
  const { module } = access(policy('allowlist', { memberIds: ['ou_allowed', 'u_allowed'] }));
  assert.equal(module.authorize(identity({ openId: 'ou_allowed' })).allowed, true);
  assert.equal(module.authorize(identity({ openId: 'ou_other', userId: 'u_allowed' })).allowed, true);
  assert.equal(module.authorize(identity({ openId: 'ou_other', userId: 'u_other' })).reasonCode, 'ACCESS_NOT_ALLOWLISTED');
});

test('audit is mandatory and a failed audit prevents an unaudited authorization', () => {
  const { module } = access(policy('tenant_members'), {
    audit() { throw new Error('audit storage unavailable'); },
  });
  assert.throws(() => module.authorize(identity()), /audit storage unavailable/);
});

test('rejects malformed or dangerously broad policies', () => {
  assert.throws(() => access(policy('allowlist')), /requires at least one/);
  assert.throws(() => access(policy('departments')), /requires at least one/);
  assert.throws(() => access({ ...policy('tenant_members'), tenantKey: '' }), /non-empty/);
  assert.throws(() => access({ ...policy('owner'), extra: true }), /unsupported/);
});
