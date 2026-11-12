import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decideGroupSenderAccess,
  groupRejectAction,
} from '../src/lib/feishu-group-policy.js';
import {
  decideGroupActivation,
} from '../src/lib/group-activation-policy.js';
import { decideGroupAccess } from '../src/lib/group-access-policy.js';
import { hasExactBotMention } from '../src/lib/feishu-work-intake-inbound.js';

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

// Mirrors the group ingress in src/index.js: resolve config, run the shared
// activation and access decisions, then honor groupRejectMode. The outbound
// ports are recorded so the test can assert exactly what left the service.
function createIngressWiring(config, { isSmartGroup = false, sendToC4 } = {}) {
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

      const mentionedAtIngress = hasExactBotMention(mentions, { botOpenId: BOT_OPEN_ID });
      const activation = decideGroupActivation({
        chatType: 'group',
        mentionedBot: mentionedAtIngress,
        smartMode: isSmartGroup,
      });
      if (!activation.process) return { outcome: 'ignored_before_access' };

      const senderIsOwner = [senderUserId, senderOpenId]
        .filter(Boolean)
        .includes(OWNER_OPEN_ID);
      const groupPolicy = config.groupPolicy || 'allowlist';
      const groupConfigured = Boolean(config.groups?.[message.chat_id]);
      const groupAllowed = groupPolicy === 'open'
        || (groupPolicy !== 'disabled' && groupConfigured);
      const memberAccess = null;

      const access = decideGroupSenderAccess({
        config,
        chatId: message.chat_id,
        userId: senderUserId,
        openId: senderOpenId,
        tenantKey: senderTenantKey,
        chatType: 'group',
        senderIsOwner,
        groupConfigured,
        groupAllowed,
        memberAccessAllowed: memberAccess,
        explicitActivation: mentionedAtIngress,
      });
      if (!access.allowed) {
        if (access.notifySender && access.reasonCode === 'ACCESS_GROUP_SENDER_POLICY') {
          const action = groupRejectAction(config);
          if (action !== 'silent' && mentionedAtIngress) {
            replies.push({ messageId: message.message_id, text: action.reply });
          }
        }
        return { outcome: 'denied', access };
      }

      coreCalls.push({ messageId: message.message_id, tenantKey: senderTenantKey });
      if (sendToC4) await sendToC4({ messageId: message.message_id, tenantKey: senderTenantKey });
      return { outcome: 'accepted', access };
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
  assert.equal(result.access.reasonCode, 'ACCESS_GROUP_SENDER_POLICY');
  assert.equal(result.access.rejectAction, 'silent');
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
  }), { isSmartGroup: true });

  const result = await wiring.handle(groupEvent({ mentionBot: false }));

  assert.equal(result.outcome, 'denied');
  assert.deepEqual(wiring.replies, []);
  assert.deepEqual(wiring.coreCalls, []);
});

test('the owner still bypasses the sender policy', async () => {
  const wiring = createIngressWiring(tenantConfig());

  const result = await wiring.handle(groupEvent({ openId: OWNER_OPEN_ID }));

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.access.reasonCode, 'ACCESS_OWNER');
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

// Source-level assertions: the ingress wiring above must stay identical to the
// real service wiring, otherwise this test proves nothing about src/index.js.
test('src/index.js passes the Feishu tenant_key into the shared sender policy', () => {
  assert.match(
    indexSource,
    /const senderTenantKey = sender\.tenant_key \|\| '';/,
    'the inbound sender tenant_key must be read once per message',
  );
  assert.match(
    indexSource,
    /const access = decideGroupSenderAccess\(\{\n\s+config,\n\s+chatId,\n\s+userId: senderUserId,\n\s+openId: senderOpenId,\n\s+tenantKey: senderTenantKey,/,
    'the ingress access decision must receive the sender tenant_key',
  );
  assert.match(
    indexSource,
    /tenantKey: senderTenantKey,\n\s+chatType,\n\s+senderIsOwner,\n\s+groupConfigured,/,
    'the reply-refactor authorizer must receive the sender tenant_key too',
  );
});

test('src/index.js routes sender-policy denials through groupRejectMode', () => {
  assert.match(
    indexSource,
    /if \(access\.reasonCode === 'ACCESS_GROUP_SENDER_POLICY'\) \{\n\s+\/\/ Sender-level denial honors groupRejectMode: silent by default\.\n\s+rejectGroupSender\(\{/,
    'sender-level denials must not use the unconditional rejection texts',
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

test('the shared sender policy keeps its decision order documented', () => {
  const groupPolicySource = fs.readFileSync(
    path.join(REPO_ROOT, 'src/lib/feishu-group-policy.js'),
    'utf8',
  );
  assert.match(groupPolicySource, /export function isSenderAllowedInGroup\(config, chatId, \{/);
  assert.match(groupPolicySource, /export function groupRejectAction\(config\)/);
  assert.doesNotMatch(indexSource, /function isSenderAllowedInGroup\(chatId, senderUserId, senderOpenId\)/);
  assert.equal(typeof decideGroupAccess, 'function');
});
