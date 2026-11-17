// Issue #177: a group's internal/external verdict must be able to recognise
// colleagues by person, not only by tenant.
//
// Why: three-intelligences has no Feishu tenant of its own (it runs under
// 知外文化's), and some colleagues use personal Feishu accounts, each of which is
// its own tenant. So the company's own groups look "external" in Feishu, and the
// bot only answers @mentions there.
//
// Rule under test:
//   every human member of the group is either in an internal tenant or in
//   `internalMembers`; bot members do not take part; anything unknowable stays
//   external.
//
// These cases are constructed. No Feishu API is called: `getChatInfo` and
// `listChatMembers` are stubs. `listChatMembers` must be the real
// `src/lib/chat.js` export, with the caller picking `open_id` as member id type.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import * as classification from '../src/lib/group-classification.js';
import { createGroupClassifier } from '../src/lib/group-classification.js';
import { groupGatePolicy } from '../src/lib/c4-ingress.js';
import { buildStatus, groupStatus } from '../src/lib/status-file.js';

const TTL = classification.GROUP_CLASSIFICATION_TTL_MS;

const human = (id, tenant, extra = {}) => ({ name: id, tenantKey: tenant, memberId: id, memberType: 'open_id', ...extra });
const bot = (id, tenant, extra = {}) => ({ name: id, tenantKey: tenant, memberId: id, memberType: 'open_id', isBot: true, ...extra });

/**
 * A group with three members: one colleague from the bot's own tenant, one
 * colleague on a personal account (own tenant `personal_b`), and the bot.
 */
const PERSONAL_ACCOUNT = 'personal_b';

function fixture({
  chatId = 'oc_1',
  external = false,
  config = {},
  members = [human('ou_own', 'own'), human('ou_personal', PERSONAL_ACCOUNT), bot('ou_bot', 'own')],
  membersResult = null,
} = {}) {
  const state = {
    calls: 0, memberCalls: 0, saves: 0, time: 1_000_000,
    response: { success: true, chat: { external } },
    memberResponse: membersResult,
    logs: [], memberArgs: [],
  };
  const cfg = {
    bot: { tenant_key: 'own' },
    internalTenants: ['own'],
    groups: { [chatId]: { mode: 'smart', ...config.group } },
    ...(config.top || {}),
  };
  if (config.internalMembers !== undefined) cfg.internalMembers = config.internalMembers;
  const classify = createGroupClassifier({
    getChatInfo: async id => { assert.equal(id, chatId); state.calls++; return state.response; },
    // The real signature the component passes: (chatId, memberIdType).
    listChatMembers: async (id, memberIdType) => {
      assert.equal(id, chatId);
      state.memberCalls++;
      state.memberArgs.push(memberIdType);
      return state.memberResponse || { success: true, members, memberCount: members.length };
    },
    saveConfig: () => { state.saves++; },
    now: () => state.time,
    log: message => state.logs.push(message),
  });
  return {
    config: cfg, state, classify,
    run: (senderTenantKey = 'own') => classify({ config: cfg, chatId, senderTenantKey, botTenantKey: 'own' }),
    member: (type, users) => classify.handleMemberEvent({ config: cfg, chatId, event: { type, users }, botTenantKey: 'own' }),
    policy: () => groupGatePolicy(cfg, chatId),
    group: () => cfg.groups[chatId],
    unmentionedDelivers: () => {
      const { internal, gateMode } = groupGatePolicy(cfg, chatId);
      return internal === true && gateMode === 'auto';
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The actual problem: a group of colleagues on personal accounts.
// ---------------------------------------------------------------------------
test('#177 a group with a personal-account colleague is external until she is named', async () => {
  // The real shape: Feishu itself calls the group external (a member's tenant is
  // not ours), and `internalTenants` cannot express her. No list → old verdict.
  const before = fixture({ external: true });
  await before.run();
  assert.equal(before.policy().internal, false,
    'without a person list the verdict is still chat.external — she is a stranger to the tenant rule');
  assert.equal(before.unmentionedDelivers(), false);

  const after = fixture({ external: true, config: { internalMembers: ['ou_personal'] } });
  await after.run();
  assert.equal(after.policy().internal, true,
    'the named colleague makes every human member inside evidence');
  assert.equal(after.policy().gateMode, 'auto');
  assert.equal(after.unmentionedDelivers(), true, 'unmentioned work is answered in our own group');
  assert.equal(after.state.memberArgs[0], 'open_id', 'members are judged by the stable open_id');
});

test('#177 one unnamed human keeps the whole group external', async () => {
  const f = fixture({
    external: false,
    config: { internalMembers: ['ou_personal'] },
    members: [human('ou_personal', PERSONAL_ACCOUNT), human('ou_stranger', 'other_corp'), bot('ou_bot', 'own')],
  });
  await f.run();
  assert.equal(f.policy().internal, false, 'one human outside both lists makes the group external');
  assert.equal(f.unmentionedDelivers(), false);
});

test('#177 a bot member never makes the group external', async () => {
  const f = fixture({
    external: false,
    config: { internalMembers: ['ou_personal'] },
    members: [human('ou_own', 'own'), human('ou_personal', PERSONAL_ACCOUNT),
      bot('ou_bot', 'own'), bot('cli_other_bot', 'vendor_tenant')],
  });
  await f.run();
  assert.equal(f.policy().internal, true, 'robot members do not take part in the verdict');
});

test('#177 an empty human roster is not internal evidence', async () => {
  const f = fixture({ external: false, config: { internalMembers: ['ou_personal'] }, members: [bot('ou_bot', 'own')] });
  await f.run();
  assert.equal(f.policy().internal, false, 'nobody to certify is not proof of an internal group');
  assert.equal(classification.groupEvidence(f.group()).lastError?.reason, 'members_empty');
});

// ---------------------------------------------------------------------------
// 2. Acceptance: empty `internalMembers` behaves exactly as before (no regression).
// ---------------------------------------------------------------------------
// The verdict of the old code = `chat.external` alone. These are the inputs the
// pre-#177 tests used, driven through the same message path, then compared to a
// member-list answer that would disagree. Equality proves membership never enters
// the verdict when the list is empty.
const BASELINE_CASES = [
  { name: 'chat says internal', external: false, members: [human('ou_a', 'own')] },
  { name: 'chat says external', external: true, members: [human('ou_a', 'own')] },
  { name: 'chat internal, members would say external', external: false, members: [human('ou_a', 'own'), human('ou_x', 'outside')] },
  { name: 'chat external, members would say internal', external: true, members: [human('ou_a', 'own')] },
  { name: 'chat internal, member lookup fails', external: false, membersResult: { success: false, message: 'boom', code: 230027 } },
];

for (const testCase of BASELINE_CASES) {
  test(`#177 with internalMembers empty, verdict equals the pre-#177 rule — ${testCase.name}`, async () => {
    for (const internalMembers of [undefined, []]) {
      const f = fixture({ external: testCase.external, config: { internalMembers }, members: testCase.members, membersResult: testCase.membersResult });
      await f.run();
      assert.equal(f.policy().internal, !testCase.external,
        `internal=${internalMembers === undefined ? 'absent' : 'empty list'} must follow chat.external only`);
      assert.equal(f.state.memberCalls, 0, 'the member list is not even queried when the list is empty');
      assert.equal(f.group().autoClassification.source, 'chat_info');
    }
  });
}

test('#177 a listed member does not excuse an outside sender when internalMembers is empty', async () => {
  const f = fixture({ external: true, config: { internalMembers: [] }, members: [human('ou_a', 'own'), human('ou_b', 'outside')] });
  await f.run('outside');
  assert.equal(f.policy().internal, false, 'sender-tenant evidence is unchanged');
});

// ---------------------------------------------------------------------------
// 3. Reference to people also counts for the sender check.
// ---------------------------------------------------------------------------
test('#177 a named colleague on a personal account is not an outside sender', async () => {
  const f = fixture({ external: false, config: { internalMembers: ['ou_personal'] } });
  await f.run(PERSONAL_ACCOUNT);
  assert.equal(f.policy().internal, true, 'her own tenant is fine because she is named');
});

// ---------------------------------------------------------------------------
// 4. Membership changes re-judge immediately.
// ---------------------------------------------------------------------------
test('#177 a stranger joining flips the group to external at once', async () => {
  const f = fixture({ config: { internalMembers: ['ou_personal'] } });
  await f.run();
  assert.equal(f.unmentionedDelivers(), true);

  // The event names a tenant outside the list; the member list still has to be
  // consulted for the person-level answer, so hold it open and check the
  // synchronous verdict.
  let finish;
  f.state.memberResponse = new Promise(resolve => { finish = resolve; });
  const event = f.member('added', [{ name: '外部', tenant_key: 'other_corp', user_id: { open_id: 'ou_stranger' } }]);
  assert.equal(f.unmentionedDelivers(), false, 'the verdict changes before the re-judge finishes');

  finish({ success: true, members: [human('ou_own', 'own'), human('ou_personal', PERSONAL_ACCOUNT),
    human('ou_stranger', 'other_corp'), bot('ou_bot', 'own')] });
  await event;
  assert.equal(f.policy().internal, false, 'the full roster proves an unnamed human is present');
  assert.equal(f.unmentionedDelivers(), false);
});

test('#177 a named colleague joining a group of strangers keeps it internal', async () => {
  const f = fixture({
    config: { internalMembers: ['ou_personal', 'ou_own'] },
    members: [human('ou_own', 'own'), human('ou_personal', PERSONAL_ACCOUNT), bot('ou_bot', 'own')],
  });
  f.state.response = { success: true, chat: { external: true } };
  await f.run();
  assert.equal(f.policy().internal, true, 'chat.external no longer decides once the roster does');

  // Someone from a personal tenant joins and is named: still internal.
  f.state.memberResponse = { success: true, members: [
    human('ou_own', 'own'), human('ou_personal', PERSONAL_ACCOUNT), human('ou_new', 'personal_c'), bot('ou_bot', 'own')] };
  f.config.internalMembers.push('ou_new');
  await f.member('added', [{ name: '新同事', tenant_key: 'personal_c', user_id: { open_id: 'ou_new' } }]);
  assert.equal(f.policy().internal, true);
  assert.equal(f.unmentionedDelivers(), true);
});

// ---------------------------------------------------------------------------
// 5. List changes void every cached verdict (acceptance item 3).
// ---------------------------------------------------------------------------
test('#177 changing internalMembers voids ALL cached verdicts and rejudges', async () => {
  const cfg = {
    bot: { tenant_key: 'own' },
    internalTenants: ['own'],
    internalMembers: [],
    groups: {
      oc_a: { mode: 'smart', autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'chat_info' } },
      oc_idle: { mode: 'smart', internal: true, autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'chat_info' } },
      oc_ext: { mode: 'smart', autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'external_sender' } },
    },
  };
  const state = { saves: 0, logs: [] };
  const classify = createGroupClassifier({
    getChatInfo: async () => ({ success: true, chat: { external: false } }),
    listChatMembers: async () => ({ success: true, members: [human('ou_own', 'own')] }),
    saveConfig: () => { state.saves++; },
    now: () => 1_000_000,
    log: message => state.logs.push(message),
  });
  // Prime the fingerprint with the old list.
  await classify({ config: cfg, chatId: 'oc_a', senderTenantKey: 'own', botTenantKey: 'own' });

  cfg.internalMembers = ['ou_personal'];
  assert.equal(classify.syncConfig(cfg), true, 'the list is part of what "internal" means');

  for (const chatId of ['oc_a', 'oc_idle', 'oc_ext']) {
    assert.equal(cfg.groups[chatId].autoClassification.invalidatedReason, 'config_changed', `${chatId} is voided too`);
    assert.equal(cfg.groups[chatId].autoClassification.retry, true);
    assert.equal(classification.effectiveInternal(cfg.groups[chatId]), false, `${chatId} stays conservative`);
  }
  assert.equal(state.saves, 1, 'the invalidation is persisted before the next message');
  assert.match(state.logs.join('\n'), /internal tenant\/member list changed/);
});

test('#177 a reordered or duplicated list is not a change; adding a person is', () => {
  const cfg = {
    bot: { tenant_key: 'own' }, internalTenants: ['own', 'partner'], internalMembers: ['ou_a', 'ou_b'],
    groups: { oc_1: { mode: 'smart', autoClassification: { internal: true, checkedAt: 1_000_000, retry: false, source: 'chat_info' } } },
  };
  const classify = createGroupClassifier({ getChatInfo: async () => ({ success: true }), listChatMembers: async () => ({ success: true, members: [] }), saveConfig() {}, now: () => 1_000_000 });
  classify.syncConfig(cfg);
  cfg.internalMembers = ['ou_b', 'ou_a'];
  assert.equal(classify.syncConfig(cfg), false, 'order does not change the meaning');
  cfg.internalMembers = ['ou_a', 'ou_b', 'ou_c'];
  assert.equal(classify.syncConfig(cfg), true);
});

// ---------------------------------------------------------------------------
// 6. Nobody-to-ask is external, with the reason recorded.
// ---------------------------------------------------------------------------
const lookupFailures = [
  { name: 'permission denied', result: { success: false, message: 'Lack of necessary permissions, ext=need scope: im:chat.members:readonly', code: 230027 }, reason: 'permission_denied' },
  { name: 'plain failure', result: { success: false, message: 'Failed to list members: system error', code: 500 }, reason: 'refresh_failed' },
  { name: 'thrown', thrown: true, reason: 'refresh_failed' },
];

for (const failure of lookupFailures) {
  test(`#177 member lookup failure is external with a reason — ${failure.name}`, async () => {
    const cfg = {
      bot: { tenant_key: 'own' }, internalTenants: ['own'], internalMembers: ['ou_anyone'],
      groups: { oc_1: { mode: 'smart' } },
    };
    const classify = createGroupClassifier({
      getChatInfo: async () => ({ success: true, chat: { external: false } }),
      listChatMembers: async () => { if (failure.thrown) throw new Error('socket hang up'); return failure.result; },
      saveConfig() {},
      now: () => 1_000_000,
    });
    await classify({ config: cfg, chatId: 'oc_1', senderTenantKey: 'own', botTenantKey: 'own' });
    const group = cfg.groups.oc_1;
    assert.equal(groupGatePolicy(cfg, 'oc_1').internal, false, 'no roster, no internal verdict');
    const evidence = classification.groupEvidence(group);
    assert.equal(evidence.reason, failure.reason, 'the reason is readable in status.json');
    assert.equal(evidence.lastError?.reason, failure.reason);
  });
}

test('#177 member lookup failure names the missing scope in status', async () => {
  const cfg = { bot: { tenant_key: 'own' }, internalTenants: ['own'], internalMembers: ['ou_x'], groups: { oc_1: { mode: 'smart' } } };
  const classify = createGroupClassifier({
    getChatInfo: async () => ({ success: true, chat: { external: false } }),
    listChatMembers: async () => ({ success: false, message: 'Lack of necessary permissions, ext=need scope: im:chat.members:readonly', code: 230027 }),
    saveConfig() {}, now: () => 1_000_000,
  });
  await classify({ config: cfg, chatId: 'oc_1', senderTenantKey: 'own', botTenantKey: 'own' });
  const status = groupStatus('oc_1', cfg, { evidenceFor: classification.groupEvidence });
  assert.equal(status.source, 'member_list');
  assert.equal(status.reason, 'permission_denied');
  assert.deepEqual(status.last_error.scopes, ['im:chat.members:readonly']);
  assert.equal(buildStatus({ config: cfg, groups: [status] }).internalMembers.length, 1, 'the list is visible in status');
});

test('#177 a member lookup that never answers times out as external', async () => {
  const cfg = { bot: { tenant_key: 'own' }, internalTenants: ['own'], internalMembers: ['ou_x'], groups: { oc_1: { mode: 'smart' } } };
  const classify = createGroupClassifier({
    getChatInfo: async () => ({ success: true, chat: { external: false } }),
    listChatMembers: () => new Promise(() => {}),
    saveConfig() {}, now: () => 1_000_000, timeoutMs: 20,
  });
  await classify({ config: cfg, chatId: 'oc_1', senderTenantKey: 'own', botTenantKey: 'own' });
  assert.equal(groupGatePolicy(cfg, 'oc_1').internal, false);
  assert.equal(classification.groupEvidence(cfg.groups.oc_1).reason, 'refresh_failed');
});

// ---------------------------------------------------------------------------
// 7. Wiring: the component passes the real listChatMembers and the id type.
// ---------------------------------------------------------------------------
test('#177 index.js injects listChatMembers with the open_id member id type', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('const classifyGroup = createGroupClassifier({');
  assert.notEqual(start, -1, 'the classifier is created in index.js');
  const end = source.indexOf('});', start);
  const wiring = source.slice(start, end);
  assert.match(wiring, /getChatInfo,/, 'chat info still wired');
  assert.match(wiring, /listChatMembers/, 'the member list is wired');
  assert.match(wiring, /'open_id'/, 'members are resolved by open_id (personal accounts stay stable)');
});

test('#177 default config and README describe the list', () => {
  const config = fs.readFileSync(new URL('../src/lib/config.js', import.meta.url), 'utf8');
  assert.match(config, /internalMembers/);
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /internalMembers/);
});
