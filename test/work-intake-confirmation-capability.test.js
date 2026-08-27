import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkIntakeConfirmationCapabilityIssuer } from '../src/lib/work-intake-confirmation-capability.js';

test('issues the exact short-lived capability contract consumed by C4', () => {
  const now = 1_787_900_000_000;
  const issuer = createWorkIntakeConfirmationCapabilityIssuer({
    secret: 'c4-work-intake-capability-secret-32-bytes',
    clock: () => now,
  });
  const token = issuer.issue({
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'create_task',
    actorId: 'ou_sender',
    expiresAt: now + 60_000,
    nonce: 'evt_card_action_1',
  });
  const [version, encodedClaims, signature] = token.split('.');
  assert.equal(version, 'wic1');
  assert.ok(signature);
  assert.deepEqual(JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')), {
    audience: 'c4-work-intake-confirmation',
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'create_task',
    actorId: 'ou_sender',
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: 'evt_card_action_1',
  });
});

test('rejects weak secrets and unbounded or unsupported capabilities', () => {
  assert.throws(
    () => createWorkIntakeConfirmationCapabilityIssuer({ secret: 'weak', clock: Date.now }),
    /at least 32 bytes/,
  );
  const now = 1_787_900_000_000;
  const issuer = createWorkIntakeConfirmationCapabilityIssuer({
    secret: 'c4-work-intake-capability-secret-32-bytes',
    clock: () => now,
  });
  assert.throws(() => issuer.issue({
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'delete',
    actorId: 'ou_sender',
    expiresAt: now + 60_000,
    nonce: 'evt_card_action_1',
  }), /unsupported/);
  assert.throws(() => issuer.issue({
    sourceKey: 'feishu:om_confirm:work-intake:r1',
    action: 'edit',
    actorId: 'ou_sender',
    expiresAt: now + 25 * 60 * 60_000,
    nonce: 'evt_card_action_1',
  }), /24 hours/);
});
