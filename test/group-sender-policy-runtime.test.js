import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as policy from '../src/lib/feishu-group-policy.js';
import { decideGroupActivation } from '../src/lib/group-activation-policy.js';
import { createInMemoryCoreMessageIntake } from '../src/lib/core-message-intake-port.js';
import { createFeishuConversationGateway } from '../src/lib/feishu-conversation-gateway.js';
import { createReplyRefactorAuthorizer } from '../src/lib/group-reject-authorizer.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

const BOT_OPEN_ID = 'ou_bot_fixture';
const OWNER_OPEN_ID = 'ou_owner_fixture';
const CHAT_ID = 'oc_configured_fixture';
const INTERNAL_TENANT = 'tenant_internal_fixture';
const EXTERNAL_TENANT = 'tenant_external_fixture';

/**
 * Extract a top-level function body from src/index.js. The probe used by the
 * review does the same, so the tests exercise the real function text instead of
 * a hand-written stand-in.
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
      content: JSON.stringify({ text: '帮我看看这个' }),
      mentions: mentionBot
        ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Bot' }]
        : [],
    },
    sender,
  };
}

/**
 * Run the real handleMessage from src/index.js inside a vm context whose
 * network, log, and send ports are recording stubs. Only the boundary modules
 * are replaced; the group policy, history, and formatting code is the real one.
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
    isDmAllowed: async () => false,
    extractMessageContent: async () => ({ text: '帮我看看这个', imageKeys: [] }),
    buildEndpoint: () => 'endpoint',
    logMessage: async () => {},
    resolveUserName: async () => 'fixture',
    resolveMentions: (text) => text,
    getGroupName: () => 'fixture',
    hasExactBotMention: (mentions) => policy.isBotMentioned(mentions, BOT_OPEN_ID),
    decideGroupActivation,
    // Boundary modules: the group admission path never reaches these for a
    // denied message, and the allowed cases only need them to return empty.
    isExplicitTaskProtocolMessage: () => false,
    handleAuthorizedTaskInput: async () => ({ handled: false, route: null }),
    buildNaturalWorkIntakeEnvelope: () => null,
    resolveMergeForwardText: async (extracted) => extracted.text || '',
    openConversationResponse: async () => null,
    buildAssistantRequest: () => null,
    failConversationResponse: async () => false,
    settleTypingIndicator: async () => {},
    sendThreadAwareMessage: async () => {},
    fetchQuotedMessage: async () => null,
    pinRootMessage: (context) => context,
    downloadImage: async () => ({ success: false }),
    downloadFile: async () => ({ success: false }),
    buildSafeDownloadPath: () => null,
    MEDIA_DIR: '/tmp',
    saveCursors: () => true,
    authorizeConfiguredMemberAccess: async () => null,
    addTypingIndicator: async () => {},
    removeTypingIndicator: async () => {},
    preloadGroupMembers: async () => {},
    sendToC4: async (...args) => { c4.push(args); },
    replyToMessage: async (id, text) => { replies.push({ id, text }); },
    sendMessage: async (id, text) => { replies.push({ id, text }); },
    listMessages: listMessages || (async () => ({ success: false })),
    ...policy,
  };
  vm.createContext(ctx);
  vm.runInContext('const DEFAULT_HISTORY_LIMIT = 5; const chatHistories = new Map(); const _lazyLoadedContainers = new Set(); const groupCursors = {};', ctx);
  for (const name of [
    'resolveGroupConfig',
    'hasExplicitGroupConfig',
    'isGroupAllowed',
    'isSmartGroup',
    'rejectGroupSender',
    'getGroupHistoryLimit',
    'getHistoryKey',
    'recordHistoryEntry',
    'getInMemoryContext',
    'updateCursor',
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

test('B1: allowFrom no longer vetoes a tenant or cross-tenant grant (real handleMessage)', async () => {
  const config = tenantConfig({
    internalCrossTenantUsers: ['ou_cross'],
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention', allowFrom: ['ou_old'] } },
  });

  const byTenant = runtime(config);
  await byTenant.ctx.handleMessage(groupEvent({ openId: 'ou_new', tenantKey: INTERNAL_TENANT }));
  assert.equal(byTenant.c4.length, 1, 'tenant grant must reach C4 despite an allowFrom miss');

  const byCrossTenant = runtime(config);
  await byCrossTenant.ctx.handleMessage(groupEvent({ openId: 'ou_cross', tenantKey: EXTERNAL_TENANT }));
  assert.equal(byCrossTenant.c4.length, 1, 'cross-tenant grant must reach C4 despite an allowFrom miss');

  const stranger = runtime(config);
  await stranger.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: EXTERNAL_TENANT }));
  assert.equal(stranger.c4.length, 0, 'a sender with no grant stays denied');
  assert.deepEqual(stranger.replies, [], 'and stays silent by default');
});

// ---------------------------------------------------------------------------
// B2: every group denial follows groupRejectMode, precisely.
// ---------------------------------------------------------------------------

const denialMatrix = [
  { label: 'disabled group', config: () => tenantConfig({ groupPolicy: 'disabled', groups: {} }) },
  { label: 'unregistered group', config: () => tenantConfig({ groups: {} }) },
  { label: 'sender not allowed', config: () => tenantConfig({ internalCrossTenantUsers: [] }) },
];

for (const { label, config } of denialMatrix) {
  test(`B2: ${label} with an exact @mention stays silent by default`, async () => {
    const run = runtime(config());
    await run.ctx.handleMessage(groupEvent({ mentionBot: true }));

    assert.equal(run.c4.length, 0, 'a denied group message must not reach C4');
    assert.deepEqual(run.replies, [], 'silent is the default for every group denial');
  });

  test(`B2: ${label} with a passive message stays silent by default`, async () => {
    const run = runtime(config());
    await run.ctx.handleMessage(groupEvent({ mentionBot: false }));

    assert.equal(run.c4.length, 0);
    assert.deepEqual(run.replies, []);
  });

  test(`B2: ${label} answers once with groupRejectText in reply mode`, async () => {
    const run = runtime(config());
    run.ctx.config = { ...config(), groupRejectMode: 'reply', groupRejectText: 'blocked' };
    await run.ctx.handleMessage(groupEvent({ mentionBot: true }));

    assert.equal(run.c4.length, 0, 'reply mode must not admit the message');
    assert.deepEqual(run.replies, [{ id: 'om_fixture_1', text: 'blocked' }]);
  });

  test(`B2: ${label} stays outbound-free for a passive message even in reply mode`, async () => {
    const run = runtime(config());
    run.ctx.config = { ...config(), groupRejectMode: 'reply', groupRejectText: 'blocked' };
    await run.ctx.handleMessage(groupEvent({ mentionBot: false }));

    assert.equal(run.c4.length, 0);
    assert.deepEqual(run.replies, [], 'passive denial must never speak');
  });

  test(`B2: ${label} never sends a rejection to the owner, even in reply mode`, async () => {
    const run = runtime(config());
    run.ctx.config = { ...config(), groupRejectMode: 'reply', groupRejectText: 'blocked' };
    await run.ctx.handleMessage(groupEvent({ openId: OWNER_OPEN_ID }));

    // The denial result is unchanged: a disabled group still denies the owner.
    // What must never happen is the bot answering the account that owns it.
    assert.deepEqual(run.replies, [], 'the owner is not sent a rejection');
    assert.ok(run.c4.length <= 1);
  });

  test(`B2: ${label} does reject a non-owner in reply mode`, async () => {
    // Control for the owner case above: same config, same branch, different
    // sender — so the silent result there is the owner rule and not the mode.
    const run = runtime(config());
    run.ctx.config = { ...config(), groupRejectMode: 'reply', groupRejectText: 'blocked' };
    await run.ctx.handleMessage(groupEvent({ openId: 'ou_stranger_fixture' }));

    assert.deepEqual(run.replies, [{ id: 'om_fixture_1', text: 'blocked' }]);
    assert.equal(run.c4.length, 0);
  });
}

// ---------------------------------------------------------------------------
// B3 (accepted as designed): the history backfill is not filtered by sender.
// ---------------------------------------------------------------------------

test('B3 (accepted as designed): remote backfill is not filtered by sender', async () => {
  // The live ingress rejects the external sender, but the history API returns
  // sender ids only (no trustworthy tenant_key), so the next allowed message can
  // still receive the rejected text as group context. This is the documented
  // limitation; the assertion exists so a future change is deliberate.
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

  await run.ctx.handleMessage(groupEvent({ messageId: 'om_internal', openId: 'ou_teammate', tenantKey: INTERNAL_TENANT }));
  assert.equal(run.c4.length, 1, 'the allowed message still reaches C4');
  assert.equal(historyCalls, 1, 'history backfill still runs for a restricted group');
  assert.match(
    run.c4[0][2],
    /EXTERNAL_DENIED_PAYLOAD/,
    'known limitation: the rejected message is still injected as context',
  );
});

test('B3: groups without a sender policy keep the legacy remote backfill', async () => {
  let historyCalls = 0;
  const run = runtime({
    groupPolicy: 'allowlist',
    owner: { bound: true, open_id: OWNER_OPEN_ID },
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention' } },
  }, {
    listMessages: async () => {
      historyCalls += 1;
      return {
        success: true,
        messages: [{
          id: 'om_old',
          sender: 'ou_anyone',
          type: 'text',
          content: 'LEGACY_CONTEXT',
          createTime: '2026-11-12T01:00:00Z',
          mentions: [],
        }],
      };
    },
  });

  await run.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: EXTERNAL_TENANT }));
  assert.equal(historyCalls, 1, 'no new policy means the old behavior is unchanged');
  assert.equal(run.c4.length, 1);
  assert.match(run.c4[0][2], /LEGACY_CONTEXT/);
});

// ---------------------------------------------------------------------------
// B4: the new sender policy also applies to unconfigured open groups.
// ---------------------------------------------------------------------------

test('B4: an open group without an explicit entry still applies the tenant list', async () => {
  const config = tenantConfig({ groupPolicy: 'open', groups: {} });

  const external = runtime(config);
  await external.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: EXTERNAL_TENANT }));
  assert.equal(external.c4.length, 0, 'an unregistered open group must not admit an external tenant');
  assert.deepEqual(external.replies, []);

  const missingTenant = runtime(config);
  await missingTenant.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: null }));
  assert.equal(missingTenant.c4.length, 0, 'a missing tenant_key must not be treated as allowed');

  const internal = runtime(config);
  await internal.ctx.handleMessage(groupEvent({ openId: 'ou_teammate', tenantKey: INTERNAL_TENANT }));
  assert.equal(internal.c4.length, 1, 'an allowed tenant still passes in an open group');
});

test('B4: an open group with no new fields keeps the legacy allow-all result', async () => {
  const run = runtime({ groupPolicy: 'open', owner: { bound: true, open_id: OWNER_OPEN_ID }, groups: {} });
  await run.ctx.handleMessage(groupEvent({ openId: 'ou_stranger', tenantKey: EXTERNAL_TENANT }));
  assert.equal(run.c4.length, 1);
});

// ---------------------------------------------------------------------------
// B5: the refactor entry runs the same rejection once, through the gateway.
// ---------------------------------------------------------------------------

/**
 * Accept events through the real gateway, using the real
 * createReplyRefactorAuthorizer and the real group authorizer extracted from
 * src/index.js. Only the Feishu reply port is recorded instead of sent.
 */
async function acceptThroughGateway(config, events) {
  const directory = fs.mkdtempSync(path.join(globalThis.process.env.TMPDIR || '/tmp', 'feishu-b5-'));
  const core = createInMemoryCoreMessageIntake();
  const replies = [];
  const run = runtime(config);
  vm.runInContext(extract(indexSource, 'authorizeReplyRefactorMessage'), run.ctx);
  vm.runInContext(extract(indexSource, 'authorizeReplyRefactorMessageWithRejection'), run.ctx);
  const authorize = createReplyRefactorAuthorizer({
    authorizeGroup: run.ctx.authorizeReplyRefactorMessageWithRejection,
    reply: async (rejection) => { replies.push({ id: rejection.messageId, text: rejection.text }); },
  });
  const gateway = createFeishuConversationGateway({
    dbPath: path.join(directory, 'inbound.db'),
    accountRef: 'cli_fixture',
    authorize,
    coreIntake: core,
    workerId: 'b5-fixture',
    pollIntervalMs: 1,
  });
  try {
    const results = [];
    for (const event of events) {
      results.push(await gateway.accept({ ...event, event_id: event.message.message_id }));
    }
    return { results, replies, accepted: core.acceptedEffects().length };
  } finally {
    await gateway.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('B5: the refactor entry stays silent by default', async () => {
  const run = runtime(tenantConfig());
  vm.runInContext(extract(indexSource, 'authorizeReplyRefactorMessageWithRejection'), run.ctx);

  assert.equal(await run.ctx.authorizeReplyRefactorMessageWithRejection(groupEvent()), false);
});

test('B5: reply mode sends the configured text exactly once and never admits the message', async () => {
  const config = tenantConfig({ groupRejectMode: 'reply', groupRejectText: 'blocked' });
  const external = groupEvent({ messageId: 'om_external_b5' });
  // The same event delivered twice stands in for a WebSocket redelivery.
  const { results, replies, accepted } = await acceptThroughGateway(config, [external, external]);

  assert.deepEqual(replies, [{ id: 'om_external_b5', text: 'blocked' }]);
  assert.equal(accepted, 0, 'reply mode must not admit the message');
  assert.equal(results[0].status, 'ignored');
  assert.equal(results[1].status, 'ignored');
});

test('B5: reply mode keeps custom text per denial reason and leaves allowed senders alone', async () => {
  const config = tenantConfig({ groupRejectMode: 'reply', groupRejectText: '这个群只对内部同事开放。' });
  const { results, replies, accepted } = await acceptThroughGateway(config, [
    groupEvent({ messageId: 'om_denied', openId: 'ou_stranger', tenantKey: EXTERNAL_TENANT }),
    groupEvent({ messageId: 'om_allowed', openId: 'ou_teammate', tenantKey: INTERNAL_TENANT }),
  ]);

  assert.deepEqual(replies, [{ id: 'om_denied', text: '这个群只对内部同事开放。' }]);
  assert.deepEqual(results.map((result) => result.status), ['ignored', 'accepted']);
  assert.equal(accepted, 1);
});

test('B5: a passive denial produces no reply through the gateway even in reply mode', async () => {
  const config = tenantConfig({ groupRejectMode: 'reply', groupRejectText: 'blocked' });
  // A smart group turns an unmentioned message into passive traffic.
  config.groups[CHAT_ID].mode = 'smart';
  config.groups[CHAT_ID].requireMention = false;
  const { replies, accepted } = await acceptThroughGateway(config, [
    groupEvent({ mentionBot: false }),
  ]);

  assert.deepEqual(replies, []);
  assert.equal(accepted, 0);
});

// ---------------------------------------------------------------------------
// Wiring assertions: the tests above must track the real service.
// ---------------------------------------------------------------------------

test('src/index.js routes every group denial through groupRejectSender', () => {
  assert.doesNotMatch(
    indexSource,
    /"Sorry, you don't have permission to interact with me in this group\."/,
    'sender denials must not use a fixed text',
  );
  assert.doesNotMatch(
    indexSource,
    /'Sorry, group chat is currently disabled\.'/,
    'disabled-group denials must follow groupRejectMode too',
  );
  assert.doesNotMatch(
    indexSource,
    /"Sorry, I'm not available in this group\."/,
    'unregistered-group denials must follow groupRejectMode too',
  );
  assert.match(
    indexSource,
    /function rejectGroupSender\(\{ chatId, messageId, reasonCode, mentioned, senderIsOwner = false \}\) \{\n\s+const action = groupRejectAction\(config\);\n\s+if \(action === 'silent' \|\| senderIsOwner\) \{/,
    'a group rejection is silent by default and never answers the owner',
  );
  // Every group denial must reach that one function; two reasons come from the
  // composed access decision and one from the legacy disabled branch.
  assert.match(indexSource, /reasonCode: access\.reasonCode,\n\s+mentioned: mentionedAtIngress,\n\s+senderIsOwner: senderIsOwnerAtIngress,/);
});

