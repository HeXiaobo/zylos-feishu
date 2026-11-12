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

/**
 * Mirrors the group branch of handleMessage() in src/index.js for 0.3.6.
 *
 * This is a wiring sketch, not the real ingress: `group-sender-policy-runtime
 * .test.js` runs the actual handleMessage from src/index.js and is the
 * authoritative entry test. Here we only pin the branch shape — which decision
 * hands off to which reaction — so a refactor of src/index.js fails loudly.
 * The outbound ports are recorded to assert what left the process.
 */
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

      // Every group denial below goes through groupRejectAction, matching the
      // real rejectGroupSender(): silent by default, one reply on an explicit
      // mention, never on passive traffic.
      const reject = (outcome) => {
        const action = groupRejectAction(config);
        if (action !== 'silent' && mentioned) replies.push({ messageId, text: action.reply });
        return { outcome };
      };

      const groupPolicy = config.groupPolicy || 'allowlist';
      if (groupPolicy === 'disabled') return reject('group_disabled');
      const allowedGroup = groupPolicy === 'open' || Boolean(config.groups?.[chatId]);
      if (!allowedGroup && !(senderIsOwner && mentioned)) return reject('group_not_allowed');

      if (!isSenderAllowedInGroup(config, chatId, {
        userId: senderUserId,
        openId: senderOpenId,
        tenantKey: senderTenantKey,
      }) && !senderIsOwner) {
        return reject('denied');
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

test('an unregistered group answers with the same configured text in reply mode', async () => {
  const wiring = createIngressWiring(tenantConfig({
    groups: {},
    groupRejectMode: 'reply',
    groupRejectText: 'blocked',
  }));

  const result = await wiring.handle(groupEvent());

  assert.equal(result.outcome, 'group_not_allowed');
  assert.deepEqual(wiring.replies, [{ messageId: 'om_fixture_1', text: 'blocked' }]);
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
  assert.deepEqual(
    restricted.replies,
    [],
    'the default denial is silent; the legacy fixed text is gone',
  );
});

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
