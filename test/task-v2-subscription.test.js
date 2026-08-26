import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTaskV2SubscriptionAdapter,
  startTaskV2LongConnection,
} from '../src/lib/task-v2-subscription.js';

test('Task v2 subscription Adapter calls the bot subscription endpoint exactly once', async () => {
  const requests = [];
  const adapter = createTaskV2SubscriptionAdapter({
    client: {
      async request(request) {
        requests.push(request);
        return { code: 0, msg: 'success' };
      },
    },
  });

  assert.deepEqual(await adapter.subscribe(), { status: 'subscribed' });
  assert.deepEqual(requests, [{
    method: 'POST',
    url: '/open-apis/task/v2/task_v2/task_subscription?user_id_type=open_id',
  }]);
});

test('Task v2 subscription Adapter rejects a Feishu business failure', async () => {
  const adapter = createTaskV2SubscriptionAdapter({
    client: {
      async request() {
        return { code: 99991672, msg: 'missing task scope' };
      },
    },
  });

  await assert.rejects(
    adapter.subscribe(),
    /Task v2 subscription failed \(99991672\): missing task scope/,
  );
});

test('Task v2 long connection subscribes before starting the event transport', async () => {
  const order = [];
  await startTaskV2LongConnection({
    enabled: true,
    subscription: {
      async subscribe() { order.push('subscribe'); },
    },
    async start() { order.push('start'); },
  });

  assert.deepEqual(order, ['subscribe', 'start']);
});

test('Task v2 long connection stays stopped when subscription fails', async () => {
  let starts = 0;
  const outage = new Error('subscription unavailable');

  await assert.rejects(startTaskV2LongConnection({
    enabled: true,
    subscription: {
      async subscribe() { throw outage; },
    },
    async start() { starts += 1; },
  }), outage);

  assert.equal(starts, 0);
});
