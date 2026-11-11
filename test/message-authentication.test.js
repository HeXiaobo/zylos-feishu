import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lark from '@larksuiteoapi/node-sdk';
import { resetClient } from '../src/lib/client.js';
import { sendMessage, sendMarkdownCard } from '../src/lib/message.js';

// Exercise the real SDK token manager and the component's send helpers. A
// rejected token request used to become an unrelated undefined-destructure
// error in SDK 1.58, hiding the reason an unhealthy notice could not be sent.
// Intercept Axios at its transport adapter: no Feishu request leaves this test.
let fixture = 0;

function transport(t, handler) {
  const adapter = lark.defaultHttpInstance.defaults.adapter;
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  process.env.FEISHU_APP_ID = `cli_auth_fixture_${++fixture}`;
  process.env.FEISHU_APP_SECRET = 'auth-fixture-only';
  resetClient();
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  lark.defaultHttpInstance.defaults.adapter = async config => ({
    data: await handler(config),
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  });
  t.after(() => {
    lark.defaultHttpInstance.defaults.adapter = adapter;
    resetClient();
    if (appId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = appId;
    if (appSecret === undefined) delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = appSecret;
  });
}

function isTokenRequest(config) {
  return config.url.endsWith('/auth/v3/tenant_access_token/internal');
}

test('both unhealthy-notice formats retain a token transport failure', async t => {
  let tokenRequests = 0;
  let messageRequests = 0;
  transport(t, config => {
    if (isTokenRequest(config)) {
      tokenRequests++;
      const failure = new Error('simulated token connection reset');
      failure.code = 'ECONNRESET';
      throw failure;
    }
    messageRequests++;
    throw new Error('must not send without a token');
  });

  for (const send of [sendMarkdownCard, sendMessage]) {
    const result = await send('oc_auth_fixture', 'temporarily unavailable');
    assert.equal(result.success, false);
    assert.equal(result.message, 'simulated token connection reset');
    assert.doesNotMatch(result.message, /undefined|destructure/);
  }
  assert.equal(tokenRequests, 2);
  assert.equal(messageRequests, 0);
});

test('a later bounded send attempt obtains a fresh token after transport recovery', async t => {
  let tokenRequests = 0;
  const messages = [];
  transport(t, config => {
    if (isTokenRequest(config)) {
      if (++tokenRequests === 1) throw new Error('simulated token timeout');
      return { code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7200 };
    }
    assert.match(config.url, /\/im\/v1\/messages$/);
    assert.equal(config.headers.Authorization, 'Bearer fixture-tenant-token');
    messages.push(JSON.parse(config.data));
    return { code: 0, data: { message_id: 'om_auth_fixture' } };
  });

  // The caller controls retries. Do not add an unbounded retry or replay a
  // message that might already have been sent. The failed auth attempt never
  // reaches the message endpoint.
  const first = await sendMessage('oc_auth_fixture', 'temporarily unavailable');
  assert.equal(first.success, false);
  assert.equal(messages.length, 0);
  const recovered = await sendMessage('oc_auth_fixture', 'temporarily unavailable');
  assert.equal(recovered.success, true);
  assert.equal(recovered.messageId, 'om_auth_fixture');
  assert.equal(tokenRequests, 2);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].receive_id, 'oc_auth_fixture');
});

test('a token business rejection keeps its API reason and never sends a message', async t => {
  let requests = 0;
  transport(t, config => {
    requests++;
    assert.ok(isTokenRequest(config));
    return { code: 10003, msg: 'simulated invalid app credentials' };
  });
  const result = await sendMessage('oc_auth_fixture', 'temporarily unavailable');
  assert.equal(result.success, false);
  assert.match(result.message, /10003/);
  assert.match(result.message, /simulated invalid app credentials/);
  assert.doesNotMatch(result.message, /auth-fixture-only|undefined|destructure/);
  assert.equal(requests, 1);
});

test('a success-shaped response without a token cannot send an unauthenticated message', async t => {
  let requests = 0;
  transport(t, config => {
    requests++;
    assert.ok(isTokenRequest(config));
    return { code: 0, msg: 'ok' };
  });
  const result = await sendMarkdownCard('oc_auth_fixture', 'temporarily unavailable');
  assert.equal(result.success, false);
  assert.match(result.message, /failed to get tenant_access_token/);
  assert.doesNotMatch(result.message, /undefined|destructure/);
  assert.equal(requests, 1);
});
