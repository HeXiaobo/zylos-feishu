import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEndpoint } from '../src/lib/endpoint.js';
import {
  CHAT_LOOKUP_TIMEOUT_MS,
  chatTypeFromChatMode,
  isValidSessionGroup,
  readChatTypeCache,
  recordChatType,
  resolveSessionGroup,
  SESSION_GROUP_MAX_LENGTH,
  sessionGroupFromEndpoint
} from '../src/lib/session-group.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'session-group.js');

// Every script run gets its own HOME, so it never touches this host's cache,
// credentials or the Feishu API.
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-session-group-'));
const cacheFileIn = home => path.join(home, 'zylos/components/feishu/chat-type-cache.json');
const tmpCachePath = () => path.join(tmpHome(), 'chat-type-cache.json');

// Realistic shapes: chat_id is oc_ + 32 chars, thread_id is omt_ + 16 chars.
const CHAT = 'oc_0123456789abcdef0123456789abcdef';
const GROUP_CHAT = 'oc_fedcba9876543210fedcba9876543210';
const THREAD = 'omt_0a1b2c3d4e5f6a7b';

// Mapping table: DM, group, reply chain, topic
const MAPPING = [
  ['DM', buildEndpoint(CHAT, { chatType: 'p2p', messageId: 'om_1' }), `dm-${CHAT}`],
  ['DM thread is not split', buildEndpoint(CHAT, { chatType: 'p2p', rootId: 'om_r', messageId: 'om_1', threadId: THREAD }), `dm-${CHAT}`],
  ['group', buildEndpoint(GROUP_CHAT, { chatType: 'group', messageId: 'om_1' }), `group-${GROUP_CHAT}`],
  ['group reply chain without thread stays in the group',
    buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r', parentId: 'om_p', messageId: 'om_1' }), `group-${GROUP_CHAT}`],
  ['group topic', buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r', messageId: 'om_1', threadId: THREAD }),
    `group-${GROUP_CHAT}:topic-${THREAD}`],
];

for (const [label, endpoint, expected] of MAPPING) {
  test(`maps ${label}`, () => {
    const name = sessionGroupFromEndpoint(endpoint);
    assert.equal(name, expected);
    assert.ok(isValidSessionGroup(name), `${name} must be valid for Core`);
    assert.ok(!name.startsWith('feishu:'), 'Core adds the namespace, not the component');
  });
}

test('topic group name fits Core limits with room to spare', () => {
  const name = sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|thread:${THREAD}`);
  assert.equal(name.length, 68);
});

test('per-message parts (msg, root, parent) never change the group', () => {
  const a = buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r1', parentId: 'om_p1', messageId: 'om_1', threadId: THREAD });
  const b = buildEndpoint(GROUP_CHAT, { chatType: 'group', rootId: 'om_r2', parentId: 'om_p2', messageId: 'om_2', threadId: THREAD });
  assert.equal(sessionGroupFromEndpoint(a), sessionGroupFromEndpoint(b));
  assert.equal(
    sessionGroupFromEndpoint(`${CHAT}|type:p2p|msg:om_1`),
    sessionGroupFromEndpoint(`${CHAT}|type:p2p|msg:om_2|parent:om_9`)
  );
  assert.equal(
    sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|msg:om_1`),
    sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|msg:om_2|root:om_8`)
  );
});

test('different topics in one group map to different groups', () => {
  const a = sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|thread:omt_a`);
  const b = sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group|thread:omt_b`);
  assert.notEqual(a, b);
  assert.notEqual(a, sessionGroupFromEndpoint(`${GROUP_CHAT}|type:group`));
});

test('isValidSessionGroup follows Core rules', () => {
  assert.ok(isValidSessionGroup('a'.repeat(SESSION_GROUP_MAX_LENGTH)));
  assert.ok(!isValidSessionGroup('a'.repeat(SESSION_GROUP_MAX_LENGTH + 1)));
  assert.ok(!isValidSessionGroup(''));
  assert.ok(!isValidSessionGroup('-x'));
  assert.ok(!isValidSessionGroup('a b'));
  assert.ok(!isValidSessionGroup(42));
});

// Total length = 'group-'(6) + chat + ':topic-'(7) + 'omt_x'(5)
const chatForLength = total => `oc_${'a'.repeat(total - 6 - 7 - 5 - 3)}`;

test('a 95-character name is accepted', () => {
  const name = sessionGroupFromEndpoint(`${chatForLength(95)}|type:group|thread:omt_x`);
  assert.equal(name.length, 95);
});

// Invalid input always throws - no guessing, rewriting or truncation
const INVALID = [
  ['empty endpoint', ''],
  ['bare chat id without type (never guessed)', CHAT],
  ['chat id with thread but no type', `${CHAT}|thread:${THREAD}`],
  ['unknown type', `${CHAT}|type:topic`],
  ['empty type', `${CHAT}|type:`],
  ['empty chat id', '|type:p2p'],
  ['chat id with a dot', 'oc_a.b|type:group'],
  ['chat id with a colon', 'oc_a:b|type:group'],
  ['chat id with @', 'oc_a@b|type:p2p'],
  ['chat id with a space', 'oc_a b|type:p2p'],
  ['chat id starting with -', '-oc_a|type:p2p'],
  ['empty thread', `${GROUP_CHAT}|type:group|thread:`],
  ['thread with illegal characters', `${GROUP_CHAT}|type:group|thread:omt_a/b`],
  ['thread with a colon', `${GROUP_CHAT}|type:group|thread:omt:a`],
  ['96-character name (not truncated)', `${chatForLength(96)}|type:group|thread:omt_x`],
];

for (const [label, endpoint] of INVALID) {
  test(`throws on ${label}`, () => {
    assert.throws(() => sessionGroupFromEndpoint(endpoint));
  });
}

test('throws on non-string input', () => {
  assert.throws(() => sessionGroupFromEndpoint(undefined));
  assert.throws(() => sessionGroupFromEndpoint(null));
});

// Query script agrees with the inbound mapping
const scriptEnv = home => ({ ...process.env, HOME: home, FEISHU_APP_ID: '', FEISHU_APP_SECRET: '' });
const runScript = (...args) => spawnSync(process.execPath, [SCRIPT, ...args],
  { encoding: 'utf8', env: scriptEnv(tmpHome()) });

test('scripts/session-group.js prints the same group as the inbound mapping', () => {
  for (const [, endpoint, expected] of MAPPING) {
    const out = execFileSync(process.execPath, [SCRIPT, endpoint], { encoding: 'utf8', env: scriptEnv(tmpHome()) });
    assert.equal(out, `${sessionGroupFromEndpoint(endpoint)}\n`);
    assert.equal(out.trim(), expected);
  }
});

test('scripts/session-group.js exits 1 with empty stdout on bad usage or input', () => {
  const cases = [
    [],
    ['a', 'b'],
    [`${CHAT}|type:p2p`, 'extra'], // valid endpoint plus an extra argument
    [CHAT], // bare chat id, cache miss and the lookup fails (no credentials): never guessed
    ['oc_a.b'], // bare id with unexpected characters: no lookup
    [''],
    [`${CHAT}|type:topic`],
    [`${chatForLength(96)}|type:group|thread:omt_x`],
  ];
  for (const args of cases) {
    const r = runScript(...args);
    assert.equal(r.status, 1, `args ${JSON.stringify(args)}`);
    assert.equal(r.stdout, '', `args ${JSON.stringify(args)}`);
    assert.ok(r.stderr.length > 0, `args ${JSON.stringify(args)}`);
  }
});

// Bare chat id (proactive sends): chat type cache, then Feishu im.chat.get

test('chatTypeFromChatMode maps p2p, group and topic chats only', () => {
  assert.equal(chatTypeFromChatMode('p2p'), 'p2p');
  assert.equal(chatTypeFromChatMode('group'), 'group');
  assert.equal(chatTypeFromChatMode('topic'), 'group');
  assert.equal(chatTypeFromChatMode(''), null);
  assert.equal(chatTypeFromChatMode(undefined), null);
  assert.equal(chatTypeFromChatMode('private'), null);
});

test('lookup timeout stays well under Core\'s 6.5s session-group query limit', () => {
  assert.ok(CHAT_LOOKUP_TIMEOUT_MS <= 5000);
});

const noFetch = async () => { throw new Error('API must not be called'); };

test('endpoint with |type: is unchanged and never looks anything up', async () => {
  const cachePath = tmpCachePath();
  for (const [, endpoint, expected] of MAPPING) {
    assert.equal(await resolveSessionGroup(endpoint, { cachePath, fetchChatMode: noFetch }), expected);
  }
  // a typed endpoint wins over a cached type
  recordChatType(CHAT, 'group', cachePath);
  assert.equal(await resolveSessionGroup(`${CHAT}|type:p2p`, { cachePath, fetchChatMode: noFetch }), `dm-${CHAT}`);
});

test('endpoint with | parts but no type still throws without a lookup', async () => {
  await assert.rejects(resolveSessionGroup(`${CHAT}|thread:${THREAD}`, { cachePath: tmpCachePath(), fetchChatMode: noFetch }));
  await assert.rejects(resolveSessionGroup(`${CHAT}|type:topic`, { cachePath: tmpCachePath(), fetchChatMode: noFetch }));
});

test('bare chat id: cache hit maps p2p to dm- and group to group- without an API call', async () => {
  const cachePath = tmpCachePath();
  recordChatType(CHAT, 'p2p', cachePath);
  recordChatType(GROUP_CHAT, 'group', cachePath);
  assert.equal(await resolveSessionGroup(CHAT, { cachePath, fetchChatMode: noFetch }), `dm-${CHAT}`);
  assert.equal(await resolveSessionGroup(GROUP_CHAT, { cachePath, fetchChatMode: noFetch }), `group-${GROUP_CHAT}`);
});

for (const [chatMode, expected] of [['p2p', `dm-${CHAT}`], ['group', `group-${CHAT}`], ['topic', `group-${CHAT}`]]) {
  test(`bare chat id: cache miss, im.chat.get chat_mode ${chatMode} -> ${expected.split('-')[0]}- (and cached)`, async () => {
    const cachePath = tmpCachePath();
    const calls = [];
    const fetchChatMode = async id => { calls.push(id); return chatMode; };
    assert.equal(await resolveSessionGroup(CHAT, { cachePath, fetchChatMode }), expected);
    assert.deepEqual(calls, [CHAT]);
    assert.equal(readChatTypeCache(cachePath)[CHAT], chatMode === 'p2p' ? 'p2p' : 'group');
    // second call is served from the cache
    assert.equal(await resolveSessionGroup(CHAT, { cachePath, fetchChatMode }), expected);
    assert.equal(calls.length, 1);
  });
}

test('bare chat id: API failure, timeout or unknown chat_mode throws and caches nothing', async () => {
  const failures = [
    async () => { throw new Error('Failed to get chat info: no permission'); },
    () => new Promise(() => {}), // never answers
    async () => 'unknown_mode',
    async () => undefined,
  ];
  for (const fetchChatMode of failures) {
    const cachePath = tmpCachePath();
    await assert.rejects(resolveSessionGroup(CHAT, { cachePath, fetchChatMode, timeoutMs: 50 }), /cannot look up chat type/);
    assert.deepEqual(readChatTypeCache(cachePath), {});
  }
});

test('bare chat id with unexpected characters throws without a lookup', async () => {
  for (const id of ['oc_a.b', 'oc_a b', '-oc_a', '']) {
    await assert.rejects(resolveSessionGroup(id, { cachePath: tmpCachePath(), fetchChatMode: noFetch }));
  }
});

test('missing or corrupt cache file is tolerated (treated as empty, then rewritten)', async () => {
  const missing = tmpCachePath();
  assert.deepEqual(readChatTypeCache(missing), {});
  for (const content of ['{not json', '[1,2]', 'null', '']) {
    const cachePath = tmpCachePath();
    fs.writeFileSync(cachePath, content);
    assert.deepEqual(readChatTypeCache(cachePath), {});
    assert.equal(await resolveSessionGroup(CHAT, { cachePath, fetchChatMode: async () => 'p2p' }), `dm-${CHAT}`);
    assert.deepEqual(readChatTypeCache(cachePath), { [CHAT]: 'p2p' });
  }
  // a cached value that is not p2p/group is ignored and looked up again
  const cachePath = tmpCachePath();
  fs.writeFileSync(cachePath, JSON.stringify({ [CHAT]: 'topic' }));
  assert.equal(await resolveSessionGroup(CHAT, { cachePath, fetchChatMode: async () => 'group' }), `group-${CHAT}`);
});

test('recordChatType writes atomically, only on change, and ignores invalid input', () => {
  const cachePath = path.join(tmpHome(), 'nested', 'chat-type-cache.json');
  assert.equal(recordChatType(CHAT, 'p2p', cachePath), true);
  assert.equal(recordChatType(CHAT, 'p2p', cachePath), false); // unchanged: no write
  assert.equal(recordChatType(CHAT, 'group', cachePath), true);
  assert.equal(recordChatType('oc_a.b', 'p2p', cachePath), false);
  assert.equal(recordChatType(GROUP_CHAT, 'topic', cachePath), false);
  assert.equal(recordChatType(GROUP_CHAT, undefined, cachePath), false);
  assert.deepEqual(readChatTypeCache(cachePath), { [CHAT]: 'group' });
  assert.deepEqual(fs.readdirSync(path.dirname(cachePath)), ['chat-type-cache.json']); // no tmp left
});

test('inbound handler records the chat type for every message, right after building the endpoint', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /import \{ recordChatType \} from '\.\/lib\/session-group\.js';/);
  const handler = src.slice(src.indexOf('async function handleMessage('));
  const build = handler.indexOf('const endpoint = buildEndpoint(chatId, { chatType,');
  const record = handler.indexOf('recordChatType(chatId, chatType);');
  assert.ok(build > 0 && record > build, 'recordChatType must follow buildEndpoint');
  // before any DM/group branch, so every inbound message is recorded
  assert.ok(record < handler.indexOf("if (chatType === 'p2p')"));
});

test('scripts/session-group.js: bare chat id from the cache prints dm-/group-', () => {
  const home = tmpHome();
  recordChatType(CHAT, 'p2p', cacheFileIn(home));
  recordChatType(GROUP_CHAT, 'group', cacheFileIn(home));
  const run = id => spawnSync(process.execPath, [SCRIPT, id], { encoding: 'utf8', env: scriptEnv(home) });
  const dm = run(CHAT);
  assert.equal(dm.status, 0, dm.stderr);
  assert.equal(dm.stdout, `dm-${CHAT}\n`);
  const group = run(GROUP_CHAT);
  assert.equal(group.status, 0, group.stderr);
  assert.equal(group.stdout, `group-${GROUP_CHAT}\n`);
});

test('scripts/session-group.js: bare chat id whose lookup fails logs to stderr, exits 1, prints nothing', () => {
  const home = tmpHome();
  const r = spawnSync(process.execPath, [SCRIPT, CHAT], { encoding: 'utf8', env: scriptEnv(home) });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /cannot look up chat type/);
  assert.ok(!fs.existsSync(cacheFileIn(home)), 'nothing cached on failure');
});
