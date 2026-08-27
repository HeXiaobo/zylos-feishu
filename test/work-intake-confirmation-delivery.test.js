import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkIntakeConfirmationDelivery } from '../src/lib/work-intake-confirmation-delivery.js';

test('a failed confirmation delivery survives restart and retries from the durable outbox', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'work-intake-delivery-'));
  const outboxPath = path.join(directory, 'confirmation-outbox.json');
  const request = {
    deliveryKey: 'feishu:om_recover:work-intake:r1:confirmation-card',
    deliveryUuid: 'zwi_1234567890123456789012345678901234567890',
    target: { kind: 'chat', id: 'oc_chat' },
    confirmation: {
      decision: { sourceKey: 'feishu:om_recover:work-intake:r1' },
      inboundEnvelope: { source: { messageId: 'om_recover' } },
      endpoint: 'oc_chat|type:p2p|msg:om_recover',
    },
  };
  try {
    const failing = createWorkIntakeConfirmationDelivery({
      outboxPath,
      deliver: async () => { throw new Error('Feishu unavailable'); },
      clock: () => 1_777_777_777_000,
    });
    await assert.rejects(() => failing.send(request), /Feishu unavailable/);
    assert.equal(failing.pending().length, 1);

    const attempts = [];
    const recovered = createWorkIntakeConfirmationDelivery({
      outboxPath,
      deliver: async (delivery) => {
        attempts.push(delivery);
        return { success: true, messageId: 'om_confirmation' };
      },
      clock: () => 1_777_777_778_000,
    });
    const result = await recovered.retryPending();
    assert.deepEqual(result, { attempted: 1, delivered: 1, failed: 0 });
    assert.equal(recovered.pending().length, 0);
    assert.equal(attempts[0].deliveryUuid, request.deliveryUuid);
    assert.deepEqual(attempts[0].confirmation, request.confirmation);
    assert.equal(Object.hasOwn(attempts[0], 'card'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
