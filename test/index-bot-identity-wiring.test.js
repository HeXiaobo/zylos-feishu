// Wiring guard for the bot-identity fix (#49) inside src/index.js.
//
// src/index.js starts the service on import, so these checks read its source
// instead of executing it. They pin the three call sites that the unit tests
// in bot-identity.test.js cannot reach: the per-message wait, the startup
// fetch ordering and the guarded config write.
//
// Every needle is matched as a whole statement line (multiline anchors), and
// block comments are blanked first, so a commented-out call or the same text
// inside a string literal does not count as present.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RAW = readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8');
// Blank /* ... */ comments but keep offsets and line breaks intact.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

const ENSURE_LINE = /^[ \t]*await botIdentity\.ensureForMessage\(\);[ \t]*$/gm;
const FETCH_LINE = /^[ \t]*await botIdentity\.fetchAtStartup\(\);[ \t]*$/gm;
const DEDUP_LINE = /^[ \t]*if \(isDuplicate\(messageId\)\) return;[ \t]*$/gm;
const GUARD_LINE = /^[ \t]*if \(saveConfig\(next\)\) config = next;[ \t]*$/gm;

function matches(text, re) {
  return [...text.matchAll(re)].map((m) => m.index);
}

function onlyMatch(text, re, label) {
  const found = matches(text, re);
  assert.equal(found.length, 1, `${label}: expected exactly one statement line, found ${found.length}`);
  return found[0];
}

function callSites(name) {
  // Code lines (not // comments) that call botIdentity.<name>(
  return SRC.split('\n').filter((l) => !/^\s*\/\//.test(l) && l.includes(`botIdentity.${name}(`));
}

function handleMessageBody() {
  const start = SRC.indexOf('async function handleMessage(data)');
  assert.ok(start >= 0, 'handleMessage(data) not found');
  const ends = [SRC.indexOf('\nfunction ', start + 1), SRC.indexOf('\nasync function ', start + 1)]
    .filter((i) => i > start);
  return SRC.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('handleMessage awaits ensureForMessage exactly once, after dedup and before the mention check', () => {
  const body = handleMessageBody();
  const dedup = onlyMatch(body, DEDUP_LINE, 'dedup check');
  const wait = onlyMatch(body, ENSURE_LINE, 'awaited ensureForMessage()');
  const mention = body.search(/^[ \t]*const mentioned = isBotMentioned\(mentions, botIdentity\.openId\);/m);
  assert.ok(mention >= 0, 'group mention check missing');
  assert.ok(dedup < wait, 'ensureForMessage must run after the dedup check (redeliveries must not wait)');
  assert.ok(wait < mention, 'ensureForMessage must run before the group mention check');
  assert.equal(callSites('ensureForMessage').length, 1, 'ensureForMessage must have no other call site');
});

test('the startup fetch is awaited before either transport starts', () => {
  const fetch = onlyMatch(SRC, FETCH_LINE, 'awaited fetchAtStartup()');
  assert.equal(callSites('fetchAtStartup').length, 1, 'fetchAtStartup must have no other call site');
  for (const start of ['startWebhook', 'startWebSocket']) {
    const calls = matches(SRC, new RegExp(`^[ \\t]*${start}\\(creds\\);[ \\t]*$`, 'gm'));
    assert.ok(calls.length >= 1, `${start}(creds) call missing`);
    assert.ok(calls.every((i) => i > fetch), `${start} must only be called after fetchAtStartup`);
  }
});

test('persist only adopts the new config when saveConfig succeeds', () => {
  const persist = SRC.search(/^[ \t]*persist: \(identity\) => \{[ \t]*$/m);
  assert.ok(persist >= 0, 'persist hook missing');
  const block = SRC.slice(persist, SRC.indexOf('\n  },', persist));
  onlyMatch(block, /^[ \t]*const next = botIdentityConfigUpdate\(config, identity\);[ \t]*$/gm, 'config update');
  onlyMatch(block, /^[ \t]*if \(!next\) return;[ \t]*$/gm, 'no-op return');
  onlyMatch(block, GUARD_LINE, 'saveConfig guard');
  assert.equal(matches(block, /^[ \t]*config = next;/gm).length, 0, 'config must not be assigned unconditionally');
});
