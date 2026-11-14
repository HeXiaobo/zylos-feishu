// Card F / review item 9: external evidence always wins.
//
// The bug: a group was classified internal once, the result cached for 24 hours,
// and a failed refresh kept `internal=true`. A manual `internal=true` also
// overrode the sender's tenant evidence. Either way an unmentioned message in a
// group that had since gained outside members could reach the front desk and be
// answered, breaking "external groups only answer @mentions".
//
// Rule under test: manual configuration may only make a group MORE conservative.
// It can never cancel external evidence — neither an outside sender tenant nor
// `chat.external === true`, nor stale cache whose refresh failed.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGroupClassifier, effectiveInternal, GROUP_CLASSIFICATION_TTL_MS } from '../src/lib/group-classification.js';
import { groupGatePolicy } from '../src/lib/c4-ingress.js';

// Imported lazily so a missing export fails the assertions that need it instead
// of breaking the whole file's import.
const classification = await import('../src/lib/group-classification.js');
function groupEvidence(group) {
  assert.equal(typeof classification.groupEvidence, 'function', 'groupEvidence must report the evidence state');
  return classification.groupEvidence(group);
}

function fixture({ external = false, group, result, clock = 1000 } = {}) {
  const config = { bot: { tenant_key: 'our_tenant' }, groups: { oc_1: { mode: 'smart', ...group } } };
  const state = { calls: 0, saves: 0, time: clock, response: result || { success: true, chat: { external } } };
  const classify = createGroupClassifier({
    getChatInfo: async id => { assert.equal(id, 'oc_1'); state.calls++; return state.response; },
    saveConfig: () => { state.saves++; },
    now: () => state.time,
  });
  return {
    config, state,
    run: (senderTenantKey = 'our_tenant') => classify({ config, chatId: 'oc_1', senderTenantKey }),
    policy: () => groupGatePolicy(config, 'oc_1'),
    // The mode the front desk actually acts on: an external group must never
    // deliver an unmentioned message.
    unmentionedDelivers: () => {
      const { internal, gateMode } = groupGatePolicy(config, 'oc_1');
      return internal === true && gateMode === 'auto';
    },
  };
}

// ---------------------------------------------------------------------------
// A. An external sender wins over a manual internal=true.
// ---------------------------------------------------------------------------
test('an external sender overrides a manual internal=true', async () => {
  const f = fixture({ group: { internal: true } });
  await f.run('outside_tenant');
  assert.equal(effectiveInternal(f.config.groups.oc_1), false, 'manual true cannot certify an outside sender');
  assert.equal(f.unmentionedDelivers(), false, 'an outside sender must never look like an internal group');
  assert.equal(f.policy().gateMode, 'observe');
});

test('an external sender overrides manual internal=true and a manual gateMode=auto', async () => {
  const f = fixture({ group: { internal: true, gateMode: 'auto' } });
  await f.run('outside_tenant');
  assert.equal(f.policy().internal, false);
  assert.equal(f.policy().gateMode, 'observe', 'auto is not a way around external evidence');
});

test('an external sender keeps the group observe after it reverts to internal senders', async () => {
  const f = fixture({ group: { internal: true } });
  await f.run('outside_tenant');
  await f.run('our_tenant');
  assert.equal(f.policy().gateMode, 'observe', 'the downgrade is sticky until chat info says otherwise');
});

// ---------------------------------------------------------------------------
// B. chat.external === true overrides a manual internal=true.
// ---------------------------------------------------------------------------
test('chat.external=true overrides a manual internal=true', async () => {
  const f = fixture({ external: true, group: { internal: true } });
  await f.run();
  assert.equal(f.policy().internal, false, 'the API says external, the operator said internal: external wins');
  assert.equal(f.policy().gateMode, 'observe');
});

test('chat.external=false still lets a manual internal=false make the group more conservative', async () => {
  const f = fixture({ external: false, group: { internal: false } });
  await f.run();
  assert.equal(f.policy().internal, false, 'manual configuration may restrict');
  assert.equal(f.policy().gateMode, 'observe');
});

test('chat.external=true with manual gateMode=off stays more conservative, never more open', async () => {
  const f = fixture({ external: true, group: { internal: true, gateMode: 'off' } });
  await f.run();
  assert.equal(f.policy().internal, false);
  assert.equal(f.policy().gateMode, 'off', 'the stricter manual mode survives');
});

// ---------------------------------------------------------------------------
// C. Expired cache whose refresh fails degrades to observe.
// ---------------------------------------------------------------------------
test('an expired cache whose refresh fails degrades to observe', async () => {
  const f = fixture({ external: false });
  await f.run();
  assert.equal(f.policy().internal, true, 'a fresh successful lookup may enable auto');
  f.state.time += GROUP_CLASSIFICATION_TTL_MS + 1;
  f.state.response = { success: false };
  await f.run();
  assert.equal(f.policy().internal, false, 'stale evidence is not evidence');
  assert.equal(f.policy().gateMode, 'observe');
  assert.equal(f.unmentionedDelivers(), false);
});

test('a failed refresh with a manual internal=true still degrades to observe', async () => {
  const f = fixture({ group: { internal: true }, result: { success: false } });
  await f.run();
  assert.equal(f.policy().gateMode, 'observe', 'unverifiable is not internal');
});

test('a missing external field counts as a failed refresh, never as internal', async () => {
  const f = fixture({ group: { internal: true }, result: { success: true, chat: {} } });
  await f.run();
  assert.equal(f.policy().gateMode, 'observe');
});

test('the next successful refresh after a failure restores auto', async () => {
  const f = fixture({ group: { internal: true }, result: { success: false } });
  await f.run();
  assert.equal(f.policy().gateMode, 'observe');
  f.state.response = { success: true, chat: { external: false } };
  await f.run();
  assert.equal(f.policy().gateMode, 'auto', 'a successful lookup clears the degraded state');
});

test('a successful cache stays valid until it expires', async () => {
  const f = fixture({ external: false });
  await f.run();
  f.state.time += GROUP_CLASSIFICATION_TTL_MS - 1;
  await f.run();
  assert.equal(f.state.calls, 1, 'no refresh inside the TTL');
  assert.equal(f.policy().gateMode, 'auto');
});

test('a cached external result stays observe across restarts', () => {
  const group = { autoClassification: { internal: false, checkedAt: 1, retry: false, source: 'chat_info' } };
  assert.equal(effectiveInternal(group), false);
  assert.equal(groupEvidence(group).degraded, false, 'a fresh external result is evidence, not degradation');
});

// ---------------------------------------------------------------------------
// D. The degraded state is reported, so an operator can see why.
// ---------------------------------------------------------------------------
test('groupEvidence reports external, degraded and fresh states', async () => {
  const external = fixture({ external: true });
  await external.run();
  assert.deepEqual(
    { external: groupEvidence(external.config.groups.oc_1).external, degraded: groupEvidence(external.config.groups.oc_1).degraded },
    { external: true, degraded: false },
  );

  const degraded = fixture({ external: false });
  await degraded.run();
  degraded.state.time += GROUP_CLASSIFICATION_TTL_MS + 1;
  degraded.state.response = { success: false };
  await degraded.run();
  assert.equal(groupEvidence(degraded.config.groups.oc_1).degraded, true, 'a failed refresh is visible to the operator');
  assert.equal(groupEvidence(degraded.config.groups.oc_1).external, null);
});

// ---------------------------------------------------------------------------
// E. The gate consumer reads the same rule.
// ---------------------------------------------------------------------------
test('the classifier normalizes legacy unsafe cache rows', async () => {
  const { normalizeGroupEvidence } = classification;
  assert.equal(typeof normalizeGroupEvidence, 'function', 'legacy rows must be normalized before any reader sees them');
  const now = 5_000_000_000_000;
  const stale = { groups: { oc_1: { mode: 'smart',
    internal: true,
    autoClassification: { internal: true, checkedAt: now - GROUP_CLASSIFICATION_TTL_MS - 1, retry: false } } } };
  assert.equal(normalizeGroupEvidence(stale, now), true);
  assert.equal(effectiveInternal(stale.groups.oc_1), false);
  assert.equal(groupGatePolicy(stale, 'oc_1').gateMode, 'observe');
  assert.equal(stale.groups.oc_1.internalDemoted.reason, 'stale_cache');
  assert.equal(stale.groups.oc_1.autoClassification.lastKnownInternal, true, 'the raw value is kept for reporting');

  const failed = { groups: { oc_1: { autoClassification: { internal: true, checkedAt: now, retry: true } } } };
  assert.equal(normalizeGroupEvidence(failed, now), true);
  assert.equal(effectiveInternal(failed.groups.oc_1), false);

  const healthy = { groups: { oc_1: { autoClassification: { internal: true, checkedAt: now, retry: false } } } };
  assert.equal(normalizeGroupEvidence(healthy, now), false, 'fresh evidence is left alone');
  assert.equal(effectiveInternal(healthy.groups.oc_1), true);
});

test('core c4-gate policy agrees with the component for every evidence state', async () => {
  const core = process.env.ARCH2_CORE_DIR;
  if (!core) return; // cross-repository check is opt-in, same as c4-roundtrip.test.js
  const source = fs.readFileSync(`${core}/skills/comm-bridge/scripts/c4-gate.js`, 'utf8');
  const start = source.indexOf('export function policyFor');
  const end = source.indexOf('\n}\n', start) + 3;
  const ctx = vm.createContext({ env: {} });
  vm.runInContext(`${source.slice(start, end).replace('export ', '')}\nthis.policyFor = policyFor;`, ctx);
  const now = Date.now();
  for (const group of [
    {},
    { internal: true },
    { internal: false },
    { internal: true, gateMode: 'auto' },
    { internal: false, gateMode: 'auto' },
    { internal: true, gateMode: 'off' },
    { autoClassification: { internal: true, checkedAt: now, retry: false } },
    { autoClassification: { internal: false, checkedAt: now, retry: false } },
    // Unsafe leftovers from the pre-fix component: the normalizer must make the
    // persisted fields safe for the gate, which cannot run this logic itself.
    { autoClassification: { internal: true, checkedAt: now, retry: true } },
    { internal: true, autoClassification: { internal: true, checkedAt: 1, retry: false } },
    { internal: true, autoClassification: { internal: true, checkedAt: now, retry: true } },
  ]) {
    const config = { groups: { oc_1: { mode: 'smart', ...group } } };
    const normalized = classification.normalizeGroupEvidence(config, now);
    const component = groupGatePolicy(config, 'oc_1');
    const corePolicy = ctx.policyFor({ chat_id: 'oc_1', endpoint_id: 'oc_1|type=group', sender_id: 'ou_x', content: 'hi' }, config, {});
    assert.equal(corePolicy.internal, component.internal, `internal for ${JSON.stringify(group)} (normalized=${normalized})`);
    assert.equal(corePolicy.mode, component.gateMode, `mode for ${JSON.stringify(group)} (normalized=${normalized})`);
  }
});

// ---------------------------------------------------------------------------
// F. The running component must not read a raw manual override directly.
// ---------------------------------------------------------------------------
test('the handler resolves internal through the evidence-aware helper', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /groupGatePolicy\(config, chatId\)/, 'the group path must use the shared policy');
  assert.ok(!/group\.internal\s*(===|!==)/.test(source), 'no direct comparison against the raw manual flag');
});

// ---------------------------------------------------------------------------
// G. Raw, un-normalized state must still be read conservatively by the policy.
//    Callers that skip normalizeGroupEvidence (a fresh process mid-upgrade, a
//    test harness) must not be able to open a group by accident.
// ---------------------------------------------------------------------------
test('the policy alone already refuses a failed refresh', () => {
  const now = Date.now();
  const failed = { groups: { oc_1: { mode: 'smart', internal: true,
    autoClassification: { internal: true, checkedAt: now, retry: true } } } };
  assert.equal(groupGatePolicy(failed, 'oc_1').internal, false, 'retry=true is never internal');
  assert.equal(groupGatePolicy(failed, 'oc_1').gateMode, 'observe');

  // A stale-but-successful cache is not demoted by the reader: the classifier
  // refreshes it before the policy is read, and startup normalization handles
  // rows left behind by an older process.
  const legacy = { groups: { oc_1: { mode: 'smart', internal: true,
    autoClassification: { internal: true, checkedAt: 1, retry: false } } } };
  assert.equal(classification.normalizeGroupEvidence(legacy, Date.now()), true);
  assert.equal(groupGatePolicy(legacy, 'oc_1').internal, false, 'an ancient cache is not evidence');
});

test('normalizing twice changes nothing the second time', () => {
  const now = Date.now();
  const config = { groups: { oc_1: { mode: 'smart', internal: true,
    autoClassification: { internal: true, checkedAt: 1, retry: false } } } };
  assert.equal(classification.normalizeGroupEvidence(config, now), true);
  const snapshot = JSON.parse(JSON.stringify(config));
  assert.equal(classification.normalizeGroupEvidence(config, now), false);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), snapshot);
});

test('a demoted operator setting is restored by a later successful lookup', async () => {
  const f = fixture({ group: { internal: true }, result: { success: false } });
  await f.run();
  assert.equal(f.config.groups.oc_1.internal, false);
  assert.equal(f.config.groups.oc_1.internalDemoted.reason, 'refresh_failed');
  f.state.response = { success: true, chat: { external: false } };
  await f.run();
  assert.equal(f.config.groups.oc_1.internal, true, 'the operator intent comes back once it is verified');
  assert.equal(f.config.groups.oc_1.internalDemoted, undefined);
  assert.equal(f.policy().gateMode, 'auto');
});

test('a demoted operator setting is NOT restored when the group really is external', async () => {
  const f = fixture({ group: { internal: true }, result: { success: false } });
  await f.run();
  f.state.response = { success: true, chat: { external: true } };
  await f.run();
  assert.equal(f.config.groups.oc_1.internal, false);
  assert.equal(f.policy().gateMode, 'observe');
});
