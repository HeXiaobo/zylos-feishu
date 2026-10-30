import test from 'node:test';
import assert from 'node:assert/strict';

import { isDmAllowed, isOwner } from '../src/lib/dm-policy.js';

// The recovery poller delivers straight to C4. If it keeps its own sender list,
// removing someone from the component's allowlist revokes them on one path only.

const owner = { bound: true, open_id: 'ou_owner', user_id: 'u_owner' };
const sender = { openId: 'ou_sender', userId: 'u_sender' };

test('owner is always allowed', () => {
  const config = { owner, dmPolicy: 'owner' };
  assert.equal(isOwner(config, { openId: 'ou_owner' }), true);
  assert.equal(isDmAllowed(config, { openId: 'ou_owner' }), true);
});

test('dmPolicy=owner rejects everyone but the owner', () => {
  const config = { owner, dmPolicy: 'owner' };
  assert.equal(isDmAllowed(config, sender), false);
});

test('dmPolicy=owner binds by user_id too', () => {
  const config = { owner, dmPolicy: 'owner' };
  assert.equal(isDmAllowed(config, { userId: 'u_owner' }), true);
});

test('an unbound owner allows nobody under dmPolicy=owner', () => {
  const config = { owner: { bound: false }, dmPolicy: 'owner' };
  assert.equal(isOwner(config, sender), false);
  assert.equal(isDmAllowed(config, sender), false);
});

test('allowlist accepts a listed id and rejects an unlisted one', () => {
  const allowed = { owner, dmPolicy: 'allowlist', dmAllowFrom: ['ou_sender'] };
  const removed = { owner, dmPolicy: 'allowlist', dmAllowFrom: ['ou_someone_else'] };
  assert.equal(isDmAllowed(allowed, sender), true);
  assert.equal(isDmAllowed(removed, sender), false);
  assert.equal(isDmAllowed({ owner, dmPolicy: 'allowlist', dmAllowFrom: [] }, sender), false);
});

test('allowlist matches on either id', () => {
  const config = { owner, dmPolicy: 'allowlist', dmAllowFrom: ['u_sender'] };
  assert.equal(isDmAllowed(config, { userId: 'u_sender' }), true);
  assert.equal(isDmAllowed(config, { openId: 'ou_sender' }), false);
});

test('open accepts anyone, and a missing policy behaves like owner', () => {
  assert.equal(isDmAllowed({ owner, dmPolicy: 'open' }, sender), true);
  assert.equal(isDmAllowed({ owner }, sender), false);
});
