function result(allowed, reasonCode, explicitActivation) {
  return Object.freeze({
    allowed,
    reasonCode,
    notifySender: allowed ? false : explicitActivation === true,
  });
}

/**
 * Compose group, sender, and global member policies without leaking passive
 * Smart-group authorization decisions into the conversation.
 *
 * An explicitly configured group owns its sender policy. This preserves the
 * documented `allowFrom` contract (missing/empty means every group member)
 * while the global member policy continues to protect unconfigured open
 * groups and direct messages.
 */
export function decideGroupAccess({
  groupPolicy,
  groupAllowed,
  groupConfigured,
  senderIsOwner,
  senderAllowedByGroup,
  memberAccessAllowed,
  explicitActivation,
}) {
  if (groupPolicy === 'disabled') {
    return result(false, 'ACCESS_GROUP_DISABLED', explicitActivation);
  }
  if (senderIsOwner === true) {
    return result(true, 'ACCESS_OWNER', explicitActivation);
  }
  if (groupAllowed !== true) {
    return result(false, 'ACCESS_GROUP_NOT_ALLOWED', explicitActivation);
  }
  if (groupConfigured === true) {
    return senderAllowedByGroup === true
      ? result(true, 'ACCESS_CONFIGURED_GROUP', explicitActivation)
      : result(false, 'ACCESS_GROUP_SENDER_POLICY', explicitActivation);
  }
  if (memberAccessAllowed === false) {
    return result(false, 'ACCESS_GLOBAL_MEMBER_POLICY', explicitActivation);
  }
  return result(true, 'ACCESS_GROUP_OPEN', explicitActivation);
}
