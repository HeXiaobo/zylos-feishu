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

// ---------------------------------------------------------------------------
// Leader review 3: the probes must carry the RAW SDK shape, must really call the
// API that needs each scope, and a thrown SDK error must be classified by the
// scope it names. Faking "code 0, already known" is not a permission test.
// ---------------------------------------------------------------------------
import { createScopeProbes } from '../src/lib/api-probes.js';

function fakeClient({ tenant, message }) {
  const calls = { tenant: 0, message: [] };
  return {
    calls,
    tenant: { tenant: { query: async args => { calls.tenant++; assert.deepEqual(args, {}); if (tenant instanceof Error) throw tenant; return tenant; } } },
    im: { message: { list: async args => { calls.message.push(args); if (message instanceof Error) throw message; return message; } } },
  };
}

test('the tenant probe calls tenant.tenant.query and returns the raw response', async () => {
  const raw = { code: 99991672, msg: 'Access denied. One of the following scopes is required: [tenant:tenant:readonly]' };
  const client = fakeClient({ tenant: raw, message: { code: 0 } });
  const probes = createScopeProbes({ client, chatId: 'oc_1' });
  assert.equal(await probes.probeTenant(), raw);
  assert.equal(client.calls.tenant, 1);
});

test('the group probe calls im.message.list (which needs im:message.group_msg), not im.chat.get', async () => {
  const raw = { code: 230027, msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' };
  const client = fakeClient({ tenant: { code: 0 }, message: raw });
  const probes = createScopeProbes({ client, chatId: 'oc_1' });
  assert.equal(await probes.probeGroupMessages(), raw);
  const [args] = client.calls.message;
  assert.equal(args.params.container_id, 'oc_1');
  assert.equal(args.params.container_id_type, 'chat');
  assert.equal(args.params.page_size, 1, 'one page is enough to prove the scope');
});

test('no group yet means no group probe at all, so the scope is unknown rather than fabricated', async () => {
  const client = fakeClient({ tenant: { code: 0 }, message: { code: 0 } });
  const probes = createScopeProbes({ client, chatId: null });
  assert.equal(probes.probeGroupMessages, undefined);
  const report = await checkGroupPermissions(probes);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unknown, ['im:message.group_msg']);
  assert.equal(report.ok, false);
});

test('a thrown SDK error with response.data is classified by the scope it names', async () => {
  const thrown = Object.assign(new Error('Request failed with status code 400'), {
    response: { data: { code: 230027, msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' } },
  });
  const client = fakeClient({ tenant: { code: 0 }, message: thrown });
  const report = await checkGroupPermissions(createScopeProbes({ client, chatId: 'oc_1' }));
  assert.deepEqual(report.missing, ['im:message.group_msg'], 'a thrown denial still proves the scope is missing');
  const check = report.checks.find(entry => entry.scope === 'im:message.group_msg');
  assert.equal(check.status, 'missing');
  assert.equal(check.code, 230027);
  assert.match(check.reason, /im:message\.group_msg/);
});

test('a thrown error that names another scope stays unknown, not missing', async () => {
  const thrown = Object.assign(new Error('Access denied'), {
    response: { data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [contact:user.base:readonly]' } },
  });
  const client = fakeClient({ tenant: thrown, message: { code: 0 } });
  const report = await checkGroupPermissions(createScopeProbes({ client, chatId: 'oc_1' }));
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unknown, ['tenant:tenant:readonly']);
});

test('a denied call that names no scope is unknown, not missing', async () => {
  const client = fakeClient({ tenant: { code: 230002, msg: 'Bot is not in the chat' }, message: { code: 0 } });
  const report = await checkGroupPermissions(createScopeProbes({ client, chatId: 'oc_1' }));
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.unknown, ['tenant:tenant:readonly']);
});

test('a wrapper without a code field can never be counted as granted', async () => {
  // The old wiring passed `getChatInfo`'s `{ success: true, chat: {...} }`, which
  // has no `code`, so the group scope was always unknown.
  const report = await checkGroupPermissions({
    probeTenant: async () => ({ code: 0, msg: 'ok' }),
    probeGroupMessages: async () => ({ success: true, chat: { external: false } }),
    chatId: 'oc_1',
  });
  const group = report.checks.find(check => check.scope === 'im:message.group_msg');
  assert.equal(group.status, 'unknown');
  assert.equal(report.ok, false);
});

test('both real probes succeeding with code 0 is the only way to get ok=true', async () => {
  const client = fakeClient({ tenant: { code: 0, data: { tenant: { tenant_key: 'own' } } }, message: { code: 0, data: { items: [] } } });
  const report = await checkGroupPermissions(createScopeProbes({ client, chatId: 'oc_1' }));
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(check => check.status), ['granted', 'granted']);
});
