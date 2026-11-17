// R4: 机器人被拉进群 / 被移出群（验收清单第 24 项「拉进新群自动放行并开 smart」）。
//
// The defect this file pins down: `MEMBER_EVENT_TYPES` only registered the three
// *people* membership events, so a `im.chat.member.bot.added_v1` push was
// answered by the SDK with `no im.chat.member.bot.added_v1 handle` and the group
// was never registered — its messages were then dropped by the allowlist gate.
//
// Constructed events only. No Feishu API is called: `getChatInfo` is a stub and
// `saveConfig` records instead of writing. The handler under test is sliced out
// of the real `src/index.js` (same technique as `member-wiring.test.js`) and run
// against the real classifier, so this is the wiring, not a rewrite of it.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as c4 from '../src/lib/c4-ingress.js';
import { createGroupClassifier, groupEvidence, effectiveInternal } from '../src/lib/group-classification.js';

const ROOT = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

function sliceFunction(name) {
  // `async function f(` contains `function f(`, so preferring the async form
  // keeps the slice valid — a slice without `async` makes `vm` reject the whole
  // script with "await is only valid in async functions".
  const start = source.indexOf(`async function ${name}(`) !== -1
    ? source.indexOf(`async function ${name}(`)
    : source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const end = source.indexOf('\n}\n', start);
  if (end === -1) return null;
  return source.slice(start, end + 3);
}

/** The event-type table from the real source, so the test uses whatever the
 * component actually registered instead of a copy. */
function sliceConst(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) return null;
  const end = source.indexOf('\n};\n', start);
  if (end === -1) return null;
  return source.slice(start, end + 4);
}

/**
 * A running component: real policy helpers, real classifier, stub API.
 *
 * `missing` names any function the slice could not find, so a baseline run
 * (before the bot events were wired) fails with "src/index.js has no …" instead
 * of an opaque vm error.
 */
function harness({ arch2 = true, external = false, config: initial = null, chatInfo } = {}) {
  const calls = [];
  const saves = [];
  const config = initial || {
    bot: { tenant_key: 'own' },
    internalTenants: ['own'],
    groupPolicy: 'allowlist',
    groups: {},
  };
  let info = chatInfo || { success: true, chat: { external } };
  const classifyGroup = createGroupClassifier({
    getChatInfo: async (chatId) => { calls.push(chatId); return info; },
    saveConfig: () => { saves.push('classifier'); return true; },
    log: () => {},
  });
  const context = {
    config,
    ARCH2: arch2,
    botTenantKey: 'own',
    classifyGroup,
    groupEvidence,
    saveConfig: () => { saves.push('handler'); return true; },
    scheduleStatus: () => {},
    isSmartGroup: chatId => c4.smartGroup(config, chatId, arch2),
    resolveGroupConfig: chatId => (config.groups || {})[chatId],
    console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
    JSON, Object, Array, Boolean, Date,
  };
  vm.createContext(context);
  const names = ['resolveGroupConfig', 'isSmartGroup', 'handleBotAddedToGroup', 'handleBotRemovedFromGroup', 'handleMemberEvent'];
  // Only the slices that exist are loaded. On the pre-fix component
  // `handleMemberEvent` is the baseline one that knows three event types, so the
  // missing bot helpers are never reached and the failure is the real one
  // ("the group was never registered") instead of "a helper is absent".
  const missing = names.filter(name => !sliceFunction(name));
  const found = names.filter(name => sliceFunction(name)).map(sliceFunction);
  const table = sliceConst('MEMBER_EVENT_TYPES');
  if (found.length) vm.runInContext(`${table || 'const MEMBER_EVENT_TYPES = {};'}\n${found.join('\n')}`, context);
  return {
    config, calls, saves, classifyGroup, missing,
    setChatInfo: value => { info = value; },
    fire: (eventType, event) => context.handleMemberEvent(eventType, event),
  };
}

const BOT_ADDED = 'im.chat.member.bot.added_v1';
const BOT_DELETED = 'im.chat.member.bot.deleted_v1';
const botEvent = (chatId, extra = {}) => ({
  chat_id: chatId,
  operator_id: { open_id: 'ou_operator' },
  operator_tenant_key: 'own',
  name: '三个智能',
  ...extra,
});

// ---------------------------------------------------------------------------
// 1. 机器人进群：自动加入放行名单 + 开 smart + 立即判别
// ---------------------------------------------------------------------------
test('bot added registers the group as smart and judges it right away', async () => {
  const h = harness({ external: true });

  await h.fire(BOT_ADDED, botEvent('oc_new'));

  assert.ok(h.config.groups.oc_new, 'the group is in the allowlist without waiting for a message');
  assert.equal(h.config.groups.oc_new.mode, 'smart');
  // The allowlist gate and the smart gate are read by different helpers; both
  // have to agree or the group receives unmentioned messages nothing answers.
  assert.equal(c4.receivedGroupAllowed(h.config, 'oc_new', true), true);
  assert.equal(c4.smartGroup(h.config, 'oc_new', true), true);

  assert.deepEqual(h.calls, ['oc_new'], 'the classifier was asked exactly once');
  assert.equal(effectiveInternal(h.config.groups.oc_new), false, 'external group stays closed');
  assert.equal(h.config.groups.oc_new.autoClassification.source, 'chat_info');
  assert.ok(h.saves.length >= 2, 'the registration and the verdict are both persisted');
});

test('bot added in an internal group opens it with the existing classifier verdict', async () => {
  const h = harness({ external: false });

  await h.fire(BOT_ADDED, botEvent('oc_new'));

  assert.deepEqual(c4.groupGatePolicy(h.config, 'oc_new'), { internal: true, gateMode: 'auto' });
});

test('bot added twice, or for an already configured group, does not overwrite the operator settings', async () => {
  const h = harness({ external: false });
  await h.fire(BOT_ADDED, botEvent('oc_new'));
  const afterFirst = JSON.parse(JSON.stringify(h.config.groups.oc_new));

  await h.fire(BOT_ADDED, botEvent('oc_new'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.config.groups.oc_new)), afterFirst, 'a repeat add is a no-op');

  // An explicit configuration wins: mode, allowFrom and a manual internal=false
  // are the operator's decision, and this event repeats on every re-add.
  const explicit = harness({
    config: {
      bot: { tenant_key: 'own' }, internalTenants: ['own'], groupPolicy: 'allowlist',
      groups: { oc_known: { mode: 'mention', allowFrom: ['ou_a'], internal: false } },
    },
  });
  await explicit.fire(BOT_ADDED, botEvent('oc_known'));
  assert.deepEqual(explicit.config.groups.oc_known.mode, 'mention');
  assert.deepEqual(explicit.config.groups.oc_known.allowFrom, ['ou_a']);
  assert.equal(explicit.config.groups.oc_known.internal, false);
});

test('bot added never widens a pre-upgrade allowlisted group to all messages', async () => {
  // A group registered through the legacy list was mention-only by hand. Turning
  // it into `smart` would start answering chatter nobody asked to answer.
  const h = harness({
    config: {
      bot: { tenant_key: 'own' }, internalTenants: ['own'], groupPolicy: 'allowlist',
      groups: {}, allowed_groups: [{ chat_id: 'oc_legacy' }],
    },
  });
  await h.fire(BOT_ADDED, botEvent('oc_legacy'));
  assert.equal(h.config.groups.oc_legacy.mode, 'mention');
});

test('bot added is ignored while group chat is disabled', async () => {
  const h = harness({
    config: { bot: { tenant_key: 'own' }, internalTenants: ['own'], groupPolicy: 'disabled', groups: {} },
  });
  await h.fire(BOT_ADDED, botEvent('oc_new'));
  assert.equal(h.config.groups.oc_new, undefined, 'groupPolicy=disabled must not be bypassed');
  assert.deepEqual(h.calls, []);
});

// ---------------------------------------------------------------------------
// 2. 机器人被移出群：只清那一个群
// ---------------------------------------------------------------------------
test('bot removed drops that group only', async () => {
  const h = harness({
    config: {
      bot: { tenant_key: 'own' }, internalTenants: ['own'], groupPolicy: 'allowlist',
      groups: {
        oc_gone: { mode: 'smart', chatId: 'oc_gone', autoClassification: { internal: true, checkedAt: 1, retry: false, source: 'chat_info' }, internalDemoted: { at: 1, reason: 'member_joined_external' } },
        oc_kept: { mode: 'mention', allowFrom: ['ou_a'], autoClassification: { internal: false, checkedAt: 1, retry: false, source: 'chat_info' } },
      },
    },
  });
  const keptBefore = JSON.parse(JSON.stringify(h.config.groups.oc_kept));

  await h.fire(BOT_DELETED, botEvent('oc_gone'));

  assert.equal(h.config.groups.oc_gone, undefined, 'config and cached verdict are gone');
  assert.deepEqual(JSON.parse(JSON.stringify(h.config.groups.oc_kept)), keptBefore, 'other groups are untouched');
  assert.equal(c4.receivedGroupAllowed(h.config, 'oc_gone', true), false, 'the removed group is no longer allowed');
});

test('bot removed for a group we never configured is a no-op', async () => {
  const h = harness();
  await h.fire(BOT_DELETED, botEvent('oc_unknown'));
  assert.deepEqual(h.config.groups, {});
  assert.deepEqual(h.calls, [], 'no lookup is made for a group we are leaving');
});

test('a verdict still in flight from the add cannot survive the removal', async () => {
  const h = harness({
    config: {
      bot: { tenant_key: 'own' }, internalTenants: ['own'], groupPolicy: 'allowlist',
      groups: { oc_gone: { mode: 'smart' } },
    },
  });
  // Both events arrive back to back; the add's `im.chat.get` is still pending.
  const adding = h.fire(BOT_ADDED, botEvent('oc_gone'));
  const removing = h.fire(BOT_DELETED, botEvent('oc_gone'));
  await Promise.all([adding, removing]);

  assert.equal(h.config.groups.oc_gone, undefined, 'the late verdict does not resurrect the config');
  assert.equal(h.classifyGroup.forgetChat('oc_gone'), true, 'the per-chat epoch is still tracked');
});

// ---------------------------------------------------------------------------
// 3. 开关关掉时与 #162 一致：什么都不做
// ---------------------------------------------------------------------------
test('with ZYLOS_ARCH2=0 the bot events do nothing', async () => {
  const h = harness({ arch2: false });
  await h.fire(BOT_ADDED, botEvent('oc_new'));
  assert.deepEqual(h.config.groups, {}, 'no registration');
  assert.deepEqual(h.calls, [], 'no lookup');
  await h.fire(BOT_DELETED, botEvent('oc_new'));
  assert.deepEqual(h.config.groups, {});
});

// ---------------------------------------------------------------------------
// 4. 事件订阅：#162 的三条不变，新加的两条在两条传输上都注册
// ---------------------------------------------------------------------------
test('both transports subscribe to the five membership events', () => {
  assert.match(source, /'im\.chat\.member\.user\.added_v1': 'added'/);
  assert.match(source, /'im\.chat\.member\.user\.deleted_v1': 'deleted'/);
  assert.match(source, /'im\.chat\.member\.user\.withdrawn_v1': 'withdrawn'/);
  assert.match(source, /'im\.chat\.member\.bot\.added_v1': 'bot_added'/);
  assert.match(source, /'im\.chat\.member\.bot\.deleted_v1': 'bot_deleted'/);
  // WebSocket dispatch map and webhook dispatch both read the same table.
  assert.match(source, /\.\.\.memberEventHandlers\(\),/);
  assert.match(source, /MEMBER_EVENT_TYPES\[event\.header\?\.event_type\]/);
});

test('the people events still go through the classifier, not the bot branch', async () => {
  // #162 behaviour: an outside member joining invalidates the verdict.
  const h = harness({
    external: false,
    config: {
      bot: { tenant_key: 'own' }, internalTenants: ['own'], groupPolicy: 'allowlist',
      groups: { oc_1: { mode: 'smart', autoClassification: { internal: true, checkedAt: Date.now(), retry: false, source: 'chat_info' } } },
    },
  });
  await h.fire('im.chat.member.user.added_v1', { chat_id: 'oc_1', users: [{ tenant_key: 'outside', user_id: { open_id: 'ou_x' } }] });
  assert.equal(effectiveInternal(h.config.groups.oc_1), false, 'an outside member still demotes the group');
  assert.equal(groupEvidence(h.config.groups.oc_1).reason, 'member_joined_external');
  assert.equal(h.config.groups.oc_1.mode, 'smart', 'the people path never rewrites the mode');
});

test('a bot event without chat_id is ignored instead of throwing', async () => {
  const h = harness();
  await h.fire(BOT_ADDED, { event_id: 'x' });
  await h.fire(BOT_DELETED, {});
  assert.deepEqual(h.config.groups, {});
});

// ---------------------------------------------------------------------------
// 5. forgetChat 只影响那一个群（分类器层）
// ---------------------------------------------------------------------------
test('forgetChat drops one chat epoch and leaves its neighbour working', async () => {
  const config = {
    bot: { tenant_key: 'own' }, internalTenants: ['own'],
    groups: { oc_a: { mode: 'smart' }, oc_b: { mode: 'smart' } },
  };
  const seen = [];
  const classify = createGroupClassifier({
    getChatInfo: async chatId => { seen.push(chatId); return { success: true, chat: { external: false } }; },
    saveConfig: () => true,
    log: () => {},
  });
  await classify({ config, chatId: 'oc_a', botTenantKey: 'own' });
  await classify({ config, chatId: 'oc_b', botTenantKey: 'own' });
  assert.equal(effectiveInternal(config.groups.oc_a), true);

  assert.equal(classify.forgetChat('oc_a'), true);
  delete config.groups.oc_a;
  // oc_b keeps its cache: a fresh call is answered without another lookup.
  await classify({ config, chatId: 'oc_b', botTenantKey: 'own' });
  assert.deepEqual(seen, ['oc_a', 'oc_b'], 'the neighbour does not re-query');
});
