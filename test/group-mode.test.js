// smart-default: one config key, `defaultGroupMode`, decides the mode of a
// group that has no explicit entry of its own.
//
// The official component (zylos-ai/zylos-feishu 3018e4b) has no such key: a
// group receives every message only when config.json names it
// (`groups[chat_id].mode: "smart"`) or the legacy `smart_groups` list does.
// These tests pin three things:
//
//   1. with the key absent, every answer is the official answer;
//   2. with `defaultGroupMode: "smart"`, only groups that reached the decision
//      without an explicit mode become smart — `groupPolicy: "disabled"` and an
//      explicit mention-only group still win;
//   3. a value that is not exactly "smart" does nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { explicitGroupMode, isSmartGroup, listedAsSmart } from '../src/lib/group-mode.js';

const base = (overrides = {}) => ({ groupPolicy: 'allowlist', groups: {}, ...overrides });

// ── 1. official behaviour is untouched when the key is absent ───────────────

test('without the key an unlisted group is mention-only', () => {
  assert.equal(isSmartGroup(base(), 'oc_new'), false);
});

test('without the key a group registered as smart is smart', () => {
  const config = base({ groups: { oc_a: { mode: 'smart' } } });
  assert.equal(isSmartGroup(config, 'oc_a'), true);
});

test('without the key a group registered as mention stays mention-only', () => {
  const config = base({ groups: { oc_a: { mode: 'mention' } } });
  assert.equal(isSmartGroup(config, 'oc_a'), false);
});

test('requireMention false means smart, as in the official code', () => {
  const config = base({ groups: { oc_a: { requireMention: false } } });
  assert.equal(isSmartGroup(config, 'oc_a'), true);
});

test('the legacy smart_groups list still marks a group smart', () => {
  const config = base({ smart_groups: [{ chat_id: 'oc_legacy' }] });
  assert.equal(isSmartGroup(config, 'oc_legacy'), true);
});

test('groupPolicy disabled wins over everything, including the new key', () => {
  const config = base({ groupPolicy: 'disabled', defaultGroupMode: 'smart' });
  assert.equal(isSmartGroup(config, 'oc_any'), false);
});

// ── 2. the new key: only fills in a mode that does not exist ────────────────

test('with defaultGroupMode smart an unlisted group is smart', () => {
  assert.equal(isSmartGroup(base({ defaultGroupMode: 'smart' }), 'oc_new'), true);
});

test('an explicit mention mode still beats the new key', () => {
  const config = base({ defaultGroupMode: 'smart', groups: { oc_pin: { mode: 'mention' } } });
  assert.equal(isSmartGroup(config, 'oc_pin'), false);
});

test('an explicit requireMention true still beats the new key', () => {
  const config = base({ defaultGroupMode: 'smart', groups: { oc_pin: { requireMention: true } } });
  assert.equal(isSmartGroup(config, 'oc_pin'), false);
});

test('a group entry with no mode falls back to the new key', () => {
  // admin.js can create an entry with a name and historyLimit but no mode.
  const config = base({ defaultGroupMode: 'smart', groups: { oc_named: { name: '研发群' } } });
  assert.equal(isSmartGroup(config, 'oc_named'), true);
});

test('an explicit smart entry is smart with or without the key', () => {
  const config = base({ defaultGroupMode: 'smart', groups: { oc_a: { mode: 'smart' } } });
  assert.equal(isSmartGroup(config, 'oc_a'), true);
});

// ── 3. anything that is not exactly "smart" keeps the official behaviour ────

test('a value other than the literal string smart changes nothing', () => {
  for (const value of ['mention', 'SMART', ' smart', 'smart ', true, 1, '', null, undefined, 'yes']) {
    const config = base({ defaultGroupMode: value });
    assert.equal(isSmartGroup(config, 'oc_new'), false, `defaultGroupMode=${JSON.stringify(value)}`);
  }
});

// ── the helpers each answer one question ────────────────────────────────────

test('explicitGroupMode reports the official verdict and null when unset', () => {
  const config = base({ groups: {
    oc_smart: { mode: 'smart' },
    oc_mentioned: { mode: 'mention' },
    oc_require_off: { requireMention: false },
    oc_require_on: { requireMention: true },
    oc_named_only: { name: 'x' },
  } });
  assert.equal(explicitGroupMode(config, 'oc_smart'), 'smart');
  assert.equal(explicitGroupMode(config, 'oc_mentioned'), 'mention');
  assert.equal(explicitGroupMode(config, 'oc_require_off'), 'smart');
  assert.equal(explicitGroupMode(config, 'oc_require_on'), 'mention');
  assert.equal(explicitGroupMode(config, 'oc_named_only'), null);
  assert.equal(explicitGroupMode(config, 'oc_absent'), null);
});

test('listedAsSmart compares ids as strings', () => {
  const config = base({ smart_groups: [{ chat_id: 12345 }] });
  assert.equal(listedAsSmart(config, '12345'), true);
  assert.equal(listedAsSmart(config, '54321'), false);
});
