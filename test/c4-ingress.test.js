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
test('actual sendToC4 passes metadata through execFile; retry uses same source id', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const functionSource = source.slice(source.indexOf('function sendToC4('), source.indexOf('/**\n * Build structured endpoint'));
  const calls = [];
  const context = { ingressArgs, INTERNAL_SECRET: 'fixture', C4_RECEIVE: '/fixture/c4-receive.js', process: { env: {} }, console: { log() {}, warn() {}, error() {} }, parseC4Response: () => null,
    setTimeout: cb => cb(), execFile: (_cmd, args, _opts, cb) => { calls.push(args); cb(calls.length === 1 ? Error('transient') : null, ''); } };
  vm.runInNewContext(`${functionSource}\nsendToC4('feishu','oc_1|type:group','hi',null,{sourceId:'om_1',chatId:'oc_1',senderId:'ou_1',mentioned:false,needsGate:true});`, context);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    for (const [flag, value] of [['--source-id', 'om_1'], ['--chat', 'oc_1'], ['--sender', 'ou_1'], ['--mentioned', '0']]) assert.equal(args[args.indexOf(flag) + 1], value);
    assert.ok(args.includes('--needs-gate'));
  }
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
  const context = { config: {}, botOpenId: 'ou_bot', botAppId: 'app_bot', botTenantKey: 'own', classifyGroup: async () => false, isDuplicate: () => false,
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
