import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { ingressArgs, groupGatePolicy, smartGroup, receivedGroupAllowed, replyIsBot } from '../src/lib/c4-ingress.js';
import { isBotMentioned } from '../src/lib/feishu-group-policy.js';

test('forwards source id, chat, sender open_id, mention, gate flag exactly', () => {
  assert.deepEqual(ingressArgs({ sourceId: 'om_1', chatId: 'oc_1', senderId: 'ou_1', mentioned: true, needsGate: true }),
    ['--source-id', 'om_1', '--chat', 'oc_1', '--sender', 'ou_1', '--mentioned', '1', '--needs-gate']);
  assert.deepEqual(ingressArgs({ mentioned: false }), ['--mentioned', '0']);
});
// 投递只有一份实现：`deliverToC4()` 等结果，`sendToC4()` 是它的流水式包装。
// 拍板卡的回调要「投没投出去」，普通入站只要投出去，所以两者必须共用同一条
// 参数构造与重试逻辑——分开写两份，早晚会漂（生产上已经有过一次「调了一个
// 不存在的函数」）。
const INDEX_SOURCE = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const DELIVERY_SOURCE = INDEX_SOURCE.slice(
  INDEX_SOURCE.indexOf('function deliverToC4('),
  INDEX_SOURCE.indexOf('/**\n * Build structured endpoint'),
);

function deliveryContext({ execFile, response = () => null } = {}) {
  return {
    ingressArgs,
    arch2IngressArgs: (on, metadata) => (on ? ingressArgs(metadata) : []),
    ARCH2: true,
    INTERNAL_SECRET: 'fixture',
    C4_RECEIVE: '/fixture/c4-receive.js',
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    parseC4Response: (stdout) => {
      if (!stdout) return null;
      try { return JSON.parse(String(stdout).trim()); } catch { return null; }
    },
    setTimeout: (cb) => { cb(); return 0; },
    execFile: execFile ?? response,
  };
}

test('deliverToC4 passes metadata through execFile and retries once on a transport error', async () => {
  const calls = [];
  const context = deliveryContext({
    execFile: (_cmd, args, _opts, cb) => {
      calls.push(args);
      cb(calls.length === 1 ? Error('transient') : null, '{"ok":true}');
    },
  });
  const result = await vm.runInNewContext(
    `${DELIVERY_SOURCE}\ndeliverToC4('feishu','oc_1|type:group','hi',{sourceId:'om_1',chatId:'oc_1',senderId:'ou_1',mentioned:false,needsGate:true})`,
    context,
  );
  assert.equal(calls.length, 2, 'a transport error is retried exactly once');
  for (const args of calls) {
    for (const [flag, value] of [['--source-id', 'om_1'], ['--chat', 'oc_1'], ['--sender', 'ou_1'], ['--mentioned', '0']]) {
      assert.equal(args[args.indexOf(flag) + 1], value);
    }
    assert.ok(args.includes('--needs-gate'));
    assert.equal(args[args.indexOf('--channel') + 1], 'feishu');
  }
  assert.equal(result.delivered, true);
});

test('deliverToC4 reports a C4 rejection without retrying (retry cannot fix a refusal)', async () => {
  let calls = 0;
  const context = deliveryContext({
    execFile: (_cmd, _args, _opts, cb) => {
      calls += 1;
      const error = Object.assign(new Error('c4 said no'), {
        stdout: '{"ok":false,"error":{"code":"INVALID_ARGS","message":"bad endpoint"}}',
      });
      cb(error, '');
    },
  });
  const result = await vm.runInNewContext(
    `${DELIVERY_SOURCE}\ndeliverToC4('feishu','oc_1|type:group','hi',{})`,
    context,
  );
  assert.equal(calls, 1, 'a rejection is not retried');
  assert.equal(result.delivered, false);
  assert.equal(result.rejected, true);
  assert.equal(result.error, 'bad endpoint');
});

test('deliverToC4 carries --callback-ticket-id only when asked, so归单 works and nothing else changes', async () => {
  const calls = [];
  const context = deliveryContext({
    execFile: (_cmd, args, _opts, cb) => { calls.push(args); cb(null, '{"ok":true}'); },
  });
  await vm.runInNewContext(
    `${DELIVERY_SOURCE}\ndeliverToC4('feishu','oc_1|type:p2p|msg:om_1','tap',{sourceId:'s',chatId:'oc_1',senderId:'ou_1',mentioned:true,callbackTicketId:'T01010000-abcd'})`,
    context,
  );
  await vm.runInNewContext(
    `${DELIVERY_SOURCE}\ndeliverToC4('feishu','oc_1|type:group','plain',{sourceId:'s',chatId:'oc_1',senderId:'ou_1',mentioned:false})`,
    context,
  );
  assert.equal(calls[0][calls[0].indexOf('--callback-ticket-id') + 1], 'T01010000-abcd');
  assert.equal(calls[1].includes('--callback-ticket-id'), false,
    'an ordinary inbound message must not claim to answer a ticket');
});

test('sendToC4 is the fire-and-forget wrapper over the same implementation', () => {
  const source = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf('function sendToC4('), INDEX_SOURCE.indexOf('/**\n * Build structured endpoint'));
  assert.match(source, /deliverToC4\(/, 'a second copy of the exec logic would drift');
  assert.equal(source.includes('execFile('), false, 'the wrapper must not spawn its own process');
});
test('all current DM/group dispatch sites use captured ingress metadata', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handleMessage(data)'));
  assert.equal((handler.match(/deliverToC4\('feishu'/g) || []).length, 11);
  assert.equal((handler.match(/sendToC4\('feishu'/g) || []).length, 0);
  assert.match(handler, /sourceId: messageId, chatId, senderId: senderOpenId/);
});
test('receiving a message allows unknown group, default smart', () => {
  assert.equal(receivedGroupAllowed({}, 'oc_new'), true);
  assert.equal(smartGroup({}, 'oc_new'), true);
});
test('disabled policy and explicit group disable still block', () => {
  assert.equal(receivedGroupAllowed({ groupPolicy: 'disabled' }, 'oc_new'), false);
  assert.equal(smartGroup({ groupPolicy: 'disabled' }, 'oc_new'), false);
  assert.equal(receivedGroupAllowed({ groups: { oc_1: { enabled: false } } }, 'oc_1'), false);
});
test('explicit mention mode and legacy allowed lists take precedence', () => {
  assert.equal(smartGroup({ groups: { oc_1: { mode: 'mention' } } }, 'oc_1'), false);
  assert.equal(smartGroup({ allowed_groups: [{ chat_id: 'oc_1' }] }, 'oc_1'), false);
  assert.equal(smartGroup({ smart_groups: [{ chat_id: 'oc_1' }] }, 'oc_1'), true);
});
test('external defaults observe, explicit internal defaults auto', () => {
  assert.deepEqual(groupGatePolicy({}, 'oc_1'), { internal: false, gateMode: 'observe' });
  assert.equal(groupGatePolicy({ groups: { oc_1: { internal: true } } }, 'oc_1').gateMode, 'auto');
  assert.equal(groupGatePolicy({ groups: { oc_1: { gateMode: 'auto' } } }, 'oc_1').gateMode, 'observe');
});
test('explicit off/observe and requireMention honored', () => {
  for (const gateMode of ['off', 'observe']) assert.equal(groupGatePolicy({ groups: { oc_1: { internal: true, gateMode } } }, 'oc_1').gateMode, gateMode);
  assert.equal(groupGatePolicy({ groups: { oc_1: { internal: true, requireMention: true } } }, 'oc_1').gateMode, 'off');
});
test('reply to bot counts; reply to another user and @everyone do not', () => {
  assert.equal(replyIsBot({ sender: { id: 'ou_bot' } }, 'ou_bot'), true);
  assert.equal(replyIsBot({ sender: { id: 'app_bot', sender_type: 'app' } }, '', 'app_bot'), true);
  assert.equal(replyIsBot({ sender: { id: 'ou_other' } }, 'ou_bot'), false);
  assert.equal(isBotMentioned([{ key: '@_all', id: { open_id: 'ou_bot' } }], 'ou_bot'), false);
});

test('actual handler retains external unmentioned message without replies or typing', async () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleMessage(data)');
  const end = source.indexOf('// Transport: WebSocket', start);
  const calls = []; const replies = [];
  const context = { config: {}, ARCH2: true, botOpenId: 'ou_bot', botAppId: 'app_bot', botTenantKey: 'own', classifyGroup: async () => false, isDuplicate: () => false,
    console: { log() {}, warn() {}, error() {} }, extractMessageContent: () => ({ text: '闲聊', imageKeys: [] }),
    buildEndpoint: () => 'oc_new|type:group', sendToC4: (...args) => calls.push(args),
    fetchQuotedMessage: async () => null, isBotMentioned, isOwner: () => false,
    isGroupAllowed: id => receivedGroupAllowed(context.config, id), isSmartGroup: id => smartGroup(context.config, id),
    saveConfig: () => true, isSenderAllowedInGroup: () => true, groupGatePolicy,
    logMessage: async () => {}, resolveUserName: async () => '用户', resolveMentions: text => text,
    getGroupName: () => '新群', formatMessage: (_type, _name, text) => text,
    addTypingIndicator: () => replies.push('typing'), replyToMessage: () => { replies.push('reply'); return Promise.resolve(); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.handleMessage({ message: { chat_type: 'group', chat_id: 'oc_new', message_id: 'om_new', mentions: [] }, sender: { sender_id: { open_id: 'ou_person' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], null, 'no rejection reply callback for external unmentioned');
  assert.equal(calls[0][4].needsGate, true);
  assert.equal(calls[0][4].mentioned, false);
  assert.equal(context.config.groups.oc_new.mode, 'smart');
  assert.equal(groupGatePolicy(context.config, 'oc_new').gateMode, 'observe');
  context.config.groups.oc_new.internal = true;
  assert.equal(groupGatePolicy(context.config, 'oc_new').gateMode, 'auto');
  assert.deepEqual(replies, []);
});
