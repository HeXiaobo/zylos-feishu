import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createCardActionHandler } from '../src/lib/card-action.js';

const settings = {
  enabled: true,
  endpoint: 'http://127.0.0.1:3379/callback',
  bearer_key_file: '/private/receiver.key',
  message_ids: ['om_test'], chat_ids: ['oc_test'], operator_ids: ['ou_test']
};
const event = {
  app_id: 'cli_test', token: 'verification-secret',
  action: { value: { card_id: 'card_test', action: 'submit' },
    form_value: { test_value: 'synthetic-only' } },
  operator: { open_id: 'ou_test', user_id: 'unused' },
  context: { open_chat_id: 'oc_test', open_message_id: 'om_test' }
};
const success = { toast: { type: 'success', content: 'Received' } };

function fixture(overrides = {}) {
  const calls = [];
  const warnings = [];
  const handler = createCardActionHandler({
    appId: 'cli_test', getSettings: () => settings,
    readFileImpl: () => 'local-test-key\n',
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => success }; },
    logger: { warn: (...args) => warnings.push(args) },
    ...overrides
  });
  return { handler, calls, warnings };
}

test('disabled, absent and non-boolean switches do not read secrets or forward events', async () => {
  for (const current of [undefined, {}, { ...settings, enabled: false }, { ...settings, enabled: 'true' }]) {
    const { handler, calls } = fixture({ getSettings: () => current,
      readFileImpl: () => { assert.fail('must not read key'); } });
    assert.deepEqual(await handler(event), {});
    assert.equal(calls.length, 0);
  }
});

test('application, message, chat and operator must all match explicit lists', async () => {
  for (const changed of [
    { ...event, app_id: 'cli_other' },
    { ...event, context: { ...event.context, open_message_id: 'om_other' } },
    { ...event, context: { ...event.context, open_chat_id: 'oc_other' } },
    { ...event, operator: { open_id: 'ou_other' } }, {}, undefined
  ]) {
    const { handler, calls } = fixture();
    assert.deepEqual(await handler(changed), {});
    assert.equal(calls.length, 0);
  }
  for (const missing of ['message_ids', 'chat_ids', 'operator_ids']) {
    const { handler, calls } = fixture({ getSettings: () => ({ ...settings, [missing]: undefined }) });
    assert.deepEqual(await handler(event), {});
    assert.equal(calls.length, 0);
  }
});

test('SDK dispatcher flattens the envelope; handler forwards only matched business fields', async () => {
  const { handler, calls } = fixture();
  const dispatcher = new Lark.EventDispatcher({ logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } })
    .register({ 'card.action.trigger': handler });
  const result = await dispatcher.invoke({ schema: '2.0',
    header: { app_id: event.app_id, event_type: 'card.action.trigger', token: event.token },
    event: { action: event.action, operator: event.operator, context: event.context }
  }, { needCheck: false });
  assert.deepEqual(result, success);
  assert.equal(calls.length, 1);
  const [endpoint, request] = calls[0];
  assert.equal(endpoint.href, settings.endpoint);
  assert.equal(request.headers.Authorization, 'Bearer local-test-key');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), { schema: '2.0',
    header: { app_id: 'cli_test', event_type: 'card.action.trigger' },
    event: { action: event.action, operator: { open_id: 'ou_test' }, context: event.context }
  });
  assert.ok(!request.body.includes('verification-secret'));
  assert.ok(!request.body.includes('unused'));
});

test('receiver cannot inject card changes into the SDK response', async () => {
  const { handler } = fixture({ fetchImpl: async () => ({ ok: true,
    json: async () => ({ ...success, card: { type: 'raw', data: {} } }) }) });
  assert.deepEqual(await handler(event), success);
});

test('invalid destinations, keys and timeouts never make a request', async () => {
  for (const change of [
    { endpoint: 'https://example.com/callback' }, { endpoint: 'http://10.0.0.1/callback' },
    { endpoint: 'http://user:pass@127.0.0.1/callback' }, { endpoint: 'http://127.0.0.1/callback?key=x' },
    { bearer_key_file: 'relative.key' }, { timeout_ms: 3000 }, { timeout_ms: 0 }
  ]) {
    const { handler, calls, warnings } = fixture({ getSettings: () => ({ ...settings, ...change }) });
    assert.equal((await handler(event)).toast.type, 'error');
    assert.equal(calls.length, 0);
    assert.equal(warnings.length, 1);
  }
  for (const value of ['', 'key\nother']) {
    const { handler, calls } = fixture({ readFileImpl: () => value });
    assert.equal((await handler(event)).toast.type, 'error');
    assert.equal(calls.length, 0);
  }
});

test('receiver rejection, malformed JSON and timeout have no retry and no payload logs', async () => {
  for (const response of [
    async () => { throw new Error('private-payload'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('private-payload'); } }),
    async () => ({ ok: true, json: async () => ({}) })
  ]) {
    let requests = 0;
    const { handler, warnings } = fixture({ fetchImpl: async (...args) => { requests++; return response(...args); } });
    assert.equal((await handler(event)).toast.type, 'error');
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(warnings).includes('private-payload'));
  }
});

test('real loopback receiver gets authenticated values and redirects are not followed', async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ url: request.url, auth: request.headers.authorization,
      body: Buffer.concat(chunks).toString() });
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/target' }); response.end(); return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(success));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    let current = { ...settings, endpoint: `${base}/callback` };
    const { handler } = fixture({ getSettings: () => current, fetchImpl: globalThis.fetch });
    assert.deepEqual(await handler(event), success);
    assert.equal(received[0].auth, 'Bearer local-test-key');
    assert.deepEqual(JSON.parse(received[0].body).event.action, event.action);
    current = { ...current, endpoint: `${base}/redirect` };
    assert.equal((await handler(event)).toast.type, 'error');
    assert.deepEqual(received.map(item => item.url), ['/callback', '/redirect']);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('real receiver delay is bounded and the next action still works', async () => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    if (requests > 1) response.end(JSON.stringify(success));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    let current = { ...settings, endpoint: `http://127.0.0.1:${server.address().port}/callback`, timeout_ms: 100 };
    const { handler } = fixture({ getSettings: () => current, fetchImpl: globalThis.fetch });
    assert.equal((await handler(event)).toast.type, 'error');
    current = { ...current, timeout_ms: 2000 };
    assert.deepEqual(await handler(event), success);
    assert.equal(requests, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('WebSocket startup registers the handler with the current app and live settings', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /'card\.action\.trigger': createCardActionHandler\(\{\s*appId: creds\.app_id,\s*getSettings: \(\) => config\.card_actions,/);
});
