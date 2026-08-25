import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskCardIdentityResolver } from '../src/lib/task-card-identity-resolver.js';

function task(identity) {
  return {
    ownerId: identity,
    acceptorId: identity,
    assigneeId: identity,
  };
}

test('deduplicates lookups and keeps a bounded TTL/LRU cache of Feishu names', async () => {
  let now = 1_000;
  const calls = [];
  const client = {
    contact: {
      user: {
        async get(payload) {
          const identity = payload.path.user_id;
          calls.push(identity);
          return { code: 0, data: { user: { name: `姓名-${identity.slice(-1)}` } } };
        },
      },
    },
  };
  const resolver = createTaskCardIdentityResolver({
    client,
    clock: () => now,
    ttlMs: 100,
    maxEntries: 2,
  });

  assert.deepEqual(await resolver.resolve(task('ou_a')), {
    owner: '姓名-a',
    acceptor: '姓名-a',
    assignee: '姓名-a',
  });
  await resolver.resolve(task('ou_b'));
  await resolver.resolve(task('ou_a')); // refresh A's LRU position
  await resolver.resolve(task('ou_c')); // evicts B
  await resolver.resolve(task('ou_b'));
  assert.deepEqual(calls, ['ou_a', 'ou_b', 'ou_c', 'ou_b']);

  now += 101;
  await resolver.resolve(task('ou_a'));
  assert.deepEqual(calls, ['ou_a', 'ou_b', 'ou_c', 'ou_b', 'ou_a']);
});

test('fails open with a readable, cached short label when Feishu lookup is unavailable', async () => {
  let calls = 0;
  const resolver = createTaskCardIdentityResolver({
    client: {
      contact: {
        user: {
          async get() {
            calls += 1;
            throw new Error('contact API unavailable');
          },
        },
      },
    },
    clock: () => 1_000,
    ttlMs: 100,
    maxEntries: 2,
  });

  const first = await resolver.resolve(task('ou_0123456789'));
  const second = await resolver.resolve(task('ou_0123456789'));

  assert.deepEqual(first, {
    owner: '飞书成员（…456789）',
    acceptor: '飞书成员（…456789）',
    assignee: '飞书成员（…456789）',
  });
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(first), /ou_0123456789/);
});

test('renders the known logical agent as a colleague-facing name without a contact lookup', async () => {
  const resolver = createTaskCardIdentityResolver({
    client: {},
    clock: () => 1_000,
    ttlMs: 100,
    maxEntries: 2,
  });

  assert.deepEqual(await resolver.resolve(task('agent:yueran')), {
    owner: '玥然（AI）',
    acceptor: '玥然（AI）',
    assignee: '玥然（AI）',
  });
});
