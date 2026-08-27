import assert from 'node:assert/strict';
import test from 'node:test';

import { isRetryableC4Failure } from '../src/lib/c4-retry-policy.js';

test('retries transient structured Core errors instead of dead-lettering immediately', () => {
  for (const code of ['INTERNAL_ERROR', 'UNHEALTHY_NOTIFY_FAILED', 'C4_TRANSPORT_FAILED']) {
    assert.equal(isRetryableC4Failure({ ok: false, error: { code } }), true, code);
  }
});

test('does not retry deterministic Core input, authorization, and idempotency errors', () => {
  for (const code of [
    'INVALID_ARGS',
    'INVALID_TRANSITION',
    'INVALID_CONFIRMATION_CAPABILITY',
    'FORBIDDEN',
    'IDEMPOTENCY_CONFLICT',
    'CONFIRMATION_ALREADY_RESOLVED',
    'TASK_INTAKE_FAILED',
    'VERSION_CONFLICT',
  ]) {
    assert.equal(isRetryableC4Failure({ ok: false, error: { code } }), false, code);
  }
});
