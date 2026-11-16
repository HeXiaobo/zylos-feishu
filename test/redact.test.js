import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import * as lark from '@larksuiteoapi/node-sdk';
import { AxiosError, AxiosHeaders } from 'axios';

// Isolate from the real ~/zylos config: config.js reads HOME at import time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-redact-test-'));
process.env.HOME = tmpHome;
test.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

// Fake values only.
const FAKE_SECRET = 'fakeSecretValue0123456789ABCDEF';
const FAKE_TENANT_TOKEN = 't-fakeTenantToken0123456789abcdef';
const FAKE_USER_TOKEN = 'u-fakeUserToken0123456789abcdefgh';
const FAKE_ENCRYPT_KEY = 'fakeEncryptKey0123456789';
const FAKE_VERIFY_TOKEN = 'fakeVerifyToken0123456789';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

process.env.FEISHU_APP_ID = 'cli_fakeappid0001';
process.env.FEISHU_APP_SECRET = FAKE_SECRET;

const {
  redact, redactText, formatRedacted, isSensitiveKey, createRedactingLogger, installConsoleRedaction,
  registerSecrets, clearRegisteredSecrets, REDACTED,
} = await import('../src/lib/redact.js');
const { getClient, resetClient } = await import('../src/lib/client.js');

// Opaque fakes: not t-/u- shaped, so only the rule under test can mask them.
const OPAQUE = 'opaqueFakeValue9f8e7d6c5b4a';

const ALL_FAKES = [FAKE_SECRET, FAKE_TENANT_TOKEN, FAKE_USER_TOKEN, FAKE_ENCRYPT_KEY, FAKE_VERIFY_TOKEN];

function assertNoSecrets(text) {
  for (const s of ALL_FAKES) assert.ok(!text.includes(s), `leaked ${s.slice(0, 6)}... in:\n${text}`);
}

/** The shape observed in the live log: tenant-token POST failing with ECONNREFUSED. */
function makeTokenAxiosError({ response } = {}) {
  const config = {
    method: 'post',
    url: TOKEN_URL,
    headers: new AxiosHeaders({ 'Content-Type': 'application/json', Authorization: `Bearer ${FAKE_USER_TOKEN}` }),
    data: JSON.stringify({ app_id: 'cli_fakeappid0001', app_secret: FAKE_SECRET }),
    timeout: 0,
  };
  const request = {
    _currentUrl: TOKEN_URL,
    _requestBodyBuffers: [{ data: Buffer.from(config.data) }],
    _options: { headers: { authorization: `Bearer ${FAKE_TENANT_TOKEN}` } },
  };
  const err = new AxiosError('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED', config, request, response);
  const cause = new Error('connect ECONNREFUSED 127.0.0.1:443');
  Object.assign(cause, { errno: -111, code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 443 });
  err.cause = cause;
  return err;
}

test.beforeEach(() => {
  clearRegisteredSecrets();
});

test('isSensitiveKey matches secret/token/header keys in any casing', () => {
  for (const k of ['app_secret', 'appSecret', 'tenant_access_token', 'user_access_token', 'access_token',
    'refresh_token', 'Authorization', 'authorization', 'Proxy-Authorization', 'encrypt_key', 'encryptKey',
    'verification_token', 'verificationToken', 'token', 'Cookie', 'x-internal-token', 'client_secret',
    'secret_key', 'secretKey', 'api_key', 'apiKey', 'x-api-key', 'private_key', 'privateKey']) {
    assert.ok(isSensitiveKey(k), k);
  }
  for (const k of ['app_id', 'url', 'method', 'code', 'msg', 'message', 'status', 'chat_id', 'page_token_x',
    'file_token', 'page_token', 'keyboard']) {
    assert.ok(!isSensitiveKey(k), k);
  }
});

test('redactText masks JSON bodies, inspected objects, query strings and Bearer tokens', () => {
  const body = JSON.stringify({ app_id: 'cli_fakeappid0001', app_secret: FAKE_SECRET });
  assert.equal(redactText(body), `{"app_id":"cli_fakeappid0001","app_secret":"${REDACTED}"}`);

  // JSON embedded inside a JSON string (escaped quotes)
  const nested = JSON.stringify({ data: body });
  const out = redactText(nested);
  assertNoSecrets(out);
  assert.ok(out.includes('cli_fakeappid0001'));

  assert.equal(redactText(`{ tenant_access_token: '${FAKE_TENANT_TOKEN}', expire: 7200 }`),
    `{ tenant_access_token: '${REDACTED}', expire: 7200 }`);
  assert.equal(redactText(`wss://x.example/ws?device_id=1&access_key=abc123&ticket=tk-9`),
    `wss://x.example/ws?device_id=1&access_key=${REDACTED}&ticket=${REDACTED}`);
  assert.equal(redactText(`Authorization: Bearer ${FAKE_USER_TOKEN}`), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactText(`token is ${FAKE_TENANT_TOKEN} now`), `token is ${REDACTED} now`);
  assert.equal(redactText(`"encrypt_key": "${FAKE_ENCRYPT_KEY}", "verification_token":"${FAKE_VERIFY_TOKEN}"`),
    `"encrypt_key": "${REDACTED}", "verification_token":"${REDACTED}"`);
});

test('redactText is idempotent and leaves ordinary log lines untouched', () => {
  const once = redactText(`{"app_secret":"${FAKE_SECRET}"} token=${FAKE_TENANT_TOKEN} Bearer ${FAKE_USER_TOKEN}`);
  assert.equal(redactText(once), once);
  for (const line of [
    '[feishu] Bot @mentioned in group oc_abc123',
    '[feishu] WebSocket client started (pong timeout: 3 x ping interval)',
    'connect ECONNREFUSED 127.0.0.1:443',
    '[feishu] verification_token not configured — rejecting request.',
    `url: '${TOKEN_URL}'`,
  ]) {
    assert.equal(redactText(line), line);
  }
});

test('registered literal secrets are removed even without a recognisable key', () => {
  registerSecrets(FAKE_SECRET, 'short', '', undefined);
  assert.equal(redactText(`oops ${FAKE_SECRET} leaked`), `oops ${REDACTED} leaked`);
  assert.equal(redactText('a short word'), 'a short word', 'values under 8 chars are not registered');
});

test('redact() turns the tenant-token AxiosError into a useful, secret-free error', () => {
  const err = makeTokenAxiosError();
  const out = redact(err);
  assert.ok(out instanceof Error);
  assert.equal(out.name, 'AxiosError');
  assert.equal(out.message, 'connect ECONNREFUSED 127.0.0.1:443');
  assert.equal(out.code, 'ECONNREFUSED');
  assert.equal(out.method, 'POST');
  assert.equal(out.url, TOKEN_URL);
  assert.equal(out.cause.code, 'ECONNREFUSED');
  assert.equal(out.config, undefined, 'raw axios config is dropped');
  assert.equal(out.request, undefined, 'raw request is dropped');
  const printed = util.inspect(out, { depth: 10 });
  assertNoSecrets(printed);
  assert.ok(printed.includes(TOKEN_URL));
  // input not mutated
  assert.ok(err.config.data.includes(FAKE_SECRET));
});

test('redact() keeps status and redacted response data of an HTTP error', () => {
  const err = makeTokenAxiosError({
    response: { status: 400, data: { code: 99991663, msg: 'invalid', tenant_access_token: FAKE_TENANT_TOKEN } },
  });
  const out = redact(err);
  assert.equal(out.status, 400);
  assert.equal(out.responseData.code, 99991663);
  assert.equal(out.responseData.tenant_access_token, REDACTED);
});

test('redact() masks nested keys, header objects, arrays, buffers and handles cycles', () => {
  const obj = {
    config: {
      url: TOKEN_URL,
      headers: new AxiosHeaders({ Authorization: `Bearer ${FAKE_TENANT_TOKEN}` }),
      data: JSON.stringify({ app_secret: FAKE_SECRET }),
    },
    list: [{ user_access_token: FAKE_USER_TOKEN }, `Bearer ${FAKE_USER_TOKEN}`],
    bot: { encrypt_key: FAKE_ENCRYPT_KEY, verification_token: FAKE_VERIFY_TOKEN, app_id: 'cli_x' },
    body: Buffer.from(JSON.stringify({ app_secret: FAKE_SECRET })),
    nested: new Map([['appSecret', FAKE_SECRET]]),
  };
  obj.self = obj;
  const out = redact(obj);
  assert.equal(out.self, '[Circular]');
  assert.equal(out.config.url, TOKEN_URL);
  assert.equal(out.bot.app_id, 'cli_x');
  assert.equal(out.bot.encrypt_key, REDACTED);
  assert.equal(out.list[0].user_access_token, REDACTED);
  assertNoSecrets(util.inspect(out, { depth: 10 }));
});

test('redact() keeps SDK-style error arrays readable', () => {
  const out = redact([[{ message: 'Request failed with status code 400' }, { code: 41050, msg: 'no user authority error' }]]);
  assert.deepEqual(out, [[{ message: 'Request failed with status code 400' }, { code: 41050, msg: 'no user authority error' }]]);
});

function captureOut() {
  const lines = [];
  const rec = (stream) => (...args) => lines.push({ stream, text: util.format(...args) });
  return { lines, out: { log: rec('log'), warn: rec('warn'), info: rec('info'), debug: rec('debug'), trace: rec('trace') } };
}

test('createRedactingLogger keeps the SDK default format/streams and redacts arguments', () => {
  const { lines, out } = captureOut();
  const logger = createRedactingLogger(out);
  logger.error([makeTokenAxiosError()]);
  logger.info(['[ws]', `ws url: wss://x.example/ws?access_key=abc123&ticket=${FAKE_TENANT_TOKEN}`]);
  logger.warn('plain');
  assert.equal(lines[0].stream, 'log');
  assert.ok(lines[0].text.startsWith('[error]: '));
  assert.ok(lines[0].text.includes('ECONNREFUSED'));
  assert.ok(lines[0].text.includes(TOKEN_URL));
  assert.equal(lines[1].stream, 'info');
  assert.equal(lines[2].text, '[warn]: plain');
  for (const l of lines) assertNoSecrets(l.text);
});

test('the SDK Client uses the redacting logger: a failed tenant-token fetch logs no secret', async (t) => {
  const { lines, out } = captureOut();
  // Route the redacting logger created inside getClient() to our capture.
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug, trace: console.trace };
  Object.assign(console, out);
  try {
    resetClient();
    const client = getClient();
    // Fail the token request the way a network error does.
    t.mock.method(client.tokenManager.httpInstance, 'post', async () => { throw makeTokenAxiosError(); });
    t.mock.method(client.httpInstance, 'request', async () => ({ code: 0 }));
    await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }).catch(() => {});
  } finally {
    Object.assign(console, saved);
    resetClient();
  }
  const text = lines.map(l => l.text).join('\n');
  assert.ok(text.includes('[error]:'), `SDK logged nothing:\n${text}`);
  assert.ok(text.includes('ECONNREFUSED'));
  assertNoSecrets(text);
});

test('the SDK default logger would have leaked (guards the test above)', () => {
  const printed = util.inspect([makeTokenAxiosError()], { depth: 4 });
  assert.ok(printed.includes(FAKE_SECRET));
  assert.ok(lark.Client, 'SDK loaded');
});

test('installConsoleRedaction wraps console methods, is idempotent and restorable', () => {
  const { lines, out } = captureOut();
  const target = { ...out, error: (...a) => lines.push({ stream: 'error', text: util.format(...a) }) };
  const restore = installConsoleRedaction(target);
  assert.equal(installConsoleRedaction(target), restore, 'second install is a no-op');
  target.error('[feishu] failed:', makeTokenAxiosError());
  target.log(`[feishu] body {"app_secret":"${FAKE_SECRET}"}`);
  target.warn({ headers: { Authorization: `Bearer ${FAKE_USER_TOKEN}` } });
  assert.equal(lines.length, 3);
  for (const l of lines) assertNoSecrets(l.text);
  assert.ok(lines[0].text.includes('ECONNREFUSED'));
  restore();
  target.log(`raw ${FAKE_SECRET}`);
  assert.ok(lines[3].text.includes(FAKE_SECRET), 'restored to original');
});

// ---- Rules checked with opaque values (not token-shaped) ----

test('Bearer / Basic values are masked even when opaque and without a header key', () => {
  assert.equal(redactText(`sent Bearer ${OPAQUE} upstream`), `sent Bearer ${REDACTED} upstream`);
  assert.equal(redactText(`basic ${OPAQUE}`), `basic ${REDACTED}`);
});

test('tenant/user/app access_token text keys mask opaque values', () => {
  for (const key of ['tenant_access_token', 'user_access_token', 'app_access_token', 'tenantAccessToken']) {
    assert.equal(redactText(`{"${key}":"${OPAQUE}"}`), `{"${key}":"${REDACTED}"}`, key);
    assert.equal(redactText(`${key}=${OPAQUE}&x=1`), `${key}=${REDACTED}&x=1`, key);
    assert.equal(redactText(`{ ${key}: '${OPAQUE}' }`), `{ ${key}: '${REDACTED}' }`, key);
  }
});

test('secret_key, api_key, private_key and percent-encoded keys are masked', () => {
  assert.equal(redactText(`secret_key=${OPAQUE} api_key: "${OPAQUE}" private_key='${OPAQUE}'`),
    `secret_key=${REDACTED} api_key: "${REDACTED}" private_key='${REDACTED}'`);
  assert.equal(redactText(`a=1&app%5Fsecret=${OPAQUE}&b=2`), `a=1&app%5Fsecret=${REDACTED}&b=2`);
  assert.equal(redactText(`q=app%5fsecret%3D${OPAQUE}`), `q=app%5fsecret%3D${REDACTED}`);
  const out = redact({ secret_key: OPAQUE, apiKey: OPAQUE, private_key: OPAQUE, keep: 'k' });
  assert.deepEqual(out, { secret_key: REDACTED, apiKey: REDACTED, private_key: REDACTED, keep: 'k' });
});

test('authorization with any scheme (or none) is masked, scheme kept, idempotent', () => {
  const cases = [
    [`authorization=Token ${OPAQUE}`, `authorization=Token ${REDACTED}`],
    [`Authorization: Digest ${OPAQUE}`, `Authorization: Digest ${REDACTED}`],
    [`"Authorization":"Token ${OPAQUE}"`, `"Authorization":"Token ${REDACTED}"`],
    [`{ authorization: '${OPAQUE}' }`, `{ authorization: '${REDACTED}' }`],
    [`Proxy-Authorization: Basic ${OPAQUE}`, `Proxy-Authorization: Basic ${REDACTED}`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactText(input), expected, input);
    assert.equal(redactText(expected), expected, `idempotent: ${expected}`);
  }
});

test('a secret inside an error cause chain is redacted', () => {
  const inner = new Error(`token refresh failed: app_secret=${OPAQUE}`);
  inner.tenant_access_token = OPAQUE;
  const err = new Error('outer', { cause: new Error('middle', { cause: inner }) });
  const out = redact(err);
  assert.equal(out.cause.message, 'middle');
  assert.equal(out.cause.cause.message, `token refresh failed: app_secret=${REDACTED}`);
  assert.equal(out.cause.cause.tenant_access_token, REDACTED);
  assert.ok(!util.inspect(out, { depth: 10 }).includes(OPAQUE));
  assert.ok(err.cause.cause.message.includes(OPAQUE), 'input not mutated');
});

test('AggregateError keeps its errors, redacted', () => {
  const err = new AggregateError([new Error(`app_secret=${OPAQUE}`), new Error('connect ETIMEDOUT')], 'all failed');
  const out = redact(err);
  assert.equal(out.message, 'all failed');
  assert.deepEqual(out.errors.map(e => e.message), [`app_secret=${REDACTED}`, 'connect ETIMEDOUT']);
});

test('URL objects are printed as redacted strings, not {}', () => {
  const out = redact({ url: new URL(`https://x.example/ws?device_id=1&access_key=${OPAQUE}`) });
  assert.equal(out.url, `https://x.example/ws?device_id=1&access_key=${REDACTED}`);
});

test('redact() never throws, even for inputs that throw while walked', () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
  assert.equal(redact(hostile), '[unloggable value]');
  assert.equal(redact({ nested: hostile }), '[unloggable value]');
  const getter = { ok: 1, get bad() { throw new Error('boom'); } };
  assert.deepEqual(redact(getter), { ok: 1, bad: '[unreadable]' });
  assert.equal(formatRedacted(['x', hostile]), 'x [unloggable value]');
});

test('getClient() registers the configured app secret', () => {
  const opaqueSecret = 'opaqueAppSecret7c6b5a4d3e2f';
  const saved = process.env.FEISHU_APP_SECRET;
  process.env.FEISHU_APP_SECRET = opaqueSecret;
  try {
    resetClient();
    assert.equal(redactText(`x ${opaqueSecret} y`), `x ${opaqueSecret} y`, 'not registered yet');
    getClient();
    assert.equal(redactText(`x ${opaqueSecret} y`), `x ${REDACTED} y`);
  } finally {
    process.env.FEISHU_APP_SECRET = saved;
    resetClient();
  }
});

// ---- Console formatting keeps format strings and arguments together ----

test('console arguments are formatted first, so key and value in different arguments are masked', () => {
  const { lines, out } = captureOut();
  const restore = installConsoleRedaction(out);
  try {
    out.log('token=%s', OPAQUE);
    out.log('[x] token:', OPAQUE);
    out.log('[x] app_secret: %s, encrypt_key: %s', OPAQUE, OPAQUE);
    out.info('[feishu] sent %d messages to %s', 3, 'oc_abc123', { chat: 'oc_abc123', n: [1, 2] });
  } finally {
    restore();
  }
  assert.equal(lines[0].text, `token=${REDACTED}`);
  assert.equal(lines[1].text, `[x] token: ${REDACTED}`);
  assert.equal(lines[2].text, `[x] app_secret: ${REDACTED}, encrypt_key: ${REDACTED}`);
  assert.equal(lines[3].text, util.format('[feishu] sent %d messages to %s', 3, 'oc_abc123', { chat: 'oc_abc123', n: [1, 2] }),
    'non-secret output is identical to console');
});

test('the SDK logger also masks a value logged as the argument after its key', () => {
  const { lines, out } = captureOut();
  const logger = createRedactingLogger(out);
  // LoggerProxy passes the SDK's arguments as one array.
  logger.info(['[ws]', 'ticket:', OPAQUE, 'done']);
  logger.warn(['[ws] access_key=', OPAQUE]);
  logger.info(['[ws]', 'ws client ready']);
  assert.equal(lines[0].text, `[info]: [ '[ws]', 'ticket:', '${REDACTED}', 'done' ]`);
  assert.equal(lines[1].text, `[warn]: [ '[ws] access_key=', '${REDACTED}' ]`);
  assert.equal(lines[2].text, `[info]: [ '[ws]', 'ws client ready' ]`, 'same text as the SDK default logger');
  for (const l of lines) assert.equal(redactText(l.text), l.text, 'idempotent');
});

// ---- Narrower token shape ----

test('the Lark token shape does not match inside paths or words', () => {
  for (const s of [
    '/tmp/u-ploads_0123456789abcdefghijklmnopqrstuvwxyz/file.png',
    'C:\\tmp\\t-0123456789abcdefghijklmnopqrstuvwxyz.log',
    'menu-0123456789abcdefghijklmnopqrstuvwxyz',
    'a-very-long-hyphenated-identifier-name-without-digits',
    'u-short0123456789',
  ]) {
    assert.equal(redactText(s), s, s);
  }
  // Real-shaped tokens (fake values) standing alone are still masked.
  assert.equal(redactText('got t-g1044fakeTenantTokenABCDEFGHIJKLMNOPQRS ok'), `got ${REDACTED} ok`);
  assert.equal(redactText('(u-fakeUserToken0123456789abcdefghijklmn)'), `(${REDACTED})`);
  assert.equal(redactText('ur-fakeRefreshToken0123456789abcdefghij.'), `${REDACTED}`);
});

// ---- Bounded traversal ----

test('large arrays are truncated with a marker and redact fast', () => {
  const big = Array.from({ length: 200000 }, (_, i) => ({ id: i, secret: OPAQUE }));
  const start = performance.now();
  const out = redact(big);
  const ms = performance.now() - start;
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
  assert.equal(out.length, 101);
  assert.deepEqual(out[0], { id: 0, secret: REDACTED });
  assert.equal(out[100], '… 199900 more items');
});

test('wide graphs are bounded and shared references are walked once', () => {
  const shared = (d) => (d === 0 ? { leaf: 'x', token: OPAQUE } : Array(8).fill(shared(d - 1)));
  const distinct = (d) => (d === 0 ? { leaf: 'x', token: OPAQUE } : Array.from({ length: 8 }, () => distinct(d - 1)));
  const results = {};
  for (const [name, graph] of [['shared', shared(6)], ['distinct', distinct(6)]]) {
    const start = performance.now();
    results[name] = redact(graph);
    const ms = performance.now() - start;
    assert.ok(ms < 500, `${name} took ${ms.toFixed(0)}ms`);
    const printed = util.inspect(results[name], { depth: Infinity, maxArrayLength: Infinity });
    assert.ok(!printed.includes(OPAQUE), name);
  }
  assert.equal(results.shared[0], results.shared[1], 'shared reference copied once');
  assert.match(util.inspect(results.distinct, { depth: Infinity, maxArrayLength: Infinity }), /… \d+ more items/,
    'node budget cuts the distinct tree');
});

test('cycles still print as [Circular] with memoization; shared non-cyclic refs do not', () => {
  const a = { name: 'a' };
  const b = { name: 'b', a };
  a.b = b;
  const out = redact({ first: a, second: a, b });
  assert.equal(out.first.b.a, '[Circular]');
  assert.equal(out.second, out.first);
  assert.notEqual(out.b, '[Circular]');
});

test('redact() limits can be lifted (used by admin show)', () => {
  const list = Array.from({ length: 300 }, (_, i) => `ou_${i}`);
  assert.equal(redact(list).length, 101);
  assert.deepEqual(redact(list, { maxItems: Infinity, maxNodes: Infinity }), list);
});

test('admin show masks secret config fields and keeps the rest', async () => {
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-admin-show-'));
  try {
    const dir = path.join(home, 'zylos/components/feishu');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      enabled: true,
      bot: { encrypt_key: FAKE_ENCRYPT_KEY, verification_token: FAKE_VERIFY_TOKEN, app_id: 'cli_fakeappid0001' },
      dmAllowFrom: Array.from({ length: 150 }, (_, i) => `ou_${i}`),
    }));
    const admin = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/admin.js');
    const text = execFileSync(process.execPath, [admin, 'show'], {
      env: { ...process.env, HOME: home, ZYLOS_DIR: path.join(home, 'zylos') }, encoding: 'utf8',
    });
    const shown = JSON.parse(text);
    assert.equal(shown.bot.encrypt_key, REDACTED);
    assert.equal(shown.bot.verification_token, REDACTED);
    assert.equal(shown.bot.app_id, 'cli_fakeappid0001');
    assert.equal(shown.dmAllowFrom.length, 150, 'config dump is not truncated');
    assertNoSecrets(text);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- JWS-shaped tokens (OAuth v2 user_access_token / refresh_token) ----

// Fake JWS built from fake base64url segments: `eyJ...`, no t-/u- prefix.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_JWS = [
  b64url({ alg: 'ES256', kid: 'fake-kid-0000', typ: 'JWT' }),
  b64url({ sub: 'ou_fakeuser0000', scope: 'fake '.repeat(150), exp: 1 }),
  Buffer.from('fake-signature-'.repeat(6)).toString('base64url'),
].join('.');
const FAKE_UNSIGNED_JWS = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'fake-subject' })}.`;

test('bare JWS-shaped tokens are masked: bare, after Bearer, inside JSON, unsigned', () => {
  assert.ok(FAKE_JWS.startsWith('eyJ') && FAKE_JWS.length > 1000, 'realistic shape and length');
  const cases = [
    [`token refreshed: ${FAKE_JWS} ok`, `token refreshed: ${REDACTED} ok`],
    [`got ${FAKE_JWS}`, `got ${REDACTED}`],
    [`Authorization header was Bearer ${FAKE_JWS}`, `Authorization header was Bearer ${REDACTED}`],
    [`sent Bearer ${FAKE_JWS}, done`, `sent Bearer ${REDACTED}, done`],
    [JSON.stringify({ value: FAKE_JWS, n: 1 }), `{"value":"${REDACTED}","n":1}`],
    [util.inspect({ value: FAKE_JWS }, { breakLength: Infinity }), `{ value: '${REDACTED}' }`],
    [`unsigned ${FAKE_UNSIGNED_JWS} end`, `unsigned ${REDACTED} end`],
  ];
  for (const [input, expected] of cases) {
    const once = redactText(input);
    assert.equal(once, expected, input.slice(0, 40));
    assert.equal(redactText(once), once, 'idempotent');
    assert.ok(!once.includes(FAKE_JWS.slice(0, 40)));
  }
  assert.equal(formatRedacted(['[feishu] user token', FAKE_JWS]), `[feishu] user token ${REDACTED}`);
  assert.deepEqual(redact({ data: [FAKE_JWS] }), { data: [REDACTED] });
});

test('dotted identifiers starting with eyJ are kept', () => {
  for (const s of [
    'eyJsonParser.load.parse',
    'eyJsonParserFactory.load.parse',
    'eyJsonParserFactory.loader.x',
    'call eyJsonParser.load.parse() failed',
    'xeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    'eyJhbGciOiJIUzI1NiJ9',
  ]) {
    assert.equal(redactText(s), s, s);
  }
});

test('legacy u-/ur- token minimum length: 29-char body kept, 30-char body masked', () => {
  const body29 = 'fakeUserToken0123456789abcdef';
  const body30 = `${body29}g`;
  assert.equal(body29.length, 29);
  assert.equal(body30.length, 30);
  for (const prefix of ['u-', 'ur-', 't-']) {
    assert.equal(redactText(`x ${prefix}${body29} y`), `x ${prefix}${body29} y`, `${prefix} 29 kept`);
    assert.equal(redactText(`x ${prefix}${body30} y`), `x ${REDACTED} y`, `${prefix} 30 masked`);
  }
});

// ---- Memo vs depth limit ----

test('a shared object first met at the depth limit is copied in full when met shallower', () => {
  const shared = { inner: { leaf: 'x', token: OPAQUE } };
  const input = { deep: { a: { b: { c: { d: { e: shared } } } } }, shallow: shared };
  const out = redact(input);
  // Met at depth 6 first: its children are cut off there.
  assert.equal(out.deep.a.b.c.d.e.inner, '[Object]');
  // Met at depth 1 next: not the truncated copy.
  assert.deepEqual(out.shallow, { inner: { leaf: 'x', token: REDACTED } });
  // Met deeper again after that: reuses a copy (no extra walk), still safe.
  const again = redact({ shallow: shared, deep: { a: { b: shared } } });
  assert.equal(again.deep.a.b, again.shallow, 'deeper meeting reuses the memoized copy');
  assert.ok(!util.inspect(out, { depth: Infinity }).includes(OPAQUE));
});

// ---- util.format parity for non-secret values ----

test('non-secret values format exactly like util.format (class names, symbols, cause, errors)', () => {
  class Foo { constructor() { this.a = 1; this.nested = { b: [1, 2] }; } }
  class LarkError extends Error { constructor(m) { super(m); this.name = 'LarkError'; this.code = 42; } }
  class PlainSub extends Error {}
  const sym = Symbol('meta');
  const nullProto = Object.assign(Object.create(null), { a: 1 });
  const values = [
    { a: 1, b: 'two', c: [1, 2, 3], d: { e: null, f: undefined } },
    new Foo(),
    [new Foo(), { x: new Foo() }],
    { [sym]: 'v', plain: 1 },
    nullProto,
    new Map([['k', { v: 1 }]]),
    new Set([1, 'a']),
    new Error('outer', { cause: new Error('inner', { cause: new TypeError('root') }) }),
    new AggregateError([new Error('first'), new RangeError('second')], 'all failed'),
    new TypeError('bad type'),
    new LarkError('lark failed'),
    new PlainSub('sub failed'),
    Object.assign(new Error('with props'), { code: 'E_FAKE', status: 500 }),
    Array.from({ length: 100 }, (_, i) => i),
  ];
  for (const v of values) {
    assert.equal(formatRedacted([v]), util.format(v));
    assert.equal(formatRedacted(['%s: %o', 'label', v]), util.format('%s: %o', 'label', v));
  }
});

test('symbol keys and class instances are still redacted', () => {
  class Creds { constructor() { this.app_secret = OPAQUE; this.id = 'cli_x'; } }
  const out = redact({ [Symbol('app_secret')]: OPAQUE, [Symbol('note')]: `secret=${OPAQUE}`, creds: new Creds() });
  const printed = util.inspect(out);
  assert.ok(!printed.includes(OPAQUE), printed);
  // util.inspect writes symbol keys as `[Symbol(x)]` on Node 22 and `Symbol(x)` on Node 24.
  const expectedSym = util.inspect({ [Symbol('app_secret')]: '[REDACTED]' }).slice(2, -2);
  assert.ok(printed.includes(expectedSym), printed);
  assert.match(printed, /creds: Creds \{ app_secret: '\[REDACTED\]', id: 'cli_x' \}/);
});

test('a throwing static name getter only drops the class name', () => {
  class Hostile { constructor() { this.app_secret = OPAQUE; } }
  Object.defineProperty(Hostile, 'name', { get() { throw new Error('boom'); } });
  const printed = formatRedacted([new Hostile()]);
  assert.ok(!printed.includes(OPAQUE), printed);
  assert.notEqual(printed, '[unloggable value]');
  assert.match(printed, /app_secret: '\[REDACTED\]'/);
});

test('short dotted eyJ identifiers are not masked as JWS', () => {
  for (const id of ['eyJab.cdefghijklmn.op', 'eyJabcd.cdefghijklmn.op', 'eyJabcdefgh.x.y']) {
    assert.equal(redactText(`id=${id}`), `id=${id}`);
  }
});

test('the copy never calls the original constructor or custom inspect', () => {
  let ran = 0;
  class Sneaky {
    constructor() { this.a = 1; }
    [util.inspect.custom]() { ran++; return 'custom'; }
  }
  const out = redact(new Sneaky());
  assert.equal(util.inspect(out), 'Sneaky { a: 1 }');
  assert.equal(ran, 0);
});
