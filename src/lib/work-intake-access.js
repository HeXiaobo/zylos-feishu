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
const LEGACY_DM_FIELDS = new Set([
  'ownerBound',
  'ownerMatched',
  'policy',
  'allowFrom',
  'userId',
  'openId',
]);

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

export function normalizeOptionalIdentityId(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
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
 * Return owner identities only after a trusted operator has explicitly marked
 * the binding complete. Populated legacy ID fields alone never grant access.
 */
export function trustedOwnerIds(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner) || owner.bound !== true) {
    return [];
  }
  return [...new Set([owner.open_id, owner.user_id]
    .filter((id) => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim()))];
}

/**
 * Legacy DM policy evaluation for installations without memberAccessPolicy.
 * Owner bootstrap is intentionally absent: ownership must already be a trusted
 * persisted configuration before a sender can receive owner privileges.
 */
export function decideLegacyDmAccess(input) {
  const request = requireRecord(input, 'legacy DM access request');
  requireExactFields(request, LEGACY_DM_FIELDS, 'legacy DM access request');
  if (typeof request.ownerBound !== 'boolean' || typeof request.ownerMatched !== 'boolean') {
    throw new TypeError('legacy DM owner state must be boolean');
  }
  if (!['open', 'owner', 'allowlist'].includes(request.policy)) {
    throw new TypeError('legacy DM policy is unsupported');
  }
  const allowFrom = normalizeIds(request.allowFrom, 'legacy DM allowFrom').map(String);
  const userId = request.userId === null ? '' : requireText(request.userId, 'legacy DM userId');
  const openId = request.openId === null ? '' : requireText(request.openId, 'legacy DM openId');

  if (request.ownerBound && request.ownerMatched) {
    return Object.freeze({ allowed: true, reasonCode: 'ACCESS_OWNER' });
  }
  if (!request.ownerBound && request.policy === 'owner') {
    return Object.freeze({ allowed: false, reasonCode: 'ACCESS_OWNER_NOT_CONFIGURED' });
  }
  if (request.policy === 'open') return Object.freeze({ allowed: true, reasonCode: 'ACCESS_LEGACY_OPEN' });
  if (request.policy === 'allowlist' && (allowFrom.includes(userId) || allowFrom.includes(openId))) {
    return Object.freeze({ allowed: true, reasonCode: 'ACCESS_LEGACY_ALLOWLIST' });
  }
  return Object.freeze({
    allowed: false,
    reasonCode: request.policy === 'allowlist'
      ? 'ACCESS_LEGACY_NOT_ALLOWLISTED'
      : 'ACCESS_OWNER_ONLY',
  });
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
