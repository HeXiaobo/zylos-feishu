import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completedCardFailureAction,
  requestIdForC4Delivery,
} from '../src/lib/c4-delivery-policy.js';

test('derives proactive idempotency from a stable C4 delivery identity', () => {
  const first = requestIdForC4Delivery({ C4_DELIVERY_ID: 'conversation:4821' });
  const replay = requestIdForC4Delivery({ C4_DELIVERY_ID: 'conversation:4821' });
  const different = requestIdForC4Delivery({ C4_DELIVERY_ID: 'conversation:4822' });

  assert.match(first, /^assistant\.feishu\.delivery\.[a-f0-9]{40}$/);
  assert.equal(replay, first);
  assert.notEqual(different, first);
  assert.equal(requestIdForC4Delivery({}), null);
  assert.equal(requestIdForC4Delivery({ C4_ASSISTANT_REQUEST_ID: 'assistant.feishu.om_1' }), 'assistant.feishu.om_1');
});

test('falls back to text only after an explicit zero-part rejection', () => {
  assert.equal(completedCardFailureAction({ deliveryOutcome: 'rejected', deliveredParts: 0 }), 'fallback_text');
  assert.equal(completedCardFailureAction({ deliveryOutcome: 'unknown', deliveredParts: 0 }), 'retry_same_delivery');
  assert.equal(completedCardFailureAction({ deliveryOutcome: 'rejected', deliveredParts: 1 }), 'retry_same_delivery');
  assert.equal(completedCardFailureAction(new Error('transport failed')), 'retry_same_delivery');
});
