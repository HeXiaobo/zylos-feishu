// Issue #162 item 4: permission readiness must be reported, never silently
// degraded. Two different failures have to stay distinguishable:
//
//   missing — Feishu said this scope is not granted (230027 / 99991672)
//   unknown — the probe could not run at all (network, timeout, no group yet)
//
// and a 99991672 naming a different scope must not be read as "our scope is
// missing" (the leader's constraint for this card). Feishu rejects a call with
// 99991672 listing *some* scope; only the scope it names is evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGroupPermissions, permissionSummary, GROUP_SCOPES } from '../src/lib/permissions.js';
import { parseScopeError, describeScopeError } from '../src/lib/scope-error.js';
import { buildStatus, permissionBlock } from '../src/lib/status-file.js';

const leased = { code: 0, msg: 'ok', data: { tenant: { tenant_key: 'own' } } };

function probes({ tenant = leased, group = { code: 0, msg: 'ok', data: { items: [] } } } = {}) {
  return {
    probeTenant: async () => (typeof tenant === 'function' ? tenant() : tenant),
    probeGroupMessages: async () => (typeof group === 'function' ? group() : group),
    chatId: 'oc_1',
  };
}

test('both scopes granted means ok', async () => {
  const report = await checkGroupPermissions(probes());
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unknown, []);
  assert.deepEqual(report.checks.map(check => check.status), ['granted', 'granted']);
});

test('a missing tenant scope is reported as missing, with its code and text', async () => {
  const report = await checkGroupPermissions(probes({
    tenant: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [tenant:tenant:readonly]' },
  }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ['tenant:tenant:readonly']);
  const check = report.checks.find(entry => entry.scope === 'tenant:tenant:readonly');
  assert.equal(check.status, 'missing');
  assert.equal(check.code, 99991672, 'the code is kept for a machine, the reason string for a person');
  assert.match(check.reason, /code=99991672/);
  assert.match(permissionSummary(report), /tenant:tenant:readonly=missing/);
});

test('a missing group-message scope is reported as missing', async () => {
  const report = await checkGroupPermissions(probes({
    group: { code: 230027, msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' },
  }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ['im:message.group_msg']);
});

test('a 99991672 that names a different scope is not counted as our scope missing', async () => {
  const report = await checkGroupPermissions(probes({
    tenant: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [contact:user.base:readonly]' },
  }));
  const tenant = report.checks.find(check => check.scope === 'tenant:tenant:readonly');
  assert.equal(tenant.status, 'unknown', 'a denial that does not name our scope is not proof that it is missing');
  assert.equal(tenant.named_scope, false);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unknown, ['tenant:tenant:readonly']);
  assert.equal(report.ok, false, 'unknown is not granted either');
});

test('a network error is unknown, not missing', async () => {
  const report = await checkGroupPermissions(probes({ tenant: () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } }));
  const tenant = report.checks.find(check => check.scope === 'tenant:tenant:readonly');
  assert.equal(tenant.status, 'unknown');
  assert.match(tenant.reason, /socket hang up/);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unknown, ['tenant:tenant:readonly']);
});

test('a probe that was never provided is unknown, never granted', async () => {
  const report = await checkGroupPermissions({ probeTenant: async () => leased });
  const group = report.checks.find(check => check.scope === 'im:message.group_msg');
  assert.equal(group.status, 'unknown');
  assert.match(group.reason, /no group chat id/);
  assert.equal(report.ok, false);
});

test('the report names the scopes it checked and why each one matters', () => {
  assert.deepEqual(GROUP_SCOPES.map(entry => entry.scope), ['im:message.group_msg', 'tenant:tenant:readonly']);
  for (const entry of GROUP_SCOPES) assert.ok(entry.why.length > 0);
});

test('status.json carries the permission result and never hides a failure', async () => {
  const report = await checkGroupPermissions(probes({
    group: { code: 230027, msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' },
  }));
  const block = permissionBlock(report);
  assert.equal(block.ok, false);
  assert.deepEqual(block.missing, ['im:message.group_msg']);
  const status = buildStatus({ config: { groupPolicy: 'allowlist' }, permission: report, groups: [] });
  assert.equal(status.permissions.ok, false);
  assert.equal(status.permissions.checks.length, 2);
});

test('a status built before the check ran says so instead of implying ok', () => {
  const block = permissionBlock(null);
  assert.equal(block.ok, null);
  assert.equal(block.checked_at, null);
});

test('scope error parsing keeps both observed Feishu shapes', () => {
  const tenant = parseScopeError({ code: 99991672, msg: 'Access denied. One of the following scopes is required: [tenant:tenant:readonly]' });
  assert.equal(tenant.permissionDenied, true);
  assert.deepEqual(tenant.scopes, ['tenant:tenant:readonly']);
  const group = parseScopeError({ code: 230027, msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' });
  assert.equal(group.permissionDenied, true);
  assert.deepEqual(group.scopes, ['im:message.group_msg']);
  const plain = parseScopeError({ code: 230002, msg: 'Bot is not in the chat' });
  assert.equal(plain.permissionDenied, false);
  assert.match(describeScopeError({ code: 230027, msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' }), /scopes=im:message.group_msg/);
});
