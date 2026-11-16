// Wiring guard for the bot-identity fix (#49) inside src/index.js.
//
// src/index.js starts the service on import, so these checks read its source
// instead of executing it. They pin the three call sites that the unit tests
// in bot-identity.test.js cannot reach: the per-message wait, the startup
// fetch ordering and the guarded config write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');

function handleMessageBody() {
  const start = SRC.indexOf('async function handleMessage(data)');
  assert.ok(start >= 0, 'handleMessage(data) not found');
  const next = SRC.indexOf('\nfunction ', start + 1);
  const nextAsync = SRC.indexOf('\nasync function ', start + 1);
  const ends = [next, nextAsync].filter((i) => i > start);
  return SRC.slice(start, ends.length ? Math.min(...ends) : undefined);
}

function indexOfOnce(body, needle, label) {
  const first = body.indexOf(needle);
  assert.ok(first >= 0, `${label} missing`);
  assert.equal(body.indexOf(needle, first + 1), -1, `${label} must appear exactly once`);
  return first;
}

test('handleMessage awaits ensureForMessage exactly once, after dedup and before the mention check', () => {
  const body = handleMessageBody();
  const dedup = indexOfOnce(body, 'if (isDuplicate(messageId)) return;', 'dedup check');
  const wait = indexOfOnce(body, 'await botIdentity.ensureForMessage();', 'awaited ensureForMessage()');
  const mention = body.indexOf('isBotMentioned(mentions, botIdentity.openId)');
  assert.ok(mention >= 0, 'group mention check missing');
  assert.ok(dedup < wait, 'ensureForMessage must run after the dedup check (redeliveries must not wait)');
  assert.ok(wait < mention, 'ensureForMessage must run before the group mention check');
});

test('the startup fetch is awaited before either transport starts', () => {
  const fetch = indexOfOnce(SRC, 'await botIdentity.fetchAtStartup();', 'awaited fetchAtStartup()');
  const webhook = SRC.indexOf('startWebhook(creds);', fetch);
  const ws = SRC.indexOf('startWebSocket(creds);', fetch);
  assert.ok(webhook > fetch, 'startWebhook must be called after fetchAtStartup');
  assert.ok(ws > fetch, 'startWebSocket must be called after fetchAtStartup');
  assert.equal(SRC.lastIndexOf('startWebhook(creds);', fetch), -1, 'no startWebhook before fetchAtStartup');
  assert.equal(SRC.lastIndexOf('startWebSocket(creds);', fetch), -1, 'no startWebSocket before fetchAtStartup');
});

test('persist only adopts the new config when saveConfig succeeds', () => {
  const persist = SRC.indexOf('persist: (identity) => {');
  assert.ok(persist >= 0, 'persist hook missing');
  const block = SRC.slice(persist, SRC.indexOf('},', persist));
  assert.match(block, /const next = botIdentityConfigUpdate\(config, identity\);/);
  assert.match(block, /if \(!next\) return;/);
  assert.match(block, /if \(saveConfig\(next\)\) config = next;/);
  assert.doesNotMatch(block, /if \(!saveConfig/);
});
