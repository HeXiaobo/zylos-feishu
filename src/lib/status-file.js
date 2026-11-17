/**
 * Machine-readable component status (issue #162 item 4).
 *
 * `~/zylos/components/feishu/status.json` is the place an operator (or the
 * front desk) can look to answer "why is this group not being answered" without
 * reading PM2 logs. It holds only decisions and reasons, never message content.
 *
 * Written atomically (tmp + rename) so a reader never sees half a file. Failing
 * to write status must never break message handling, so every write is guarded.
 */
import fs from 'node:fs';
import path from 'node:path';

export const STATUS_FILE = 'status.json';

export function permissionBlock(report, extra = {}) {
  if (!report) return { checked_at: null, ok: null, missing: [], unknown: [], checks: [], ...extra };
  return {
    checked_at: report.checked_at || null,
    ok: report.ok === true,
    missing: Array.isArray(report.missing) ? report.missing : [],
    unknown: Array.isArray(report.unknown) ? report.unknown : [],
    probed_chat_id: report.probed_chat_id || null,
    checks: Array.isArray(report.checks) ? report.checks : [],
    ...extra,
  };
}

export function groupStatus(chatId, config, { evidenceFor = () => null } = {}) {
  const group = config.groups?.[chatId] || {};
  const evidence = evidenceFor(group) || {};
  return {
    chat_id: chatId,
    mode: group.mode || null,
    gate_mode: group.gateMode || null,
    internal: evidence.external === null ? null : evidence.external === false,
    source: evidence.source || 'unavailable',
    degraded: evidence.degraded === true,
    reason: evidence.reason || null,
    last_error: evidence.lastError || null,
    checked_at: evidence.checkedAt ? new Date(evidence.checkedAt).toISOString() : null,
    manual_internal: typeof group.internal === 'boolean' ? group.internal : null,
    demoted: group.internalDemoted ? { at: new Date(group.internalDemoted.at).toISOString(), reason: group.internalDemoted.reason } : null,
    auto_classification: group.autoClassification || null,
  };
}

export function buildStatus({ config, permission = null, groups = [], now = Date.now, extra = {} } = {}) {
  return {
    component: 'zylos-feishu',
    updated_at: new Date(now()).toISOString(),
    arch2: extra.arch2 === true,
    groupPolicy: config?.groupPolicy || null,
    internalTenants: Array.isArray(config?.internalTenants) ? config.internalTenants : null,
    // Issue #177: shown so an operator can see who was named as internal, the
    // same reason internalTenants is listed here.
    internalMembers: Array.isArray(config?.internalMembers) ? config.internalMembers : null,
    bot_tenant_key: config?.bot?.tenant_key || null,
    permissions: permissionBlock(permission),
    groups,
    ...extra,
  };
}

/**
 * Write status.json into the component data directory.
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
export function writeStatus(dataDir, status) {
  const target = path.join(dataDir, STATUS_FILE);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return { ok: true, path: target };
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: err.message };
  }
}

export function readStatus(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return null;
  }
}
