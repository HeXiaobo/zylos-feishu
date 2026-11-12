import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  groupRejectAction,
  isBotMentioned,
  isSenderAllowedInGroup,
} from '../src/lib/feishu-group-policy.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

const BOT_OPEN_ID = 'ou_bot_fixture';
const CHAT_ID = 'oc_configured_fixture';
const OWNER_OPEN_ID = 'ou_owner_fixture';
const INTERNAL_TENANT = 'tenant_internal_fixture';
const EXTERNAL_TENANT = 'tenant_external_fixture';

function groupEvent({
  messageId = 'om_fixture_1',
  openId = 'ou_stranger_fixture',
  userId,
  tenantKey = EXTERNAL_TENANT,
  mentionBot = true,
} = {}) {
  return {
    message: {
      message_id: messageId,
      chat_id: CHAT_ID,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我看下这个' }),
      mentions: mentionBot
        ? [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'Bot' }]
        : [],
    },
    sender: {
      sender_id: { user_id: userId, open_id: openId },
      tenant_key: tenantKey,
      sender_type: 'user',
    },
  };
}

// Mirrors the group branch of handleMessage() in src/index.js for 0.3.6. The
// outbound ports are recorded so the test can assert exactly what left the
// process: a denied sender must produce no C4 delivery, and in the default
// silent mode no reply either.
function createIngressWiring(config, { smart = false, sendToC4 } = {}) {
  const replies = [];
  const coreCalls = [];
  return {
    replies,
    coreCalls,
    async handle(data) {
      const { message, sender } = data;
      const mentions = message.mentions;
      const senderUserId = sender.sender_id?.user_id;
      const senderOpenId = sender.sender_id?.open_id;
      const senderTenantKey = sender.tenant_key || '';
      const messageId = message.message_id;
      const chatId = message.chat_id;

      const mentioned = isBotMentioned(mentions, BOT_OPEN_ID);
      const senderIsOwner = [senderUserId, senderOpenId]
        .filter(Boolean)
        .includes(OWNER_OPEN_ID);

      const groupPolicy = config.groupPolicy || 'allowlist';
      if (groupPolicy === 'disabled') {
        if (mentioned) replies.push({ messageId, text: 'Sorry, group chat is currently disabled.' });
        return { outcome: 'group_disabled' };
      }
      const allowedGroup = groupPolicy === 'open' || Boolean(config.groups?.[chatId]);
      if (!allowedGroup && !(senderIsOwner && mentioned)) {
        if (mentioned) replies.push({ messageId, text: "Sorry, I'm not available in this group." });
        return { outcome: 'group_not_allowed' };
      }

      if (!isSenderAllowedInGroup(config, chatId, {
        userId: senderUserId,
        openId: senderOpenId,
        tenantKey: senderTenantKey,
      }) && !senderIsOwner) {
        if (mentioned) {
          const action = groupRejectAction(config);
          if (action !== 'silent') replies.push({ messageId, text: action.reply });
        }
        return { outcome: 'denied' };
      }

      if (smart && !mentioned) {
        return { outcome: 'smart_passive' };
      }

      coreCalls.push({ messageId, tenantKey: senderTenantKey });
      if (sendToC4) await sendToC4({ messageId, tenantKey: senderTenantKey });
      return { outcome: 'accepted' };
    },
  };
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

test('an external-tenant @mention is dropped without a reply and without reaching C4', async () => {
  const wiring = createIngressWiring(tenantConfig());

  const result = await wiring.handle(groupEvent());

  assert.equal(result.outcome, 'denied');
  assert.deepEqual(wiring.replies, [], 'silent mode must not answer the stranger');
  assert.deepEqual(wiring.coreCalls, [], 'a denied group message must not be forwarded');
});

test('the same mention from an allowed tenant is forwarded exactly once', async () => {
  const wiring = createIngressWiring(tenantConfig());

  const result = await wiring.handle(groupEvent({ tenantKey: INTERNAL_TENANT, openId: 'ou_teammate' }));

  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(wiring.coreCalls, [{ messageId: 'om_fixture_1', tenantKey: INTERNAL_TENANT }]);
  assert.deepEqual(wiring.replies, []);
});

test('a cross-tenant teammate in the config is forwarded despite an external tenant', async () => {
  const wiring = createIngressWiring(tenantConfig({
    internalCrossTenantUsers: ['ou_teammate_external'],
  }));

  const result = await wiring.handle(groupEvent({ openId: 'ou_teammate_external' }));

  assert.equal(result.outcome, 'accepted');
  assert.equal(wiring.coreCalls.length, 1);
});

test('groupRejectMode=reply answers once with the configured text and still skips C4', async () => {
  const wiring = createIngressWiring(tenantConfig({
    groupRejectMode: 'reply',
    groupRejectText: '这个群只对内部同事开放。',
  }));

  const result = await wiring.handle(groupEvent());

  assert.equal(result.outcome, 'denied');
  assert.deepEqual(wiring.replies, [{
    messageId: 'om_fixture_1',
    text: '这个群只对内部同事开放。',
  }]);
  assert.deepEqual(wiring.coreCalls, []);
});

test('a passive Smart-group denial stays silent even with groupRejectMode=reply', async () => {
  const wiring = createIngressWiring(tenantConfig({
    groupRejectMode: 'reply',
    groupRejectText: 'blocked',
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'smart', requireMention: false } },
  }), { smart: true });

  const result = await wiring.handle(groupEvent({ mentionBot: false }));

  assert.equal(result.outcome, 'denied');
  assert.deepEqual(wiring.replies, []);
  assert.deepEqual(wiring.coreCalls, []);
});

test('the owner still bypasses the sender policy', async () => {
  const wiring = createIngressWiring(tenantConfig());

  const result = await wiring.handle(groupEvent({ openId: OWNER_OPEN_ID }));

  assert.equal(result.outcome, 'accepted');
  assert.equal(wiring.coreCalls.length, 1);
});

test('without the new fields the ingress still matches the old allowFrom behavior', async () => {
  const legacyConfig = {
    groupPolicy: 'allowlist',
    owner: { bound: true, open_id: OWNER_OPEN_ID },
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention' } },
  };

  const open = createIngressWiring(legacyConfig);
  assert.equal((await open.handle(groupEvent())).outcome, 'accepted');

  const restricted = createIngressWiring({
    ...legacyConfig,
    groups: { [CHAT_ID]: { name: 'fixture', mode: 'mention', allowFrom: ['ou_known'] } },
  });
  assert.equal((await restricted.handle(groupEvent())).outcome, 'denied');
  assert.deepEqual(restricted.replies, [], 'the legacy denial was silent too');
});

// Source-level assertions: the wiring above must stay identical to the real
// service wiring, otherwise this test proves nothing about src/index.js.
test('src/index.js passes the Feishu tenant_key into the shared sender policy', () => {
  assert.match(
    indexSource,
    /const senderTenantKey = sender\.tenant_key \|\| '';/,
    'the inbound sender tenant_key must be read once per message',
  );
  assert.match(
    indexSource,
    /if \(!isSenderAllowedInGroup\(config, chatId, \{\n\s+userId: senderUserId,\n\s+openId: senderOpenId,\n\s+tenantKey: senderTenantKey,\n\s+\}\) && !senderIsOwner\) \{/,
    'the 0.3.6 group branch must call the lib policy with config and the tenant key',
  );
  assert.doesNotMatch(
    indexSource,
    /function isSenderAllowedInGroup\(chatId, senderUserId, senderOpenId\)/,
    'the local sender check must be gone',
  );
});

test('src/index.js routes sender-policy denials through groupRejectMode', () => {
  assert.match(
    indexSource,
    /rejectGroupSender\(\{\n\s+chatId,\n\s+messageId,\n\s+reasonCode: 'ACCESS_GROUP_SENDER_POLICY',\n\s+mentioned,\n\s+\}\)/,
    'sender-level denials must not use the unconditional rejection text',
  );
  assert.doesNotMatch(
    indexSource,
    /"Sorry, you don't have permission to interact with me in this group\."/,
    'the always-on denial text is replaced by groupRejectAction',
  );
  assert.match(
    indexSource,
    /function rejectGroupSender\(\{ chatId, messageId, reasonCode, mentioned \}\) \{\n\s+const action = groupRejectAction\(config\);\n\s+if \(action === 'silent'\) \{/,
    'rejectGroupSender must default to the silent action',
  );
});

test('0.3.6 keeps a single group ingress path', () => {
  assert.doesNotMatch(indexSource, /decideGroupSenderAccess/, 'the main-only shared helper must not be pulled in');
  assert.doesNotMatch(indexSource, /group-access-policy/, '0.3.6 has no group-access-policy module');
  assert.match(indexSource, /if \(chatType === 'group'\) \{/);
});
