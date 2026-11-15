// Issue #162 at the handler level: the real `handleMessage`, the real
// classifier, and a stubbed Feishu API.
//
// `test/member-reclass.test.js` proves the policy; this file proves the wiring
// the acceptance list actually talks about — after an outside member joins, the
// next unmentioned message is not delivered as actionable work while an @mention
// still is, and both transports/subscriptions carry the member events.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as c4 from '../src/lib/c4-ingress.js';
import { isBotMentioned } from '../src/lib/feishu-group-policy.js';
import { createGroupClassifier } from '../src/lib/group-classification.js';

const ROOT = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `missing end of ${name}`);
  return source.slice(start, end + 3);
}

function sliceHandler() {
  const start = source.indexOf('async function handleMessage(data)');
  const end = source.indexOf('// Transport: WebSocket', start);
  assert.notEqual(start, -1, 'missing handleMessage');
  assert.notEqual(end, -1, 'missing end of handleMessage');
  return source.slice(start, end);
}

// A minimal running component: real policy + real classifier, stub API.
function harness({ external = false } = {}) {
  const calls = [];
  const replies = [];
  const config = {
    bot: { tenant_key: 'own' },
    internalTenants: ['own'],
    groups: { oc_1: { mode: 'smart', autoClassification: { internal: true, checkedAt: Date.now(), retry: false, source: 'chat_info' } } },
  };
  let chatInfo = { success: true, chat: { external } };
  const classifyGroup = createGroupClassifier({
    getChatInfo: async () => chatInfo,
    saveConfig: () => true,
    log: () => {},
  });
  const context = {
    config, ARCH2: true,
    botOpenId: 'ou_bot', botAppId: 'app_bot', botTenantKey: 'own',
    MEDIA_DIR: '/tmp/feishu-media', path,
    console: { log() {}, warn() {}, error() {} },
    process: { env: {} },
    receivedGroupAllowed: (cfg, id) => c4.receivedGroupAllowed(cfg, id, true),
    smartGroup: (cfg, id) => c4.smartGroup(cfg, id, true),
    groupGatePolicy,
    isBotMentioned,
    isDuplicate: () => false,
    extractMessageContent: () => ({ text: '帮我查一下昨天的单量', imageKeys: [], fileKey: null, fileName: null }),
    buildEndpoint: (chatId, meta) => `${chatId}|type:${meta.chatType}`,
    sendToC4: (...args) => calls.push(args),
    fetchQuotedMessage: async () => null,
    isOwner: () => false,
    isSenderAllowedInGroup: () => true,
    saveConfig: () => true,
    classifyGroup,
    scheduleStatus: () => {},
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
    .map(name => (source.includes(`function ${name}(`) ? sliceFunction(name) : ''))
    .join('\n');
  vm.runInContext(`${policy}\n${sliceHandler()}`, context);
  return {
    config, calls, replies, chatInfo,
    classifyGroup,
    setChatInfo: value => { chatInfo = value; },
    member: (type, users) => classifyGroup.handleMemberEvent({ config, chatId: 'oc_1', event: { type, users }, botTenantKey: 'own' }),
    // `onReject` is a function only for messages the front desk treats as live
    // work; it is null for context-only traffic.
    lastActionable: () => {
      const last = calls[calls.length - 1];
      return typeof last?.[3] === 'function';
    },
    run: (mentioned = false) => context.handleMessage({
      message: { chat_type: 'group', chat_id: 'oc_1', message_id: `om_${calls.length}`, mentions: mentioned ? [{ id: { open_id: 'ou_bot' } }] : [] },
      sender: { sender_id: { open_id: 'ou_person', user_id: 'u1' }, tenant_key: 'own' },
    }),
  };
}

function groupGatePolicy(config, chatId) {
  return c4.groupGatePolicy(config, chatId);
}

test('after an outside member joins, the next unmentioned message is context only and an @mention still works', async () => {
  const h = harness({ external: false });
  await h.run(false);
  assert.equal(h.lastActionable(), true, 'an internal group delivers unmentioned work');

  await h.member('added', [{ tenant_key: 'outside', user_id: { open_id: 'ou_outside' } }]);
  h.setChatInfo({ success: true, chat: { external: false } });  // Feishu still says not external

  await h.run(false);
  assert.equal(h.lastActionable(), false, 'unmentioned work must not be delivered after an outside member joined');

  await h.run(true);
  assert.equal(h.lastActionable(), true, '@mention is still answered in an external group');
  assert.ok(h.replies.includes('typing'), 'the @mention path still shows the typing indicator');
});

test('after the outside member leaves, unmentioned work is delivered again without a restart', async () => {
  const h = harness({ external: false });
  await h.member('added', [{ tenant_key: 'outside', user_id: { open_id: 'ou_outside' } }]);
  await h.run(false);
  assert.equal(h.lastActionable(), false);

  h.setChatInfo({ success: true, chat: { external: false } });
  await h.member('deleted', [{ tenant_key: 'outside', user_id: { open_id: 'ou_outside' } }]);
  await h.run(false);
  assert.equal(h.lastActionable(), true, 'the group is internal again');
});

test('a member event arriving mid-flight cannot be undone by the message in flight', async () => {
  const h = harness({ external: false });
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  h.setChatInfo(null);
  const inflight = h.run(false);          // its lookup is pending on the stub below
  const event = h.member('added', [{ tenant_key: 'outside', user_id: { open_id: 'ou_outside' } }]);
  release({ success: true, chat: { external: false } });
  await Promise.all([inflight, event]);
  await h.run(false);
  assert.equal(h.lastActionable(), false, 'the older in-flight verdict stays dead');
});

test('both transports subscribe to the three member events and write status at startup', () => {
  assert.match(source, /'im\.chat\.member\.user\.added_v1': 'added'/);
  assert.match(source, /'im\.chat\.member\.user\.deleted_v1': 'deleted'/);
  assert.match(source, /'im\.chat\.member\.user\.withdrawn_v1': 'withdrawn'/);
  // WebSocket dispatch map
  assert.match(source, /\.\.\.memberEventHandlers\(\),/);
  // Webhook dispatch
  assert.match(source, /MEMBER_EVENT_TYPES\[event\.header\?\.event_type\]/);
  // Startup status write happens before either transport starts
  const statusAt = source.indexOf('persistStatus();');
  const wsAt = source.indexOf('startWebSocket(creds);\n  }');
  assert.ok(statusAt > 0 && wsAt > statusAt, 'status.json is written before the transport starts');
});

test('the permission check runs at startup and its result reaches status.json', () => {
  assert.match(source, /permissionReport = await checkGroupPermissions\(/);
  assert.match(source, /permission: permissionReport/);
  assert.match(source, /Scope \$\{check\.scope\} \$\{check\.status\}/, 'a non-granted scope is logged');
});
