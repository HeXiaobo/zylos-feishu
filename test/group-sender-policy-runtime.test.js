import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as policy from '../src/lib/feishu-group-policy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

const BOT_OPEN_ID = 'ou_bot_fixture';
const OWNER_OPEN_ID = 'ou_owner_fixture';
const CHAT_ID = 'oc_configured_fixture';
const INTERNAL_TENANT = 'tenant_internal_fixture';
const EXTERNAL_TENANT = 'tenant_external_fixture';

/**
 * Extract a top-level function body from src/index.js. The review probe uses
 * the same trick, so these tests execute the real function text instead of a
 * hand-written stand-in.
 */
function extract(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}

function groupEvent({
  messageId = 'om_fixture_1',
  openId = 'ou_stranger_fixture',
  tenantKey = EXTERNAL_TENANT,
  mentionBot = true,
  chatType = 'group',
} = {}) {
  const sender = { sender_id: { open_id: openId }, sender_type: 'user' };
  if (tenantKey !== null) sender.tenant_key = tenantKey;
  return {
    message: {
      message_id: messageId,
      chat_id: CHAT_ID,
      chat_type: chatType,
      message_type: 'text',
      content: JSON.stringify({ text: '帮我看下这个' }),
      mentions: mentionBot
        ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Bot' }]
        : [],
    },
    sender,
  };
}

/**
 * Run the real handleMessage from src/index.js in a vm context whose network,
 * log, and send ports are recording stubs. The group policy, history, and
 * formatting code stays the real one; only the boundary modules are replaced.
 */
function runtime(config, { listMessages } = {}) {
  const replies = [];
  const c4 = [];
  const ctx = {
    config,
    console: { log() {}, error() {}, warn() {} },
    botAppId: 'cli_bot_fixture',
    botOpenId: BOT_OPEN_ID,
    isDuplicate: () => false,
    isOwner: (_userId, openId) => openId === OWNER_OPEN_ID,
    isDmAllowed: () => false,
    extractMessageContent: () => ({ text: '帮我看下这个', imageKeys: [], fileKey: null, fileName: null }),
    buildEndpoint: () => 'endpoint',
    logMessage: async () => {},
    resolveUserName: async () => 'fixture',
    resolveMentions: (text) => text,
    getGroupName: () => 'fixture',
    bindOwner: async () => true,
    // Boundary modules: a denied message never reaches these.
    resolveMergeForwardText: async (extracted) => extracted.text || '',
    sendThreadAwareMessage: async () => {},
    fetchQuotedMessage: async () => null,
    pinRootMessage: (context) => context,
    downloadImage: async () => ({ success: false }),
    downloadFile: async () => ({ success: false }),
    buildSafeDownloadPath: () => null,
    MEDIA_DIR: '/tmp',
    addTypingIndicator: async () => {},
    removeTypingIndicator: async () => {},
    preloadGroupMembers: async () => {},
    updateCursor: () => {},
    sendToC4: async (...args) => { c4.push(args); },
    replyToMessage: async (id, text) => { replies.push({ id, text }); },
    sendMessage: async (id, text) => { replies.push({ id, text }); },
    listMessages: listMessages || (async () => ({ success: false })),
    ...policy,
  };
  vm.createContext(ctx);
  vm.runInContext(
    'const DEFAULT_HISTORY_LIMIT = 5; const chatHistories = new Map(); const _lazyLoadedContainers = new Set();',
    ctx,
  );
  for (const name of [
    'resolveGroupConfig',
    'isGroupAllowed',
    'isSmartGroup',
    'rejectGroupSender',
    'getGroupHistoryLimit',
    'getHistoryKey',
    'recordHistoryEntry',
    'getInMemoryContext',
    'getContextWithFallback',
    'getGroupContext',
    'escapeXml',
    'formatMessage',
  ]) {
    vm.runInContext(extract(indexSource, name), ctx);
  }
  vm.runInContext(extract(indexSource, 'handleMessage'), ctx);
  return { ctx, replies, c4 };
}

function tenantConfig(overrides = {}) {
  return {
    groupPolicy: 'allowlist',
    groupAllowTenants: [INTERNAL_TENANT],
    internalCrossTenantUsers: [],
    groupRejectMode: 'silent',
    groupRejectText: '',
    owner: { bound: true, open_id: OWNER_OPEN_ID },
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention' } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B1: the three grants are a union.
// ---------------------------------------------------------------------------

test('B1: an allowFrom miss no longer skips the tenant and cross-tenant grants', async () => {
  const config = tenantConfig({
    internalCrossTenantUsers: ['ou_cross'],
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention', allowFrom: ['ou_old'] } },
  });

  const byTenant = runtime(config);
  await byTenant.ctx.handleMessage(groupEvent({ openId: 'ou_new', tenantKey: INTERNAL_TENANT }));
  assert.equal(byTenant.c4.length, 1, 'the tenant grant must reach C4 despite the allowFrom miss');
  assert.deepEqual(byTenant.replies, []);

  const byCrossTenant = runtime(config);
  await byCrossTenant.ctx.handleMessage(groupEvent({ openId: 'ou_cross', tenantKey: EXTERNAL_TENANT }));
  assert.equal(byCrossTenant.c4.length, 1, 'the cross-tenant grant must reach C4 despite the allowFrom miss');

  const byAllowFrom = runtime(config);
  await byAllowFrom.ctx.handleMessage(groupEvent({ openId: 'ou_old', tenantKey: EXTERNAL_TENANT }));
  assert.equal(byAllowFrom.c4.length, 1, 'allowFrom itself still admits');

  const stranger = runtime(config);
  await stranger.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: EXTERNAL_TENANT }));
  assert.equal(stranger.c4.length, 0, 'a sender with no grant stays denied');
  assert.deepEqual(stranger.replies, [], 'and stays silent by default');
});

test('B1: allowFrom alone still denies a stranger and admits its own list', async () => {
  const config = tenantConfig({
    groupAllowTenants: [],
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention', allowFrom: ['ou_known'] } },
  });

  const known = runtime(config);
  await known.ctx.handleMessage(groupEvent({ openId: 'ou_known', tenantKey: EXTERNAL_TENANT }));
  assert.equal(known.c4.length, 1);

  const stranger = runtime(config);
  await stranger.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: INTERNAL_TENANT }));
  assert.equal(stranger.c4.length, 0, 'a tenant grant cannot come from an empty tenant list');
  assert.deepEqual(stranger.replies, []);
});

// ---------------------------------------------------------------------------
// B2: every group denial follows groupRejectMode. Real handleMessage.
// ---------------------------------------------------------------------------

const denialMatrix = [
  { label: 'disabled group', config: () => tenantConfig({ groupPolicy: 'disabled', groups: {} }) },
  { label: 'unregistered group', config: () => tenantConfig({ groups: {} }) },
  { label: 'denied sender', config: () => tenantConfig() },
];

for (const { label, config } of denialMatrix) {
  test(`B2: ${label} with an exact @mention stays silent by default`, async () => {
    const run = runtime(config());
    await run.ctx.handleMessage(groupEvent({ mentionBot: true }));

    assert.equal(run.c4.length, 0, 'a denied group message must not reach C4');
    assert.deepEqual(run.replies, [], 'silent is the default for every group denial');
  });

  test(`B2: ${label} with an exact @mention answers once with groupRejectText in reply mode`, async () => {
    const run = runtime({ ...config(), groupRejectMode: 'reply', groupRejectText: 'blocked' });
    await run.ctx.handleMessage(groupEvent({ mentionBot: true }));

    assert.equal(run.c4.length, 0, 'reply mode must not admit the message');
    assert.deepEqual(run.replies, [{ id: 'om_fixture_1', text: 'blocked' }]);
  });

  test(`B2: ${label} stays outbound-free for a passive message even in reply mode`, async () => {
    const run = runtime({ ...config(), groupRejectMode: 'reply', groupRejectText: 'blocked' });
    await run.ctx.handleMessage(groupEvent({ mentionBot: false }));

    assert.equal(run.c4.length, 0);
    assert.deepEqual(run.replies, [], 'a passive denial must never speak');
  });
}

test('B2: a passive denial on a smart group stays silent by default', async () => {
  const run = runtime(tenantConfig({
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'smart', requireMention: false } },
  }));
  await run.ctx.handleMessage(groupEvent({ mentionBot: false }));

  assert.equal(run.c4.length, 0);
  assert.deepEqual(run.replies, []);
});

test('B2: the owner bypasses the sender policy and is never sent a rejection', async () => {
  const run = runtime(tenantConfig({ groupRejectMode: 'reply', groupRejectText: 'blocked' }));
  await run.ctx.handleMessage(groupEvent({ openId: OWNER_OPEN_ID }));

  assert.equal(run.c4.length, 1);
  assert.deepEqual(run.replies, [], 'the owner is admitted, so nothing is rejected');
});

test('B2: a disabled group still denies the owner, and does so silently', async () => {
  const run = runtime(tenantConfig({
    groupPolicy: 'disabled',
    groups: {},
    groupRejectMode: 'reply',
    groupRejectText: 'blocked',
  }));
  await run.ctx.handleMessage(groupEvent({ openId: OWNER_OPEN_ID }));

  assert.equal(run.c4.length, 0, 'the denial result is unchanged');
  assert.deepEqual(run.replies, [], 'the owner is never sent a rejection message');
});

test('B3 (accepted as designed): history backfill is not filtered by sender', async () => {
  // The review ruling keeps this behavior: record it so a future change to it
  // is a deliberate decision, not an accident.
  let historyCalls = 0;
  const run = runtime(tenantConfig(), {
    listMessages: async () => {
      historyCalls += 1;
      return {
        success: true,
        messages: [{
          id: 'om_external',
          sender: 'ou_stranger_fixture',
          type: 'text',
          content: 'EXTERNAL_DENIED_PAYLOAD',
          createTime: '2026-11-12T01:00:00Z',
          mentions: [],
        }],
      };
    },
  });

  await run.ctx.handleMessage(groupEvent({ messageId: 'om_external' }));
  assert.equal(run.c4.length, 0, 'the external message is rejected at ingress');

  await run.ctx.handleMessage(groupEvent({
    messageId: 'om_internal',
    openId: 'ou_teammate',
    tenantKey: INTERNAL_TENANT,
  }));
  assert.equal(run.c4.length, 1);
  assert.equal(historyCalls, 1, 'history backfill still runs for a restricted group');
  assert.match(run.c4[0][2], /EXTERNAL_DENIED_PAYLOAD/);
});

test('legacy config without the new fields keeps the old allow-all sender policy', async () => {
  const legacy = {
    groupPolicy: 'allowlist',
    owner: { bound: true, open_id: OWNER_OPEN_ID },
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention' } },
  };

  const open = runtime(legacy);
  await open.ctx.handleMessage(groupEvent({ openId: 'ou_anyone', tenantKey: EXTERNAL_TENANT }));
  assert.equal(open.c4.length, 1, 'no sender policy configured means every group member');

  const restricted = runtime({
    ...legacy,
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention', allowFrom: ['ou_known'] } },
  });
  await restricted.ctx.handleMessage(groupEvent({ openId: 'ou_stranger' }));
  assert.equal(restricted.c4.length, 0);
  assert.deepEqual(restricted.replies, [], 'the default denial is silent');
});

test('a DM denial still uses the private-chat text and not the group mode', async () => {
  const run = runtime(tenantConfig({ groupRejectMode: 'reply', groupRejectText: 'blocked' }));
  await run.ctx.handleMessage(groupEvent({ chatType: 'p2p', mentionBot: false }));

  assert.equal(run.c4.length, 0);
  assert.equal(run.replies.length, 1);
  assert.match(run.replies[0].text, /private messages/);
});

// ---------------------------------------------------------------------------
// Wiring assertions: the runtime tests above must track the real service.
// ---------------------------------------------------------------------------

test('src/index.js routes every group denial through rejectGroupSender', () => {
  assert.doesNotMatch(
    indexSource,
    /"Sorry, group chat is currently disabled\."/,
    'the disabled-group text must follow groupRejectMode',
  );
  assert.doesNotMatch(
    indexSource,
    /"Sorry, I'm not available in this group\."/,
    'the unregistered-group text must follow groupRejectMode',
  );
  assert.doesNotMatch(
    indexSource,
    /"Sorry, you don't have permission to interact with me in this group\."/,
    'the sender-denial text must follow groupRejectMode',
  );
  assert.match(
    indexSource,
    /function rejectGroupSender\(\{ chatId, messageId, reasonCode, mentioned \}\) \{\n\s+const action = groupRejectAction\(config\);/,
    'all group denials must share the configured rejection action',
  );
  for (const reasonCode of [
    'ACCESS_GROUP_DISABLED',
    'ACCESS_GROUP_NOT_ALLOWED',
    'ACCESS_GROUP_SENDER_POLICY',
  ]) {
    assert.match(
      indexSource,
      new RegExp(`rejectGroupSender\\(\\{\\n\\s+chatId,\\n\\s+messageId,\\n\\s+reasonCode: '${reasonCode}',`),
      `${reasonCode} must be answered through groupRejectMode`,
    );
  }
});

test('0.3.6 keeps a single group ingress path', () => {
  assert.doesNotMatch(indexSource, /decideGroupSenderAccess/, 'the main-only shared helper must not be pulled in');
  assert.doesNotMatch(indexSource, /group-access-policy/, '0.3.6 has no group-access-policy module');
  assert.match(indexSource, /if \(chatType === 'group'\) \{/);
});
