import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createTaskActionContextSigner } from '../src/lib/task-action-context.js';
import { mapFeishuTaskAction } from '../src/lib/commitment-mapper.js';

const NOW = 1_700_000_000_000;
const SECRET = 'feishu-card-context-secret-32-bytes';

function signRawPayload(rawPayload, { secret = SECRET, version = 'v1' } = {}) {
  const payload = Buffer.from(rawPayload).toString('base64url');
  const versionedPayload = `${version}.${payload}`;
  const signature = createHmac('sha256', secret)
    .update(versionedPayload)
    .digest('base64url');
  return `${versionedPayload}.${signature}`;
}

test('issues a versioned task action context and verifies its Core-facing claims', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const token = contexts.issue({
    taskId: 'task-123',
    expectedVersion: 4,
    expiresAt: NOW + 60_000,
  });

  assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(contexts.verify(token), {
    taskId: 'task-123',
    expectedVersion: 4,
    expiresAt: NOW + 60_000,
  });
});

test('rejects tampered contexts and contexts signed with another secret', () => {
  const issuer = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const token = issuer.issue({
    taskId: 'task-authenticated',
    expectedVersion: 2,
    expiresAt: NOW + 60_000,
  });
  const [version, payload, signature] = token.split('.');
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
  const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  const otherSigner = createTaskActionContextSigner({
    secret: 'another-feishu-card-context-secret',
    clock: () => NOW,
  });

  assert.throws(() => issuer.verify(`${version}.${tamperedPayload}.${signature}`));
  assert.throws(() => issuer.verify(`${version}.${payload}.${tamperedSignature}`));
  assert.throws(() => otherSigner.verify(token));
});

test('rejects an authenticated context after its expiry time', () => {
  const issuer = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const token = issuer.issue({
    taskId: 'task-expiring',
    expectedVersion: 5,
    expiresAt: NOW + 1,
  });
  const expiredVerifier = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW + 2,
  });

  assert.throws(() => expiredVerifier.verify(token));
});

test('refuses to issue contexts with invalid or extra claims', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const valid = {
    taskId: 'task-valid',
    expectedVersion: 1,
    expiresAt: NOW + 60_000,
  };
  const invalidClaims = [
    undefined,
    null,
    [],
    {},
    { ...valid, taskId: '' },
    { ...valid, taskId: '   ' },
    { ...valid, taskId: 'x'.repeat(4096) },
    { ...valid, expectedVersion: 0 },
    { ...valid, expectedVersion: 1.5 },
    { ...valid, expectedVersion: '1' },
    { ...valid, expiresAt: NOW },
    { ...valid, expiresAt: 1.5 },
    { ...valid, expiresAt: 'later' },
    { ...valid, actorId: 'button-supplied-actor' },
  ];

  for (const claims of invalidClaims) {
    assert.throws(() => contexts.issue(claims), TypeError);
  }
});

test('fails closed for malformed or unsupported token formats', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const validToken = contexts.issue({
    taskId: 'task-format',
    expectedVersion: 1,
    expiresAt: NOW + 60_000,
  });
  const unsupportedVersionToken = signRawPayload(
    JSON.stringify({
      taskId: 'task-format',
      expectedVersion: 1,
      expiresAt: NOW + 60_000,
    }),
    { version: 'v2' },
  );
  const invalidTokens = [
    undefined,
    null,
    '',
    'v1',
    'v1.payload',
    'v1.*.signature',
    `${validToken}.extra`,
    unsupportedVersionToken,
  ];

  for (const token of invalidTokens) {
    assert.throws(() => contexts.verify(token));
  }
});

test('fails closed for authenticated payloads with invalid or actor claims', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const valid = {
    taskId: 'task-claims',
    expectedVersion: 1,
    expiresAt: NOW + 60_000,
  };
  const invalidPayloads = [
    '{',
    JSON.stringify([]),
    JSON.stringify({}),
    JSON.stringify({ ...valid, taskId: '' }),
    JSON.stringify({ ...valid, expectedVersion: 0 }),
    JSON.stringify({ ...valid, expectedVersion: 1.5 }),
    JSON.stringify({ ...valid, expiresAt: 'later' }),
    JSON.stringify({ ...valid, expiresAt: NOW }),
    JSON.stringify({ ...valid, actorId: 'button-supplied-actor' }),
  ];

  for (const rawPayload of invalidPayloads) {
    assert.throws(() => contexts.verify(signRawPayload(rawPayload)));
  }
});

test('rejects unsafe signer configuration and invalid clock results', () => {
  const validClock = () => NOW;
  const invalidOptions = [
    undefined,
    null,
    {},
    { secret: '', clock: validClock },
    { secret: 'too-short', clock: validClock },
    { secret: SECRET },
    { secret: SECRET, clock: null },
  ];

  for (const options of invalidOptions) {
    assert.throws(() => createTaskActionContextSigner(options), TypeError);
  }

  const invalidClockSigner = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => Number.NaN,
  });
  assert.throws(
    () => invalidClockSigner.issue({
      taskId: 'task-clock',
      expectedVersion: 1,
      expiresAt: NOW + 60_000,
    }),
    TypeError,
  );
});

test('verified claims compose with the action mapper while actor identity stays external', () => {
  const contexts = createTaskActionContextSigner({
    secret: SECRET,
    clock: () => NOW,
  });
  const verifiedClaims = contexts.verify(contexts.issue({
    taskId: 'task-compose',
    expectedVersion: 8,
    expiresAt: NOW + 60_000,
  }));

  assert.equal(Object.hasOwn(verifiedClaims, 'actorId'), false);
  assert.deepEqual(
    mapFeishuTaskAction({
      ...verifiedClaims,
      eventId: 'event-compose',
      action: 'submit',
      actorId: 'verified-feishu-event-actor',
    }),
    {
      command: {
        type: 'SubmitForReview',
        taskId: 'task-compose',
        actorId: 'verified-feishu-event-actor',
        idempotencyKey: 'feishu:event-compose:task-command',
      },
      expectedVersion: 8,
    },
  );
});
