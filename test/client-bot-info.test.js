import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

// Isolate from the real ~/zylos config: config.js reads HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-client-test-'));
process.env.HOME = tmpHome;
test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));
process.env.FEISHU_APP_ID = 'cli_test';
process.env.FEISHU_APP_SECRET = 'secret_test';
const { getBotInfo, resetClient, BOT_INFO_TIMEOUT_MS } = await import('../src/lib/client.js');

function mockRequest(t, impl) {
  resetClient();
  const calls = [];
  t.mock.method(lark.Client.prototype, 'request', function (opts) {
    calls.push(opts);
    return impl(opts);
  });
  return calls;
}

test('getBotInfo passes the 10s timeout to the SDK request', async (t) => {
  const calls = mockRequest(t, async () => ({ code: 0, bot: { open_id: 'ou_x', app_name: 'X' } }));
  const res = await getBotInfo();
  assert.deepEqual(res, { success: true, open_id: 'ou_x', app_name: 'X' });
  assert.equal(BOT_INFO_TIMEOUT_MS, 10_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/open-apis/bot/v3/info');
  assert.equal(calls[0].timeout, 10_000);
});

test('a hung request resolves as timed out after 10s and clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  mockRequest(t, () => new Promise(() => {}));
  let result;
  const pending = getBotInfo().then((r) => { result = r; });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(BOT_INFO_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, undefined);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(result.success, false);
  assert.match(result.message, /timed out after 10000ms/);
});

test('a request that returns quickly leaves no timer pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  mockRequest(t, async () => ({ code: 0, bot: { open_id: 'ou_x' } }));
  const res = await getBotInfo();
  assert.equal(res.success, true);
  assert.equal(clear.mock.callCount(), 1);
  assert.notEqual(clear.mock.calls[0].arguments[0], undefined);
});

test('a request rejecting after the timeout causes no unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectLate;
  mockRequest(t, () => new Promise((_, reject) => { rejectLate = reject; }));
  const pending = getBotInfo();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(BOT_INFO_TIMEOUT_MS);
  const res = await pending;
  assert.match(res.message, /timed out/);
  rejectLate(new Error('late failure'));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});
