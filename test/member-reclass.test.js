// Issue #162: a group's internal/external verdict must be re-judged when the
// membership or the tenant configuration changes, not only when the 24h cache
// expires. These are the acceptance cases from the issue:
//
//   - an outside member joins → an unmentioned message right behind it is not
//     delivered, an @mention still is;
//   - that member leaves → the group is internal again without a restart;
//   - `internalTenants` changes → every cached verdict is void and the next
//     message is judged by the new configuration;
//   - a failed lookup is external and says why;
//   - a member event cannot be overwritten by a classification that was already
//     in flight when the event arrived.
//
// Constructed events only. No Feishu API is called; `getChatInfo` is a stub.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import * as classificationModule from '../src/lib/group-classification.js';
import { createGroupClassifier, effectiveInternal, groupEvidence } from '../src/lib/group-classification.js';
import { groupGatePolicy } from '../src/lib/c4-ingress.js';
import { buildStatus, groupStatus } from '../src/lib/status-file.js';

function fixture({ chatId = 'oc_1', external = false, group = {}, tenants = ['own'] } = {}) {
  const config = {
    bot: { tenant_key: 'own' },
    internalTenants: tenants.slice(),
    groups: { [chatId]: { mode: 'smart', ...group } },
  };
  const state = {
    calls: 0, saves: 0, time: 1_000_000,
    response: { success: true, chat: { external } },
    logs: [], pending: null,
  };
  const classify = createGroupClassifier({
    getChatInfo: async id => {
      assert.equal(id, chatId);
      state.calls++;
      if (state.pending) return state.pending;
      return state.response;
    },
    saveConfig: () => { state.saves++; },
    now: () => state.time,
    log: message => state.logs.push(message),
  });
  return {
    config, state, classify,
    run: (senderTenantKey = 'own') => classify({ config, chatId, senderTenantKey, botTenantKey: 'own' }),
    member: (type, users) => classify.handleMemberEvent({ config, chatId, event: { type, users }, botTenantKey: 'own' }),
    policy: () => groupGatePolicy(config, chatId),
    group: () => config.groups[chatId],
    // What the front desk actually does with an unmentioned message.
    unmentionedDelivers: () => {
      const { internal, gateMode } = groupGatePolicy(config, chatId);
      return internal === true && gateMode === 'auto';
    },
    mentionedDelivers: () => {
      // An @mention reaches the gate regardless of internal/external.
      groupGatePolicy(config, chatId);
      return true;
    },
  };
}

const outsideUser = { name: '外部', tenant_key: 'outside', user_id: { open_id: 'ou_outside' } };
const insideUser = { name: '内部', tenant_key: 'own', user_id: { open_id: 'ou_inside' } };

// ---------------------------------------------------------------------------
// 1. Outside member joins, then an unmentioned message arrives.
// ---------------------------------------------------------------------------
test('an outside member joining voids the cached internal verdict before anything awaits', async () => {
  const f = fixture({ external: false });
  await f.run();                                  // cached: internal, 24h
  assert.equal(f.policy().gateMode, 'auto');

  // The event handler is called but the lookup it triggers never resolves yet.
  let finish;
  f.state.pending = new Promise(resolve => { finish = resolve; });
  const event = f.member('added', [outsideUser]);
  // Right here — synchronously, with the lookup still in flight — a message
  // arriving behind the event must already be treated as external.
  assert.equal(f.unmentionedDelivers(), false, 'the verdict must change before the async re-judge finishes');
  assert.equal(f.policy().internal, false);
  assert.match(String(groupEvidence(f.group()).reason), /member_joined_external/);

  finish({ success: true, chat: { external: false } });
  await event;
  assert.equal(f.policy().internal, false, 'chat.external=false cannot cancel a newer outside-join event');
  assert.equal(f.unmentionedDelivers(), false);
});

test('a message right behind the outside join is not delivered, an @mention still is', async () => {
  const f = fixture({ external: false });
  await f.run();
  f.state.response = { success: true, chat: { external: false } };
  await f.member('added', [outsideUser]);
  // The next unmentioned message runs the classifier exactly like the handler does.
  await f.run('own');
  assert.equal(f.unmentionedDelivers(), false, 'unmentioned work in a group with an outside member must not be delivered');
  assert.equal(f.mentionedDelivers(), true, 'an @mention is still answered in an external group');
  assert.equal(f.policy().gateMode, 'observe');
});

test('an outside member joining a group the operator marked internal still demotes it', async () => {
  const f = fixture({ external: false, group: { internal: true } });
  await f.run();
  assert.equal(f.policy().gateMode, 'auto');
  await f.member('added', [outsideUser]);
  assert.equal(f.policy().internal, false, 'a manual internal=true is a claim, not evidence');
  assert.equal(f.group().internal, false);
  assert.equal(f.group().internalDemoted.reason, 'member_joined_external');
});

// ---------------------------------------------------------------------------
// 2. The outside member leaves → internal again, no restart, no manual cache clear.
// ---------------------------------------------------------------------------
test('an outside member leaving restores the internal verdict without a restart', async () => {
  const f = fixture({ external: false });
  await f.run();
  await f.member('added', [outsideUser]);
  assert.equal(f.policy().internal, false);

  f.state.response = { success: true, chat: { external: false } };
  const result = await f.member('deleted', [outsideUser]);
  assert.equal(result.handled, true);
  assert.equal(f.policy().internal, true, 'a successful re-judge after the departure restores auto');
  assert.equal(f.policy().gateMode, 'auto');
  assert.equal(f.unmentionedDelivers(), true);
});

test('an inside member joining leaves the group internal after the re-judge', async () => {
  const f = fixture({ external: false });
  await f.run();
  await f.member('added', [insideUser]);
  assert.equal(f.policy().internal, true);
});

test('a member event for an unknown chat is ignored instead of creating a group row', async () => {
  const f = fixture();
  await f.run();
  const result = await f.classify.handleMemberEvent({ config: f.config, chatId: 'oc_unknown', event: { type: 'added', users: [outsideUser] }, botTenantKey: 'own' });
  assert.equal(result.handled, false);
  assert.equal(f.config.groups.oc_unknown, undefined, 'an event must not register a group the bot never received a message from');
});

test('a member with no tenant_key is treated conservatively until the re-judge', async () => {
  const f = fixture({ external: false });
  await f.run();
  const event = f.member('added', [{ name: '未知', user_id: { open_id: 'ou_x' } }]);
  assert.equal(f.unmentionedDelivers(), false, 'an unknown tenant is not inside evidence');
  assert.equal(groupEvidence(f.group()).reason, 'member_tenant_unknown', 'the reason is visible while the verdict is void');
  f.state.response = { success: true, chat: { external: false } };
  await event;
  assert.equal(f.policy().internal, true, 'the lookup decides once it succeeds');
  assert.equal(f.group().autoClassification.lastInvalidation.reason, 'member_tenant_unknown', 'status keeps why it was re-judged');
});

// ---------------------------------------------------------------------------
// 3. internalTenants change → every group voided, then judged by the new config.
// ---------------------------------------------------------------------------
test('changing internalTenants invalidates ALL groups, not only the external-sender evidence', async () => {
  const config = {
    bot: { tenant_key: 'own' },
    internalTenants: ['own'],
    groups: {
      oc_used: { mode: 'smart', autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'chat_info' } },
      oc_idle: { mode: 'smart', internal: true, autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'chat_info' } },
      oc_external: { mode: 'smart', autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'external_sender' } },
    },
  };
  const saves = [];
  const logs = [];
  const classify = createGroupClassifier({
    getChatInfo: async () => ({ success: true, chat: { external: false } }),
    saveConfig: () => saves.push(1),
    now: () => 1_000_000,
    log: message => logs.push(message),
  });
  // Prime the fingerprint with the old configuration.
  await classify({ config, chatId: 'oc_used', senderTenantKey: 'own', botTenantKey: 'own' });
  assert.equal(effectiveInternal(config.groups.oc_idle), true);

  config.internalTenants = ['own', 'partner'];
  // The config watcher calls exactly this, before any message arrives.
  assert.equal(classify.syncConfig(config), true);

  for (const chatId of ['oc_used', 'oc_idle', 'oc_external']) {
    assert.equal(config.groups[chatId].autoClassification.invalidatedReason, 'config_changed', `${chatId} is voided too`);
    assert.equal(effectiveInternal(config.groups[chatId]), false, `${chatId} is conservative until the next message`);
  }
  assert.equal(saves.length, 1, 'the invalidation is persisted before any message arrives');
  assert.match(logs.join('\n'), /invalidated 3 group verdict/);
});

test('after internalTenants gains a tenant, the same sender is judged by the new list on the next message', async () => {
  const f = fixture({ external: false, tenants: ['own'] });
  await f.run('partner');
  assert.equal(f.policy().internal, false, 'partner is outside the old list');

  // Hot reload: the new list arrives while the process keeps running.
  f.config.internalTenants = ['own', 'partner'];
  f.state.response = { success: true, chat: { external: false } };
  await f.run('partner');
  assert.equal(f.policy().internal, true, 'the next message uses the new configuration');
  assert.equal(f.state.calls, 2, 'the invalidated verdict is re-queried, not trusted');
});

test('a config change does not reopen a group with a demoted manual internal until a lookup succeeds', async () => {
  const f = fixture({ external: true, group: { internal: true } });
  await f.run();
  assert.equal(f.policy().internal, false);
  f.config.internalTenants = ['own', 'partner'];
  f.state.response = { success: false };
  await f.run('own');
  assert.equal(f.policy().internal, false, 'a failed re-judge after a config change stays external');
});

test('removing internalTenants falls back to the bot tenant key and voids the cache', async () => {
  const f = fixture({ external: false, tenants: ['own', 'partner'] });
  await f.run('partner');
  assert.equal(f.policy().internal, true);
  delete f.config.internalTenants;
  f.state.response = { success: true, chat: { external: false } };
  await f.run('partner');
  assert.equal(f.policy().internal, false, 'partner is outside the bot tenant now');
});

test('an unchanged configuration does not invalidate anything', async () => {
  const f = fixture({ external: false });
  await f.run();
  const before = JSON.stringify(f.group());
  await f.run();
  assert.equal(JSON.stringify(f.group()), before);
  assert.equal(f.state.calls, 1);
});

// ---------------------------------------------------------------------------
// 4. Lookup failure: external, with a reason a person can read.
// ---------------------------------------------------------------------------
test('a permission-denied lookup is external and records the scope that is missing', async () => {
  const f = fixture({ external: false });
  f.state.response = { success: false, code: 230027, message: 'Lack of necessary permissions, ext=need scope: im:chat:readonly' };
  await f.run();
  assert.equal(f.policy().internal, false);
  const evidence = groupEvidence(f.group());
  assert.equal(evidence.reason, 'permission_denied');
  assert.equal(evidence.lastError.reason, 'permission_denied');
  assert.deepEqual(evidence.lastError.scopes, ['im:chat:readonly']);
  assert.match(f.state.logs.join('\n'), /permission_denied/, 'the reason is logged, not just the verdict');
});

test('a network error is external and is not reported as a permission problem', async () => {
  const f = fixture({ external: false });
  f.state.response = { success: false, message: 'chat info timeout' };
  await f.run();
  assert.equal(f.policy().internal, false);
  const evidence = groupEvidence(f.group());
  assert.equal(evidence.reason, 'refresh_failed', 'the pre-existing reason name is kept for a generic failure');
  assert.deepEqual(evidence.lastError.scopes, []);
});

// ---------------------------------------------------------------------------
// 5. Race: a verdict computed before the member event must not win afterwards.
// ---------------------------------------------------------------------------
test('a classification in flight when an outside member joins cannot reopen the group', async () => {
  const f = fixture({ external: false });
  let finishLookup;
  f.state.pending = new Promise(resolve => { finishLookup = resolve; });
  const inflight = f.run();                       // lookup starts, says nothing yet
  const event = f.member('added', [outsideUser]); // event lands while it is in flight
  finishLookup({ success: true, chat: { external: false } });
  await Promise.all([inflight, event]);
  assert.equal(f.policy().internal, false, 'the older lookup must not overwrite the newer event');
  assert.equal(groupEvidence(f.group()).reason, 'member_joined_external');
});

test('an external-sender observation in flight when the member leaves cannot reopen the group', async () => {
  const f = fixture({ external: false });
  let finishLookup;
  f.state.pending = new Promise(resolve => { finishLookup = resolve; });
  const inflight = f.run('outside');   // external sender, query in flight
  const event = f.member('deleted', [outsideUser]);
  f.state.pending = null;
  f.state.response = { success: true, chat: { external: false } };
  finishLookup({ success: true, chat: { external: false } });
  await Promise.all([inflight, event]);
  assert.equal(f.policy().internal, true, 'the departure is the newer fact; the stale external-sender query is dropped');
});

test('two member events in a row: the last one decides', async () => {
  const f = fixture({ external: false });
  await f.run();
  let finishFirst;
  f.state.pending = new Promise(resolve => { finishFirst = resolve; });
  const joined = f.member('added', [outsideUser]);
  f.state.pending = null;
  f.state.response = { success: true, chat: { external: false } };
  const left = f.member('deleted', [outsideUser]);
  finishFirst({ success: true, chat: { external: false } });
  await Promise.all([joined, left]);
  assert.equal(f.policy().internal, true, 'the newest event (the departure) owns the verdict');
});

// ---------------------------------------------------------------------------
// 6. Status file content for the re-judged groups.
// ---------------------------------------------------------------------------
test('groupStatus reports the rejudged verdict with its reason and source', async () => {
  const f = fixture({ external: false });
  await f.run();
  await f.member('added', [outsideUser]);
  const status = groupStatus('oc_1', f.config, { evidenceFor: groupEvidence });
  assert.equal(status.internal, false);
  assert.equal(status.reason, 'member_joined_external');
  assert.equal(status.source, 'member_event');
  assert.equal(status.degraded, false, 'an outside member IS evidence, not a gap in evidence');
  assert.equal(status.manual_internal, null);
  assert.equal(status.last_error.reason, 'member_joined_external');
  const built = buildStatus({ config: f.config, groups: [status], now: () => 1_700_000_000_000 });
  assert.equal(built.updated_at, '2023-11-14T22:13:20.000Z');
  assert.equal(built.groups[0].chat_id, 'oc_1');
});

// ---------------------------------------------------------------------------
// 7. Leader review 1: invalidation must bump the epoch of every group it voids.
//    Otherwise a lookup that was already waiting under the old tenant list has
//    the same epoch when it resolves and writes its stale answer back.
// ---------------------------------------------------------------------------
test('a config change invalidates a lookup that was already in flight', async () => {
  const f = fixture({ external: false, tenants: ['own'] });
  await f.run();
  assert.equal(f.policy().internal, true);

  // Let the cache expire so the next message really starts a lookup, then hold
  // it open: this is the "already waiting under the old configuration" case.
  f.state.time += 24 * 60 * 60 * 1000 + 1;
  let finishOld;
  f.state.pending = new Promise(resolve => { finishOld = resolve; });
  const inflight = f.run('own');
  await Promise.resolve();
  // The configuration changes while that lookup is pending; the new list makes
  // this group external for the same sender.
  f.config.internalTenants = ['partner'];
  assert.equal(f.classify.syncConfig(f.config), true, 'the watcher invalidates while the lookup hangs');
  assert.equal(f.policy().internal, false, 'conservative immediately, before anything awaits');

  // The old lookup now resolves saying "internal". It must be discarded.
  f.state.pending = null;
  f.state.response = { success: true, chat: { external: false } };
  finishOld({ success: true, chat: { external: false } });
  await inflight;
  assert.equal(f.policy().internal, false, 'the pre-change verdict must not be written back');
  assert.equal(f.group().autoClassification.invalidatedReason, 'config_changed');
});

test('a second message after the invalidation re-judges under the new configuration', async () => {
  const f = fixture({ external: false, tenants: ['own'] });
  await f.run();
  f.state.time += 24 * 60 * 60 * 1000 + 1;
  let finishOld;
  f.state.pending = new Promise(resolve => { finishOld = resolve; });
  const inflight = f.run('own');
  await Promise.resolve();
  f.config.internalTenants = ['partner'];
  f.classify.syncConfig(f.config);
  finishOld({ success: true, chat: { external: false } });
  await inflight;

  f.state.response = { success: true, chat: { external: false } };
  const before = f.state.calls;
  await f.run('partner');
  assert.equal(f.state.calls, before + 1, 'the invalidated group is looked up again');
  assert.equal(f.policy().internal, true, 'the new configuration decides the verdict');
});

// ---------------------------------------------------------------------------
// 8. Leader review 2: the persisted fields must be conservative for BOTH
//    readers during the async window. `effectiveInternal` and the core gate
//    (`policyFor`) must agree, or already-queued unmentioned rows leak.
// ---------------------------------------------------------------------------
function corePolicyFor() {
  const core = process.env.ARCH2_CORE_DIR;
  if (!core) return null;
  const source = fs.readFileSync(`${core}/skills/comm-bridge/scripts/c4-gate.js`, 'utf8');
  const start = source.indexOf('export function policyFor');
  const end = source.indexOf('\n}\n', start) + 3;
  const ctx = vm.createContext({ env: {} });
  vm.runInContext(`${source.slice(start, end).replace('export ', '')}\nthis.policyFor = policyFor;`, ctx);
  return ctx.policyFor;
}

test('a manual internal=true is conservative for the core gate for the whole async window', async () => {
  const f = fixture({ external: false, group: { internal: true } });
  await f.run();
  assert.equal(f.policy().gateMode, 'auto');

  // Invalidate (as a member event or config change does) and inspect the
  // persisted fields before any lookup resolves.
  let finishLookup;
  f.state.pending = new Promise(resolve => { finishLookup = resolve; });
  const event = f.member('added', [insideUser]);   // any membership change voids
  assert.equal(f.group().internal, false, 'group.internal must be false while re-judging (core reads it first)');
  assert.equal(f.policy().internal, false);
  assert.equal(f.policy().gateMode, 'observe');
  assert.equal(f.group().internalDemoted.reason, 'member_joined', 'the manual intent is kept for restore');

  const policy = corePolicyFor();
  if (policy) {
    const core = policy({ chat_id: 'oc_1', endpoint_id: 'oc_1|type=group', sender_id: 'ou_person', content: 'hi' },
      { groups: { oc_1: f.group() } }, {});
    assert.equal(core.internal, false, 'core policyFor must agree with the component');
    assert.equal(core.mode, 'observe', 'an unmentioned queued message must not be answered');
  }

  f.state.pending = null;
  f.state.response = { success: true, chat: { external: false } };
  finishLookup({ success: true, chat: { external: false } });
  await event;
  assert.equal(f.group().internal, true, 'the manual claim comes back after verification');
  assert.equal(f.group().internalDemoted, undefined);
});

test('a config change is conservative for the core gate and for effectiveInternal', async () => {
  const f = fixture({ external: false, group: { internal: true }, tenants: ['own'] });
  await f.run();
  f.config.internalTenants = ['own', 'partner'];
  f.classify.syncConfig(f.config);
  assert.equal(effectiveInternal(f.group()), false);
  assert.equal(f.group().internal, false);
  const policy = corePolicyFor();
  if (policy) {
    const core = policy({ chat_id: 'oc_1', endpoint_id: 'oc_1|type=group', sender_id: 'ou_person', content: 'x' },
      { groups: { oc_1: f.group() } }, {});
    assert.equal(core.internal, false);
    assert.equal(core.mode, 'observe');
  }
});

test('invalidateGroupEvidence leaves both readers conservative and keeps the manual intent', () => {
  const { invalidateGroupEvidence } = classificationModule;
  const group = { internal: true, autoClassification: { internal: true, checkedAt: 5, retry: false, source: 'chat_info' } };
  invalidateGroupEvidence(group, 'member_left', 10);
  assert.equal(group.internal, false);
  assert.equal(group.internalDemoted.reason, 'member_left');
  assert.equal(effectiveInternal(group), false);
  assert.equal(group.autoClassification.retry, true);
  assert.equal(group.autoClassification.internal, false);
  assert.equal(group.autoClassification.lastKnownInternal, true);
});
