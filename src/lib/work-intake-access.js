const POLICY_FIELDS = new Set(['mode', 'tenantKey', 'memberIds', 'departmentIds']);
const IDENTITY_FIELDS = new Set([
  'openId',
  'userId',
  'tenantKey',
  'isTenantMember',
  'departmentIds',
]);
const OPTION_FIELDS = new Set(['policy', 'ownerIds', 'audit', 'clock']);
const MODES = new Set(['owner', 'tenant_members', 'departments', 'allowlist']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeIds(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return [...new Set(value.map((id, index) => requireText(id, `${field}[${index}]`)))];
}

function normalizePolicy(input) {
  const policy = requireRecord(input, 'member access policy');
  requireExactFields(policy, POLICY_FIELDS, 'member access policy');
  if (!MODES.has(policy.mode)) throw new TypeError('member access policy mode is unsupported');
  const tenantKey = policy.mode === 'owner'
    ? (policy.tenantKey === '' ? '' : requireText(policy.tenantKey, 'member access tenantKey'))
    : requireText(policy.tenantKey, 'member access tenantKey');
  const memberIds = normalizeIds(policy.memberIds, 'member access memberIds');
  const departmentIds = normalizeIds(policy.departmentIds, 'member access departmentIds');
  if (policy.mode === 'allowlist' && memberIds.length === 0) {
    throw new TypeError('allowlist policy requires at least one member ID');
  }
  if (policy.mode === 'departments' && departmentIds.length === 0) {
    throw new TypeError('departments policy requires at least one department ID');
  }
  return { mode: policy.mode, tenantKey, memberIds, departmentIds };
}

function normalizeIdentity(input) {
  const identity = requireRecord(input, 'member identity');
  requireExactFields(identity, IDENTITY_FIELDS, 'member identity');
  if (typeof identity.isTenantMember !== 'boolean') {
    throw new TypeError('member identity.isTenantMember must be a boolean');
  }
  return {
    openId: identity.openId === null ? null : requireText(identity.openId, 'member identity.openId'),
    userId: identity.userId === null ? null : requireText(identity.userId, 'member identity.userId'),
    tenantKey: identity.tenantKey === null
      ? null
      : requireText(identity.tenantKey, 'member identity.tenantKey'),
    isTenantMember: identity.isTenantMember,
    departmentIds: normalizeIds(identity.departmentIds, 'member identity.departmentIds'),
  };
}

function includesIdentity(ids, identity) {
  return (identity.openId && ids.includes(identity.openId))
    || (identity.userId && ids.includes(identity.userId));
}

/**
 * Configurable and auditable tenant-member access policy.
 *
 * Every decision synchronously crosses the injected audit seam. If the audit
 * sink fails, authorization fails with it rather than silently becoming
 * unaudited.
 */
export function createMemberAccessPolicy(input) {
  const options = requireRecord(input, 'member access options');
  requireExactFields(options, OPTION_FIELDS, 'member access options');
  const policy = normalizePolicy(options.policy);
  const ownerIds = normalizeIds(options.ownerIds, 'member access ownerIds');
  if (typeof options.audit !== 'function') throw new TypeError('member access audit must be a function');
  if (typeof options.clock !== 'function') throw new TypeError('member access clock must be a function');

  return Object.freeze({
    authorize(input) {
      const identity = normalizeIdentity(input);
      let allowed = false;
      let reasonCode = 'ACCESS_OWNER_ONLY';

      if (includesIdentity(ownerIds, identity)) {
        allowed = true;
        reasonCode = 'ACCESS_OWNER';
      } else if (policy.mode !== 'owner') {
        if (!identity.isTenantMember || identity.tenantKey !== policy.tenantKey) {
          reasonCode = 'ACCESS_TENANT_MISMATCH';
        } else if (policy.mode === 'tenant_members') {
          allowed = true;
          reasonCode = 'ACCESS_TENANT_MEMBER';
        } else if (policy.mode === 'allowlist') {
          allowed = Boolean(includesIdentity(policy.memberIds, identity));
          reasonCode = allowed ? 'ACCESS_ALLOWLIST' : 'ACCESS_NOT_ALLOWLISTED';
        } else {
          allowed = identity.departmentIds.some((id) => policy.departmentIds.includes(id));
          reasonCode = allowed ? 'ACCESS_DEPARTMENT' : 'ACCESS_DEPARTMENT_MISMATCH';
        }
      }

      const audit = Object.freeze({
        occurredAt: requireText(options.clock(), 'member access clock result'),
        mode: policy.mode,
        tenantKey: identity.tenantKey,
        actorId: identity.openId ?? identity.userId,
        allowed,
        reasonCode,
      });
      options.audit(audit);
      return Object.freeze({ allowed, reasonCode, audit });
    },
  });
}
