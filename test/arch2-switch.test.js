// Card F / review item 8 (Feishu side): with ZYLOS_ARCH2 unset or 0 the
// component must behave exactly like the pre-arch2 baseline 8c0a3e2 — group
// allowance, smart mode, legacy allowlist, default card decision and the
// c4-receive arguments. The baseline handler is read from git at test time, so
// "old behaviour" is proven against the old code instead of a rewritten copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';
import * as c4 from '../src/lib/c4-ingress.js';
import { hasMarkdownContent, shouldUseCard } from '../src/lib/card-decision.js';
import { isBotMentioned } from '../src/lib/feishu-group-policy.js';

const ROOT = new URL('../', import.meta.url);
const BASELINE = '8c0a3e2';
const END_MARKER = '// Transport: WebSocket';

function gitShow(file) {
  try {
    return execFileSync('git', ['show', `${BASELINE}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}
const baselineSource = gitShow('src/index.js');
const skip = baselineSource ? false : `baseline ${BASELINE} is not available in this checkout`;
const currentSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return source.slice(start, end + 3);
}

function sliceHandler(source) {
  const start = source.indexOf('async function handleMessage(data)');
  const end = source.indexOf(END_MARKER, start);
  assert.notEqual(start, -1, 'missing handleMessage');
  assert.notEqual(end, -1, 'missing end of handleMessage');
  return source.slice(start, end);
}

// Run the real handleMessage with the real policy helpers. arch2 is injected
// exactly like the component does, so the same source runs both paths.
function createHarness({ source, arch2, config, quoted = null }) {
  const calls = [];
  const replies = [];
  const context = {
    config, arch2, ARCH2: arch2,
    botOpenId: 'ou_bot', botAppId: 'app_bot', botTenantKey: 'own_tenant',
    MEDIA_DIR: '/tmp/feishu-media', path,
    console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
    arch2Enabled: () => arch2,
    receivedGroupAllowed: (cfg, id) => c4.receivedGroupAllowed(cfg, id, arch2),
    smartGroup: (cfg, id) => c4.smartGroup(cfg, id, arch2),
    groupGatePolicy,
    isBotMentioned,
    isDuplicate: () => false,
    extractMessageContent: () => ({ text: '内容', imageKeys: [], fileKey: null, fileName: null }),
    buildEndpoint: (chatId, meta) => `${chatId}|type:${meta.chatType}`,
    sendToC4: (...args) => calls.push(args),
    fetchQuotedMessage: async () => quoted,
    isOwner: () => false,
    isSenderAllowedInGroup: () => true,
    saveConfig: () => true,
    classifyGroup: async ({ config: cfg, chatId }) => {
      cfg.groups[chatId] = { ...cfg.groups[chatId], internal: false };
      return false;
    },
    logMessage: async () => {},
    resolveUserName: async () => '用户',
    resolveMentions: text => text,
    resolveMergeForwardText: async () => '合并转发',
    getGroupName: () => '群',
    getGroupHistoryLimit: () => 5,
    getHistoryKey: () => 'h',
    getContextWithFallback: async () => null,
    pinRootMessage: text => text,
    getGroupContext: async () => null,
    updateCursor: () => {},
    preloadGroupMembers: async () => [],
    formatMessage: (_type, _name, text) => text,
    addTypingIndicator: () => replies.push('typing'),
    removeTypingIndicator: () => {},
    replyToMessage: () => { replies.push('reply'); return Promise.resolve({ success: true }); },
    sendMessage: () => { replies.push('dm'); return Promise.resolve({ success: true }); },
    sendThreadAwareMessage: () => { replies.push('thread'); return Promise.resolve({ success: true }); },
    downloadImage: async () => ({ success: false }),
    downloadFile: async () => ({ success: false }),
    buildSafeDownloadPath: () => '/tmp/x',
    bindOwner: async () => true,
    isDmAllowed: () => true,
    setTimeout: cb => cb(),
  };
  vm.createContext(context);
  const policy = ['resolveGroupConfig', 'isGroupAllowed', 'isSmartGroup']
    .map(name => (source.includes(`function ${name}(`) ? sliceFunction(source, name) : ''))
    .join('\n');
  vm.runInContext(`${policy}\n${sliceHandler(source)}`, context);
  return {
    calls, replies, config,
    run: message => context.handleMessage(message),
  };
}

// The policy objects are resolved in the test module so both harnesses share
// the same implementation; handleMessage only sees the wiring above.
function groupGatePolicy(config, chatId) {
  return c4.groupGatePolicy(config, chatId);
}

function groupMessage({ chatId = 'oc_1', mentioned = false, parentId = null, tenantKey = 'own_tenant' } = {}) {
  return {
    message: {
      chat_type: 'group', chat_id: chatId, message_id: 'om_in', parent_id: parentId,
      mentions: mentioned ? [{ id: { open_id: 'ou_bot' } }] : [],
    },
    sender: { sender_id: { open_id: 'ou_person', user_id: 'u1' }, tenant_key: tenantKey },
  };
}

// A call is comparable once functions collapse to a marker: the baseline passes
// its reject-reply callback, so the switch-off path must pass one too.
function observable(harness) {
  return {
    calls: harness.calls.map(args => args.map(value => (typeof value === 'function' ? 'fn' : value))),
    replies: harness.replies,
    groups: JSON.parse(JSON.stringify(harness.config.groups || {})),
  };
}

// ---------------------------------------------------------------------------
// 1. Group allowance / smart mode / legacy allowlist.
// ---------------------------------------------------------------------------
const POLICY_CASES = [
  ['empty config', {}],
  ['open policy', { groupPolicy: 'open' }],
  ['disabled policy', { groupPolicy: 'disabled' }],
  ['groups smart', { groups: { oc_1: { mode: 'smart' } } }],
  ['groups mention', { groups: { oc_1: { mode: 'mention' } } }],
  ['requireMention false', { groups: { oc_1: { requireMention: false } } }],
  ['requireMention true', { groups: { oc_1: { requireMention: true } } }],
  ['group enabled false', { groups: { oc_1: { enabled: false } } }],
  ['legacy allowed_groups', { allowed_groups: [{ chat_id: 'oc_1' }] }],
  ['legacy smart_groups', { smart_groups: [{ chat_id: 'oc_1' }] }],
  ['legacy both lists', { allowed_groups: [{ chat_id: 'oc_1' }], smart_groups: [{ chat_id: 'oc_1' }] }],
  ['legacy allowed plus groups map', { allowed_groups: [{ chat_id: 'oc_1' }], groups: { oc_1: { mode: 'smart' } } }],
  ['legacy smart plus groups map', { smart_groups: [{ chat_id: 'oc_1' }], groups: { oc_1: { mode: 'mention' } } }],
];

test('group allowance and smart mode equal baseline 8c0a3e2 with the switch off', { skip }, () => {
  assert.equal(typeof c4.legacyGroupAllowed, 'function', 'legacy dispatch is required');
  assert.equal(typeof c4.legacySmartGroup, 'function', 'legacy dispatch is required');
  for (const [name, config] of POLICY_CASES) {
    for (const chatId of ['oc_1', 'oc_2', '', undefined]) {
      const allowed = vm.createContext({ config: structuredClone(config), resolveGroupConfig: id => (config.groups || {})[id] });
      vm.runInContext(sliceFunction(baselineSource, 'isGroupAllowed'), allowed);
      const smart = vm.createContext({ config: structuredClone(config), resolveGroupConfig: id => (config.groups || {})[id] });
      vm.runInContext(sliceFunction(baselineSource, 'isSmartGroup'), smart);
      assert.equal(c4.legacyGroupAllowed(structuredClone(config), chatId), allowed.isGroupAllowed(chatId), `${name} / ${chatId}: allowed`);
      assert.equal(c4.legacySmartGroup(structuredClone(config), chatId), smart.isSmartGroup(chatId), `${name} / ${chatId}: smart`);
    }
  }
});

test('arch2 policy keeps automatic group registration and conservative gate defaults', () => {
  assert.equal(c4.receivedGroupAllowed({}, 'oc_new', true), true);
  assert.equal(c4.smartGroup({}, 'oc_new', true), true);
  assert.equal(c4.receivedGroupAllowed({}, 'oc_new', false), false);
  assert.equal(c4.smartGroup({}, 'oc_new', false), false);
  assert.equal(c4.receivedGroupAllowed({ groupPolicy: 'disabled' }, 'oc_new', true), false);
  assert.equal(c4.receivedGroupAllowed({ groups: { oc_1: { enabled: false } } }, 'oc_1', true), false);
});

// ---------------------------------------------------------------------------
// 2. End to end: baseline vs switch off, identical side effects.
// ---------------------------------------------------------------------------
const MESSAGE_CASES = [
  ['unknown group, no mention', {}, groupMessage()],
  ['unknown group, mention', {}, groupMessage({ mentioned: true })],
  ['open policy, no mention', { groupPolicy: 'open' }, groupMessage()],
  ['open policy, mention', { groupPolicy: 'open' }, groupMessage({ mentioned: true })],
  ['legacy smart group, no mention', { smart_groups: [{ chat_id: 'oc_1' }] }, groupMessage()],
  ['legacy smart group, mention', { smart_groups: [{ chat_id: 'oc_1' }] }, groupMessage({ mentioned: true })],
  ['legacy allowed group, no mention', { allowed_groups: [{ chat_id: 'oc_1' }] }, groupMessage()],
  ['legacy allowed group, mention', { allowed_groups: [{ chat_id: 'oc_1' }] }, groupMessage({ mentioned: true })],
  ['groups smart, no mention', { groups: { oc_1: { mode: 'smart' } } }, groupMessage()],
  ['groups smart, mention', { groups: { oc_1: { mode: 'smart' } } }, groupMessage({ mentioned: true })],
  ['groups mention, no mention', { groups: { oc_1: { mode: 'mention' } } }, groupMessage()],
  ['groups mention, mention', { groups: { oc_1: { mode: 'mention' } } }, groupMessage({ mentioned: true })],
  ['disabled group, no mention', { groups: { oc_1: { enabled: false } } }, groupMessage()],
  ['disabled group, mention', { groups: { oc_1: { enabled: false } } }, groupMessage({ mentioned: true })],
  ['disabled policy, mention', { groupPolicy: 'disabled' }, groupMessage({ mentioned: true })],
  ['reply to a non-bot message', { groups: { oc_1: { mode: 'smart' } } }, groupMessage({ parentId: 'om_parent' })],
  ['smart group, external sender', { groups: { oc_1: { mode: 'smart' } } }, groupMessage({ tenantKey: 'other_tenant' })],
  ['private chat', {}, {
    message: { chat_type: 'p2p', chat_id: 'oc_dm', message_id: 'om_dm', mentions: [] },
    sender: { sender_id: { open_id: 'ou_person', user_id: 'u1' }, tenant_key: 'other_tenant' },
  }],
];

test('with the switch off every message path matches baseline 8c0a3e2 exactly', { skip }, async () => {
  for (const [name, config, message] of MESSAGE_CASES) {
    const quoted = message.message.parent_id ? { sender: '其他同事', text: '上文', isBot: false } : null;
    const base = createHarness({ source: baselineSource, arch2: false, config: structuredClone(config), quoted });
    const off = createHarness({ source: currentSource, arch2: false, config: structuredClone(config), quoted });
    await base.run(structuredClone(message));
    await off.run(structuredClone(message));
    assert.deepEqual(observable(off), observable(base), name);
    for (const args of off.calls) {
      assert.equal(args.length, 4, `${name}: c4-receive gets the baseline argument list`);
      for (const flag of ['--source-id', '--chat', '--sender', '--mentioned', '--needs-gate']) {
        assert.ok(!args.includes(flag), `${name}: ${flag} must not be passed when the switch is off`);
      }
    }
  }
});

test('switch off never registers a group or writes automatic classification', { skip }, async () => {
  const config = {};
  const off = createHarness({ source: currentSource, arch2: false, config: structuredClone(config) });
  await off.run(groupMessage());
  assert.deepEqual(off.config.groups || {}, {}, 'no silent registration while the switch is off');
});

test('with the switch on the new path is wired (same message, different outcome)', { skip }, async () => {
  const message = groupMessage();
  const off = createHarness({ source: currentSource, arch2: false, config: {} });
  const on = createHarness({ source: currentSource, arch2: true, config: {} });
  await off.run(structuredClone(message));
  await on.run(structuredClone(message));
  assert.equal(off.calls.length, 0, 'switch off: an unknown group keeps the old allowlist behaviour');
  assert.equal(on.calls.length, 1, 'switch on: a received group is registered and delivered');
  assert.deepEqual(JSON.parse(JSON.stringify(on.calls[0][4])),
    { sourceId: 'om_in', chatId: 'oc_1', senderId: 'ou_person', mentioned: false, needsGate: true });
});

// ---------------------------------------------------------------------------
// 3. c4-receive arguments.
// ---------------------------------------------------------------------------
test('c4-receive keeps the baseline argument list when the switch is off', () => {
  const metadata = { sourceId: 'om_1', chatId: 'oc_1', senderId: 'ou_1', mentioned: true, needsGate: true };
  assert.deepEqual(c4.arch2IngressArgs(false, metadata), []);
  assert.deepEqual(c4.arch2IngressArgs(true, metadata),
    ['--source-id', 'om_1', '--chat', 'oc_1', '--sender', 'ou_1', '--mentioned', '1', '--needs-gate']);
  assert.deepEqual(c4.arch2IngressArgs(true, { mentioned: false }), ['--mentioned', '0']);
});

// ---------------------------------------------------------------------------
// 4. Default card decision.
// ---------------------------------------------------------------------------
function loadConfigInChild({ home, env }) {
  const script = `import { loadConfig } from ${JSON.stringify(new URL('../src/lib/config.js', import.meta.url).href)};
import { shouldUseCard } from ${JSON.stringify(new URL('../src/lib/card-decision.js', import.meta.url).href)};
const cfg = loadConfig();
const arch2 = process.env.ZYLOS_ARCH2 === '1';
console.log(JSON.stringify({ message: cfg.message,
  plain: shouldUseCard(cfg.message, '普通一句话', arch2),
  bold: shouldUseCard(cfg.message, '**加粗**', arch2) }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { HOME: home, PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function tempHome(t, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-arch2-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'zylos/components/feishu');
  fs.mkdirSync(dir, { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return home;
}

test('default card decision matches the baseline when the switch is off', t => {
  const fresh = loadConfigInChild({ home: tempHome(t, null), env: {} });
  assert.equal(fresh.message.useMarkdownCard, false, 'baseline default disables markdown cards');
  assert.equal(fresh.message.alwaysCard, undefined, 'baseline has no alwaysCard');
  assert.deepEqual([fresh.plain, fresh.bold], [false, false]);

  const upgraded = loadConfigInChild({ home: tempHome(t, { enabled: true, message: { useMarkdownCard: true } }), env: { ZYLOS_ARCH2: '0' } });
  assert.equal(upgraded.message.alwaysCard, undefined, 'switch off never injects alwaysCard');
  assert.deepEqual([upgraded.plain, upgraded.bold], [false, true], 'baseline sends cards only for markdown');

  const on = loadConfigInChild({ home: tempHome(t, null), env: { ZYLOS_ARCH2: '1' } });
  assert.equal(on.message.useMarkdownCard, true);
  assert.equal(on.message.alwaysCard, true);
  assert.deepEqual([on.plain, on.bold], [true, true]);

  const explicit = loadConfigInChild({ home: tempHome(t, { enabled: true, message: { useMarkdownCard: false } }), env: { ZYLOS_ARCH2: '1' } });
  assert.equal(explicit.message.useMarkdownCard, false, 'an explicit operator setting survives');
});

test('card decision equals the baseline expression for every sample', () => {
  const sample = ['普通', '**粗**', '# 标题', '```\ncode\n```', '- 列表', '| a |\n| - |', ''];
  const messages = [undefined, {}, { useMarkdownCard: true }, { useMarkdownCard: false }, { useMarkdownCard: true, alwaysCard: true }, { alwaysCard: true }];
  for (const message of messages) {
    for (const text of sample) {
      const baseline = Boolean(message && message.useMarkdownCard && hasMarkdownContent(text));
      assert.equal(shouldUseCard(message, text, false), baseline, `message=${JSON.stringify(message)} text=${text}`);
      assert.equal(shouldUseCard(message, text, true), Boolean(message?.useMarkdownCard !== false), 'switch on: cards unless explicitly disabled');
    }
  }
});

test('the master switch is on only for the literal value 1', async () => {
  const mod = await import('../src/lib/arch2.js').catch(() => null);
  assert.ok(mod, 'src/lib/arch2.js must exist so the component can read the switch');
  assert.equal(mod.arch2Enabled({ ZYLOS_ARCH2: '1' }), true);
  for (const env of [{}, { ZYLOS_ARCH2: '' }, { ZYLOS_ARCH2: '0' }, { ZYLOS_ARCH2: 'true' }, { ZYLOS_ARCH2: ' 1' }, { ZYLOS_ARCH2: 'yes' }]) {
    assert.equal(mod.arch2Enabled(env), false, JSON.stringify(env));
  }
  assert.equal(mod.arch2Enabled(undefined), false);
});

// ---------------------------------------------------------------------------
// 5. Install / upgrade config migrations.
// ---------------------------------------------------------------------------
test('upgrade migration adds alwaysCard only when the switch is on', async () => {
  const mod = await import('../hooks/config-migrations.js').catch(() => null);
  assert.ok(mod, 'the config migrations must be importable so both paths can be tested');
  const legacy = { enabled: true, message: { useMarkdownCard: true }, groupPolicy: 'allowlist', groups: {} };
  const off = mod.migrateConfig(structuredClone(legacy), { arch2: false });
  assert.equal(off.config.message.alwaysCard, undefined, 'switch off keeps the baseline config');
  assert.ok(!off.migrations.some(line => /alwaysCard/.test(line)));
  const on = mod.migrateConfig(structuredClone(legacy), { arch2: true });
  assert.equal(on.config.message.alwaysCard, true);
  assert.ok(on.migrations.some(line => /alwaysCard/.test(line)));

  const explicit = mod.migrateConfig({ ...structuredClone(legacy), message: { useMarkdownCard: true, alwaysCard: false } }, { arch2: true });
  assert.equal(explicit.config.message.alwaysCard, false, 'explicit false survives an upgrade');
});

test('the install hook seeds alwaysCard only when the switch is on', async () => {
  const source = fs.readFileSync(new URL('../hooks/post-install.js', import.meta.url), 'utf8');
  assert.match(source, /arch2Enabled\(\)/, 'post-install must consult the master switch');
  assert.match(source, /installConfig\(/, 'post-install must use the shared initial config');
  const mod = await import('../hooks/config-migrations.js');
  assert.deepEqual(mod.installConfig({ arch2: false }), mod.BASELINE_INITIAL_CONFIG);
  assert.equal(mod.installConfig({ arch2: false }).message.alwaysCard, undefined);
  assert.equal(mod.installConfig({ arch2: true }).message.alwaysCard, true);
  assert.deepEqual(Object.keys(mod.installConfig({ arch2: false })), ['enabled', 'connection_mode', 'webhook_port', 'message']);
});

// ---------------------------------------------------------------------------
// 6. The sender: same exit status, same calls, no uuid, no receipt line.
// The baseline tree is exported from git so the sender itself is compared,
// not a re-implementation of what the sender used to do.
// ---------------------------------------------------------------------------
function exportBaseline(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-baseline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = execFileSync('git', ['archive', BASELINE], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const tarPath = path.join(dir, 'tree.tar');
  fs.writeFileSync(tarPath, archive);
  execFileSync('tar', ['-xf', tarPath, '-C', dir], { cwd: dir });
  fs.unlinkSync(tarPath);
  // The baseline tree has no node_modules; the entry script only needs the
  // dependencies of the modules that survive the loader stub.
  fs.symlinkSync(path.join(ROOT.pathname, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

function runSender(t, { cwd = ROOT.pathname, content = '普通文本', config = { enabled: true }, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sender-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'zylos/components/feishu'), { recursive: true });
  fs.writeFileSync(path.join(home, 'zylos/components/feishu/config.json'), JSON.stringify(config));
  const loader = new URL('../test-fixtures/card-entry-loader.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'scripts/send.js', 'oc_1|type:p2p', content], {
    cwd, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: home, ZYLOS_ARCH2: '', C4_OUTBOUND_ID: '42', C4_DELIVERY_ID: '', CARD_ENTRY_SEND_FAIL: '', CARD_ENTRY_UNCERTAIN: '', ...env },
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return {
    status: result.status,
    receipts: lines.filter(line => line.startsWith('C4_RESULT ')),
    calls: lines.filter(line => line.startsWith('ENTRY_CALL ')).map(line => JSON.parse(line.slice('ENTRY_CALL '.length))),
  };
}

const SENDER_CASES = [
  ['plain text, cards off by default', {}],
  ['markdown, cards enabled', { config: { enabled: true, message: { useMarkdownCard: true } }, content: '**粗**' }],
  ['markdown, cards enabled, plain text', { config: { enabled: true, message: { useMarkdownCard: true } } }],
  ['platform error', { env: { CARD_ENTRY_SEND_FAIL: '1' } }],
  ['ambiguous platform answer', { env: { CARD_ENTRY_UNCERTAIN: '1' } }],
  ['component disabled', { config: { enabled: false } }],
  ['[SKIP] marker', { content: '[SKIP]' }],
];

test('the sender matches baseline 8c0a3e2 with the switch off', { skip }, t => {
  const baselineDir = exportBaseline(t);
  for (const [name, options] of SENDER_CASES) {
    const base = runSender(t, { ...options, cwd: baselineDir });
    const off = runSender(t, options);
    assert.deepEqual(off, base, name);
    assert.deepEqual(off.receipts, [], `${name}: no C4_RESULT line while the switch is off`);
    assert.ok(!off.calls.some(call => call.args.some(arg => arg && typeof arg === 'object' && 'uuid' in arg)),
      `${name}: no uuid on the platform payload`);
  }
});

test('the sender adds the uuid and the receipt only with the switch on', t => {
  const on = runSender(t, { env: { ZYLOS_ARCH2: '1' } });
  assert.equal(on.status, 0);
  assert.equal(on.receipts.length, 1);
  assert.deepEqual(JSON.parse(on.receipts[0].slice('C4_RESULT '.length)), { status: 'sent', platform_msg_id: 'om_test_entry' });
  assert.equal(on.calls[0].args.find(arg => arg && typeof arg === 'object').uuid, '42');
});
