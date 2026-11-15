/**
 * Startup capability check for the arch2 group gate (issue #162, item 4).
 *
 * Two scopes decide whether a group can be judged at all:
 *
 *   im:message.group_msg      every group message is delivered, not only @mentions
 *   tenant:tenant:readonly    the bot can read its own tenant key, which is the
 *                             default `internalTenants` entry
 *
 * The check probes the API instead of trusting configuration: a scope that was
 * never published on the app keeps failing at call time, and the failure looks
 * like any other API error in the log. `unknown` is reported as `unknown`, never
 * as granted — a probe that could not run is not evidence of permission.
 *
 * No SDK import here: the caller passes the two probe callbacks, so this module
 * stays testable with plain stubs.
 */
import { describeScopeError, parseScopeError } from './scope-error.js';

export const GROUP_SCOPES = [
  {
    scope: 'im:message.group_msg',
    why: 'receive every message in a group, not only @mentions',
  },
  {
    scope: 'tenant:tenant:readonly',
    why: 'read the bot own tenant key, the default entry of internalTenants',
  },
];

function checkResult(scope, why, status, reason, extra = {}) {
  return { scope, why, status, reason, ...extra };
}

async function runProbe(probe) {
  try {
    return { ok: true, value: await probe() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function classifyProbe({ scope, why }, probed) {
  if (!probed) return checkResult(scope, why, 'unknown', 'no probe was provided');
  if (!probed.ok) return checkResult(scope, why, 'unknown', describeScopeError(probed.error) || probed.error?.message || 'probe failed');
  const value = probed.value;
  if (value && value.code === 0) return checkResult(scope, why, 'granted', 'ok');
  const parsed = parseScopeError(value);
  if (parsed?.permissionDenied) {
    const reason = describeScopeError(value);
    // Only a denial that names this scope proves it is missing. Feishu rejects a
    // call with 99991672 listing whichever scopes it wanted; if our scope is not
    // among them the call failed for another reason and our scope is unknown.
    if (parsed.scopes.includes(scope)) {
      return checkResult(scope, why, 'missing', reason, { code: parsed.code, named_scope: true });
    }
    return checkResult(scope, why, 'unknown', reason, { code: parsed.code, named_scope: false });
  }
  return checkResult(scope, why, 'unknown', describeScopeError(value) || 'probe returned no code');
}

/**
 * @param {{probeTenant: () => Promise<any>, probeGroupMessages?: () => Promise<any>, chatId?: string}} probes
 */
export async function checkGroupPermissions({ probeTenant, probeGroupMessages, chatId = null, now = Date.now } = {}) {
  const tenantScope = GROUP_SCOPES.find(entry => entry.scope === 'tenant:tenant:readonly');
  const groupScope = GROUP_SCOPES.find(entry => entry.scope === 'im:message.group_msg');
  const tenant = classifyProbe(tenantScope, await runProbe(probeTenant));
  const groups = probeGroupMessages
    ? classifyProbe(groupScope, await runProbe(probeGroupMessages))
    : checkResult(groupScope.scope, groupScope.why, 'unknown', 'no group chat id to probe; set a group in config or check the app console');
  const checks = [tenant, groups];
  const missing = checks.filter(check => check.status === 'missing').map(check => check.scope);
  const unknown = checks.filter(check => check.status === 'unknown').map(check => check.scope);
  return {
    checked_at: new Date(now()).toISOString(),
    ok: checks.every(check => check.status === 'granted'),
    missing,
    unknown,
    probed_chat_id: chatId,
    checks,
  };
}

/** The one-line summary the component prints at startup. */
export function permissionSummary(report) {
  if (!report) return 'permission check did not run';
  const parts = report.checks.map(check => `${check.scope}=${check.status}`);
  return `ok=${report.ok} ${parts.join(' ')}`;
}
