import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGroupClassifier, GROUP_CLASSIFICATION_TTL_MS } from '../src/lib/group-classification.js';
import { groupGatePolicy } from '../src/lib/c4-ingress.js';
function fixture({ external = false, group = {}, result } = {}) {
  const config = { bot: { tenant_key: 'our_tenant' }, groups: { oc_1: { mode: 'smart', ...group } } };
  let calls = 0; let saves = 0; let time = 100;
  let response = result || { success: true, chat: { external } };
  const classify = createGroupClassifier({ getChatInfo: async id => { assert.equal(id, 'oc_1'); calls++; return response; }, saveConfig: () => { saves++; }, now: () => time });
  return { config, run: (senderTenantKey = 'our_tenant') => classify({ config, chatId: 'oc_1', senderTenantKey }),
    policy: () => groupGatePolicy(config, 'oc_1'), calls: () => calls, saves: () => saves,
    advance: ms => { time += ms; }, response: value => { response = value; } };
}
test('internal group automatically uses auto from chat external=false and persists cache', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.policy(), { internal: true, gateMode: 'auto' });
  assert.equal(f.config.groups.oc_1.internal, undefined, 'automatic evidence never becomes a manual override');
  assert.equal(f.config.groups.oc_1.autoClassification.source, 'chat_info');
  assert.ok(f.saves() > 0);
});
test('external identity still uses contextual model judgement', async () => {
  const f = fixture({ external: true }); await f.run();
  assert.deepEqual(f.policy(), { internal: false, gateMode: 'auto' });
});
test('external sender updates identity while preserving model judgement', async () => {
  const f = fixture(); await f.run(); await f.run('other_tenant');
  assert.deepEqual(f.policy(), { internal: false, gateMode: 'auto' });
  assert.equal(f.config.groups.oc_1.autoClassification.source, 'external_sender');
  assert.equal(f.calls(), 1, 'fresh cache does not delay sender fallback with a query');
  await f.run(); assert.equal(f.policy().gateMode, 'auto');
});
test('query failure without cache stays external and retries on next message', async () => {
  const f = fixture({ result: { success: false } }); await f.run();
  assert.equal(f.policy().gateMode, 'auto'); assert.equal(f.calls(), 1);
  f.response({ success: true, chat: { external: false } }); await f.run();
  assert.equal(f.calls(), 2); assert.equal(f.policy().gateMode, 'auto');
});
test('successful cache refreshes after 24 hours; a failed refresh degrades instead of trusting the cache', async () => {
  // Card F / R1 item 9 changed this expectation: an expired cache whose refresh
  // fails must invalidate identity; relevance judgement remains enabled.
  const f = fixture(); await f.run(); await f.run(); assert.equal(f.calls(), 1);
  f.advance(GROUP_CLASSIFICATION_TTL_MS); f.response({ success: false }); await f.run();
  assert.equal(f.calls(), 2); assert.equal(f.policy().gateMode, 'auto');
  f.response({ success: true, chat: { external: false } }); await f.run();
  assert.equal(f.calls(), 3); assert.equal(f.policy().gateMode, 'auto', 'a successful refresh restores auto');
});
test('manual internal and gateMode can only make a group more conservative', async () => {
  // Card F / R1 item 9: external evidence outranks a manual internal=true. The
  // stricter manual gateMode still applies.
  const f = fixture({ external: true, group: { internal: true, gateMode: 'off' } });
  // A manual setting no longer suppresses the evidence lookup: one query per TTL
  // per group, so the component can still learn that the group became external.
  await f.run('outside'); assert.equal(f.calls(), 1);
  assert.deepEqual(f.policy(), { internal: false, gateMode: 'off' });
  const manualExternal = fixture({ group: { internal: false } }); await manualExternal.run();
  assert.equal(manualExternal.calls(), 1, 'a manual false still refreshes, it just never opens the group'); assert.equal(manualExternal.policy().gateMode, 'auto');
  const observe = fixture({ group: { gateMode: 'observe' } }); await observe.run();
  assert.deepEqual(observe.policy(), { internal: true, gateMode: 'observe' });
});
test('internalTenants defaults to own tenant and explicit list can include partner tenants', async () => {
  const f = fixture(); f.config.internalTenants = ['our_tenant', 'partner'];
  await f.run('partner'); assert.equal(f.policy().gateMode, 'auto');
  await f.run('unknown'); assert.equal(f.policy().gateMode, 'auto');
});
test('missing external field is a failed classification rather than assuming internal', async () => {
  const f = fixture({ result: { success: true, chat: {} } }); await f.run();
  assert.equal(f.policy().gateMode, 'auto'); assert.equal(f.config.groups.oc_1.autoClassification.retry, true);
});
test('external sender evidence wins over concurrent optimistic chat lookup', async () => {
  const config = { bot: { tenant_key: 'own' }, groups: { oc_1: {} } };
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const classify = createGroupClassifier({ getChatInfo: () => result, saveConfig() {} });
  const first = classify({ config, chatId: 'oc_1', senderTenantKey: 'own' });
  const external = classify({ config, chatId: 'oc_1', senderTenantKey: 'outside' });
  assert.equal(groupGatePolicy(config, 'oc_1').gateMode, 'auto');
  finish({ success: true, chat: { external: false } }); await Promise.all([first, external]);
  assert.equal(groupGatePolicy(config, 'oc_1').gateMode, 'auto');
});
test('chat adapter uses existing client im.chat.get and preserves external boolean', async () => {
  const source = fs.readFileSync(new URL('../src/lib/chat.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const context = { getClient: () => ({ im: { chat: { get: async args => {
    assert.equal(args.path.chat_id, 'oc_1'); return { code: 0, data: { external: false } };
  } } } }) };
  vm.createContext(context); vm.runInContext(source, context);
  assert.equal((await context.getChatInfo('oc_1')).chat.external, false);
});
