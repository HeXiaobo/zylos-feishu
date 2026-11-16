import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBotIdentity,
  explainBotInfoError,
  isBotMentioned,
  cachedBotOpenId,
  botIdentityConfigUpdate,
  UNKNOWN_LOG_INTERVAL_MS,
} from '../src/lib/bot-identity.js';

const APP_ID = 'cli_current';
const FETCHED = { success: true, open_id: 'ou_fetched', app_name: 'TestBot' };
const FAILED = { success: false, message: 'network down' };

function mentionsBot(identity, mentionId) {
  return isBotMentioned([{ key: '@_user_1', id: { open_id: mentionId } }], identity.openId);
}

function setup({ results = [], appId = APP_ID, fetchImpl, ...overrides } = {}) {
  const calls = [];
  const persisted = [];
  const changes = [];
  const logs = [];
  const errors = [];
  let index = 0;
  const fetchBotInfo = fetchImpl || (async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result instanceof Error) throw result;
    return result;
  });
  const identity = createBotIdentity({
    fetchBotInfo: async () => {
      calls.push(Date.now());
      return fetchBotInfo();
    },
    appId,
    persist: (value) => persisted.push(value),
    onChange: (value) => changes.push(value),
    log: (msg) => logs.push(msg),
    logError: (msg) => errors.push(msg),
    ...overrides,
  });
  return { identity, calls, persisted, changes, logs, errors };
}

// The real path: index.js awaits ensureForMessage() once at the entry of
// every message event, then a group message runs isBotMentioned on the
// (possibly recovered) identity without waiting again.
async function groupMessage(identity, mentions = []) {
  await identity.ensureForMessage();
  return isBotMentioned(mentions, identity.openId);
}

test('uses cached identity when cached app_id matches the current app', () => {
  const { identity, calls } = setup();
  assert.equal(identity.loadCached({ open_id: 'ou_cached', app_id: APP_ID }), true);
  assert.equal(identity.openId, 'ou_cached');
  assert.equal(identity.status().status, 'cached');
  assert.equal(mentionsBot(identity, 'ou_cached'), true);
  assert.equal(calls.length, 0);
});

test('uses cached identity from an older config without app_id', () => {
  const { identity } = setup();
  assert.equal(identity.loadCached({ open_id: 'ou_cached' }), true);
  assert.equal(identity.status().status, 'cached');
  assert.equal(identity.openId, 'ou_cached');
});

test('ignores cached identity whose app_id differs from the current app', () => {
  const { identity } = setup();
  assert.equal(identity.loadCached({ open_id: 'ou_other', app_id: 'cli_other' }), false);
  assert.equal(identity.openId, '');
  assert.equal(identity.status().status, 'unknown');
});

test('successful startup fetch writes back open_id and app_id', async () => {
  const { identity, calls, persisted, changes } = setup({ results: [FETCHED] });
  await identity.fetchAtStartup();
  assert.equal(calls.length, 1);
  assert.equal(identity.openId, 'ou_fetched');
  assert.equal(identity.appName, 'TestBot');
  assert.equal(identity.status().status, 'fetched');
  assert.deepEqual(persisted, [{ openId: 'ou_fetched', appId: APP_ID }]);
  assert.deepEqual(changes.at(-1), { openId: 'ou_fetched', appName: 'TestBot', appId: APP_ID });
  await groupMessage(identity);
  assert.equal(calls.length, 1);
});

test('fetched value overrides a different cached value', async () => {
  const { identity, persisted, logs } = setup({ results: [FETCHED] });
  identity.loadCached({ open_id: 'ou_stale', app_id: APP_ID });
  await identity.fetchAtStartup();
  assert.equal(identity.openId, 'ou_fetched');
  assert.equal(identity.status().status, 'fetched');
  assert.deepEqual(persisted, [{ openId: 'ou_fetched', appId: APP_ID }]);
  assert.ok(logs.some((l) => l.includes('differs from fetched')));
});

test('startup failure with cached identity never refetches', async () => {
  const { identity, calls } = setup({ results: [FAILED, FETCHED] });
  identity.loadCached({ open_id: 'ou_cached', app_id: APP_ID });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 1);
  assert.equal(identity.status().status, 'cached');
  assert.equal(mentionsBot(identity, 'ou_cached'), true);
  identity.stop();
});

test('startup failure without cache: first message refetches and recovers before the mention check', async () => {
  const { identity, calls, persisted, logs } = setup({ results: [FAILED, FETCHED] });
  await identity.fetchAtStartup();
  assert.equal(identity.status().status, 'unknown');
  assert.equal(mentionsBot(identity, 'ou_fetched'), false);

  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().status, 'fetched');
  assert.equal(identity.status().refetchUsed, true);
  assert.equal(mentionsBot(identity, 'ou_fetched'), true);
  assert.deepEqual(persisted, [{ openId: 'ou_fetched', appId: APP_ID }]);
  assert.ok(logs.some((l) => l.includes('recovered on first message')));

  await groupMessage(identity);
  assert.equal(calls.length, 2);
});

test('failed refetch is never retried: getBotInfo call count stays at 2', async () => {
  const { identity, calls, errors } = setup({ results: [FAILED, FAILED, FETCHED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().attempts, 2);
  assert.equal(identity.status().status, 'unknown');
  assert.ok(errors.some((e) => e.includes('no further attempts')));
  identity.stop();
});

test('thrown fetch errors count as failures and are not retried', async () => {
  const { identity, calls } = setup({ results: [new Error('boom'), new Error('boom'), FETCHED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().status, 'unknown');
  identity.stop();
});

test('concurrent messages share one refetch request', async () => {
  let release;
  let count = 0;
  const { identity, calls } = setup({
    fetchImpl: async () => {
      count += 1;
      if (count === 1) return FAILED;
      await new Promise((resolve) => { release = resolve; });
      return FETCHED;
    },
  });
  await identity.fetchAtStartup();
  const seen = [];
  const pending = [1, 2, 3].map(() => groupMessage(identity).then(() => seen.push(identity.openId)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  release();
  await Promise.all(pending);
  assert.equal(calls.length, 2);
  // Every concurrent caller waited for the shared request before continuing.
  assert.deepEqual(seen, ['ou_fetched', 'ou_fetched', 'ou_fetched']);
});

test('startup fetch that never resolves: messages share one wait, next message uses the single refetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let count = 0;
  let releaseStartup;
  const { identity, calls, errors } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: async () => {
      count += 1;
      if (count === 1) {
        await new Promise((resolve) => { releaseStartup = resolve; });
        return FAILED;
      }
      return FETCHED;
    },
  });
  identity.fetchAtStartup();

  // Three messages during the hung startup share one 5s window.
  let done = 0;
  const waiting = [1, 2, 3].map(() => groupMessage(identity).then(() => { done += 1; }));
  await Promise.resolve();
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, 0);
  t.mock.timers.tick(1);
  await Promise.all(waiting);
  assert.equal(done, 3);
  assert.equal(calls.length, 1);
  assert.equal(identity.status().status, 'unknown');
  assert.ok(errors.some((e) => e.includes('still pending')));

  // A later message returns at once from the refetch (no further 5s wait).
  await groupMessage(identity);
  assert.equal(calls.length, 2);
  assert.equal(identity.status().status, 'fetched');
  assert.equal(identity.status().refetchUsed, true);

  // The 10-minute error log had started while the identity was unknown and
  // stopped on recovery; further messages make no requests.
  await groupMessage(identity);
  releaseStartup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(identity.status().status, 'fetched');
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  assert.equal(errors.filter((e) => e.includes('unknown for')).length, 0);
});

test('a message arriving later during a hung startup does not get a fresh 5s wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { identity, calls } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise(() => {}),
  });
  identity.fetchAtStartup();
  let firstDone = false;
  let secondDone = false;
  const first = groupMessage(identity).then(() => { firstDone = true; });
  await Promise.resolve();
  t.mock.timers.tick(3_000);
  const second = groupMessage(identity).then(() => { secondDone = true; });
  await Promise.resolve();
  t.mock.timers.tick(2_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstDone, true);
  // The second message shares the window that ends 5s after the first one.
  assert.equal(secondDone, true);
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  identity.stop();
});

test('hung startup starts the 10-minute error log once the shared wait times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let count = 0;
  const { identity, calls, errors } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: async () => {
      count += 1;
      if (count === 1) return new Promise(() => {});
      return FAILED;
    },
  });
  identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  assert.equal(errors.filter((e) => e.includes('unknown for')).length, 1);
  await groupMessage(identity);
  await groupMessage(identity);
  assert.equal(calls.length, 2);
  identity.stop();
});

test('late startup success after the shared wait timed out is applied without extra requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let releaseStartup;
  const { identity, calls } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise((resolve) => { releaseStartup = () => resolve(FETCHED); }),
  });
  identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  releaseStartup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(identity.status().status, 'fetched');
  await groupMessage(identity);
  assert.equal(calls.length, 1);
});

test('hung startup: one group message waits a single 5s window and does not refetch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { identity, calls } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise(() => {}),
  });
  identity.fetchAtStartup();
  let done = false;
  const mentions = [{ key: '@_user_1', id: { open_id: 'ou_fetched' } }];
  const message = groupMessage(identity, mentions).then((mentioned) => { done = true; return mentioned; });
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  // Done after exactly one window, handled as not mentioned, refetch unused.
  assert.equal(done, true);
  assert.equal(await message, false);
  assert.equal(calls.length, 1);
  assert.equal(identity.status().refetchUsed, false);
  identity.stop();
});

test('refetch started after a hung startup: late startup success first, then refetch success applies once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const resolvers = [];
  const { identity, calls, changes, persisted, logs } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  const second = groupMessage(identity);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  resolvers[0](FETCHED); // startup succeeds late, while the refetch is in flight
  await new Promise((resolve) => setImmediate(resolve));
  resolvers[1](FETCHED);
  await second;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(identity.status().status, 'fetched');
  assert.equal(changes.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(logs.filter((l) => l.includes('Bot identity')).length, 1);
  identity.stop();
});

test('refetch started after a hung startup: late startup success first, then refetch failure logs no error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const resolvers = [];
  const { identity, calls, changes, errors } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  const errorsBefore = errors.length;
  const second = groupMessage(identity);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  resolvers[0](FETCHED);
  await new Promise((resolve) => setImmediate(resolve));
  resolvers[1](FAILED);
  await second;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(identity.status().status, 'fetched');
  assert.equal(changes.length, 1);
  assert.deepEqual(errors.slice(errorsBefore), []);
  // No 10-minute "unknown" log after recovery.
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  assert.equal(errors.filter((e) => e.includes('unknown for')).length, 0);
  identity.stop();
});

test('refetch success first, then a late startup success changes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const resolvers = [];
  const { identity, calls, changes, persisted, logs } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  const second = groupMessage(identity);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  resolvers[1](FETCHED);
  await second;
  assert.equal(changes.length, 1);
  resolvers[0]({ success: true, open_id: 'ou_late', app_name: 'Late' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(identity.openId, 'ou_fetched');
  assert.equal(changes.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(logs.filter((l) => l.includes('Bot identity')).length, 1);
  identity.stop();
});

test('group mention check waits for the one-shot refetch so the triggering @mention counts', async () => {
  const { identity } = setup({ results: [FAILED, FETCHED] });
  await identity.fetchAtStartup();
  const mentions = [{ key: '@_user_1', id: { open_id: 'ou_fetched' } }];
  assert.equal(isBotMentioned(mentions, identity.openId), false);
  assert.equal(await groupMessage(identity, mentions), true);
  assert.equal(await groupMessage(identity, [{ key: '@_user_2', id: { open_id: 'ou_other' } }]), false);
});

test('startup failing within the wait: the same message refetches and waits at most one more window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const resolvers = [];
  const { identity, calls } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  identity.fetchAtStartup();
  let done = false;
  const message = groupMessage(identity).then(() => { done = true; });
  await Promise.resolve();
  t.mock.timers.tick(4_000);
  resolvers[0](FAILED); // startup fails inside the first window
  await new Promise((resolve) => setImmediate(resolve));
  // The same message issued the one-shot refetch and is waiting on it.
  assert.equal(calls.length, 2);
  assert.equal(identity.status().refetchUsed, true);
  assert.equal(done, false);
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await message;
  // Second window ended: total wait 4s + 5s, under two full windows.
  assert.equal(done, true);
  assert.equal(calls.length, 2);
  identity.stop();
});

test('mention matching: empty id never matches, @all always does', () => {
  const mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' } }];
  assert.equal(isBotMentioned(mentions, ''), false);
  assert.equal(isBotMentioned(mentions, 'ou_bot'), true);
  assert.equal(isBotMentioned([{ key: '@_all', id: {} }], ''), true);
  assert.equal(isBotMentioned(undefined, 'ou_bot'), false);
});

test('cachedBotOpenId accepts matching or missing app_id and rejects another app', () => {
  assert.equal(cachedBotOpenId({ open_id: 'ou_1', app_id: APP_ID }, APP_ID), 'ou_1');
  assert.equal(cachedBotOpenId({ open_id: 'ou_1' }, APP_ID), 'ou_1');
  assert.equal(cachedBotOpenId({ open_id: 'ou_1', app_id: 'cli_other' }, APP_ID), '');
  assert.equal(cachedBotOpenId({}, APP_ID), '');
  assert.equal(cachedBotOpenId(undefined, APP_ID), '');
});

test('config write-back sets open_id and app_id and is skipped when already current', () => {
  const base = { enabled: true, bot: { verification_token: 'vt' } };
  const next = botIdentityConfigUpdate(base, { openId: 'ou_1', appId: APP_ID });
  assert.deepEqual(next, { enabled: true, bot: { verification_token: 'vt', open_id: 'ou_1', app_id: APP_ID } });
  assert.equal(base.bot.open_id, undefined);
  assert.equal(botIdentityConfigUpdate(next, { openId: 'ou_1', appId: APP_ID }), null);
  // Old config with open_id but no app_id gets app_id added.
  assert.deepEqual(
    botIdentityConfigUpdate({ bot: { open_id: 'ou_1' } }, { openId: 'ou_1', appId: APP_ID }).bot,
    { open_id: 'ou_1', app_id: APP_ID },
  );
  assert.equal(botIdentityConfigUpdate(next, { openId: 'ou_2', appId: APP_ID }).bot.open_id, 'ou_2');
  assert.equal(botIdentityConfigUpdate(base, { openId: '' }), null);
});

test('message arriving while the startup fetch is in flight waits for it instead of a parallel request', async () => {
  let release;
  let count = 0;
  const { identity, calls } = setup({
    fetchImpl: async () => {
      count += 1;
      if (count === 1) {
        await new Promise((resolve) => { release = resolve; });
        return FETCHED;
      }
      return FETCHED;
    },
  });
  const startup = identity.fetchAtStartup();
  const message = groupMessage(identity);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([startup, message]);
  assert.equal(calls.length, 1);
  assert.equal(identity.status().status, 'fetched');
});

test('refetch wait is bounded by the timeout and still only one request is made', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release;
  let count = 0;
  const { identity, calls, errors } = setup({
    refetchTimeoutMs: 5_000,
    fetchImpl: async () => {
      count += 1;
      if (count === 1) return FAILED;
      await new Promise((resolve) => { release = resolve; });
      return FETCHED;
    },
  });
  await identity.fetchAtStartup();
  const first = groupMessage(identity);
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await first;
  assert.equal(identity.status().status, 'unknown');
  assert.ok(errors.some((e) => e.includes('still pending')));

  await groupMessage(identity);
  assert.equal(calls.length, 2);

  // A late success still applies the identity.
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(identity.status().status, 'fetched');
  assert.equal(calls.length, 2);
  identity.stop();
});

test('logs an error every 10 minutes while identity is unknown, without requests', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { identity, calls, errors } = setup({ results: [FAILED, FAILED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  const before = errors.filter((e) => e.includes('unknown for')).length;
  assert.equal(before, 0);

  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS);
  const periodic = errors.filter((e) => e.includes('unknown for'));
  assert.equal(periodic.length, 3);
  assert.match(periodic[2], /unknown for 30m/);
  assert.equal(calls.length, 2);
  identity.stop();
});

test('periodic unknown log stops once the identity is recovered', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { identity, errors } = setup({ results: [FAILED, FETCHED] });
  await identity.fetchAtStartup();
  await groupMessage(identity);
  t.mock.timers.tick(UNKNOWN_LOG_INTERVAL_MS * 3);
  assert.equal(errors.filter((e) => e.includes('unknown for')).length, 0);
});

test('status() exposes the health fields', async () => {
  const { identity } = setup({ results: [FAILED, FETCHED] });
  const initial = identity.status();
  assert.deepEqual(Object.keys(initial).sort(), ['attempts', 'refetchUsed', 'since', 'status']);
  assert.equal(initial.status, 'unknown');
  assert.equal(initial.attempts, 0);
  assert.equal(initial.refetchUsed, false);
  assert.ok(!Number.isNaN(Date.parse(initial.since)));

  await identity.fetchAtStartup();
  assert.equal(identity.status().attempts, 1);
  await groupMessage(identity);
  const recovered = identity.status();
  assert.equal(recovered.status, 'fetched');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.refetchUsed, true);
  assert.equal(JSON.stringify(recovered).includes('ou_fetched'), false);
});

test('explains the SDK token destructuring error once', () => {
  const raw = "Cannot destructure property 'tenant_access_token' of '(intermediate value)' as it is undefined.";
  const explained = explainBotInfoError(raw);
  assert.match(explained, /network unreachable or bad app credentials/);
  assert.equal(explainBotInfoError(explained), explained);
  assert.equal(explainBotInfoError('API error: forbidden'), 'API error: forbidden');
});
