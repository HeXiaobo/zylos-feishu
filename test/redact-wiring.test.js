// Wiring guard for log redaction (src/lib/redact.js) in the feishu entry points.
//
// src/index.js starts the service on import, so these checks read its source
// (block and line comments blanked) instead of executing it. The behaviour of
// the redacting logger itself is covered in redact.test.js, including the SDK
// Client built by getClient().

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .split('\n').map((l) => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

const INDEX = read('../src/index.js');
const SEND = read('../scripts/send.js');

test('index.js wraps console and registers the app secret, internal secret, encrypt key and verification token', () => {
  assert.match(INDEX, /^installConsoleRedaction\(\);$/m);
  assert.match(INDEX,
    /^registerSecrets\(INTERNAL_SECRET, getCredentials\(\)\.app_secret, config\.bot\?\.encrypt_key, config\.bot\?\.verification_token\);$/m);
  assert.match(INDEX, /registerSecrets\(newConfig\.bot\?\.encrypt_key, newConfig\.bot\?\.verification_token\);/,
    're-registered on config hot-reload');
});

test('WebSocket mode: WSClient and EventDispatcher get the redacting SDK logger', () => {
  const ws = INDEX.slice(INDEX.indexOf('function startWebSocket(creds) {'), INDEX.indexOf('function startWebhook(creds) {'));
  assert.ok(ws.length > 0);
  const client = ws.slice(ws.indexOf('new Lark.WSClient({'), ws.indexOf('});', ws.indexOf('new Lark.WSClient({')));
  assert.match(client, /logger: createRedactingLogger\(\),/);
  assert.match(ws, /new Lark\.EventDispatcher\(\{ logger: createRedactingLogger\(\) \}\)/);
  assert.equal((INDEX.match(/new Lark\.(WSClient|EventDispatcher|Client)\(/g) || []).length, 2,
    'no other SDK client is built in index.js (lib/client.js builds the API Client)');
});

test('webhook mode never logs raw request bodies, headers, signatures or the event', () => {
  const start = INDEX.indexOf('function startWebhook(creds) {');
  const end = INDEX.indexOf('\n// Startup', start);
  const webhook = INDEX.slice(start, end > start ? end : undefined);
  const logCalls = webhook.match(/console\.(log|info|warn|error|debug)\([^\n]*/g) || [];
  assert.ok(logCalls.length > 0);
  for (const call of logCalls) {
    assert.ok(!/\breq\.(body|headers|rawBody|query)\b|\bevent\b[^.]|\bevent\)|signature|encrypt\b|challenge|verificationToken|eventToken|\btoken\b/i
      .test(call.replace(/'[^']*'|`[^`$]*`/g, '')), `webhook log line may print request data: ${call}`);
  }
});

test('scripts/send.js wraps console and registers the internal secret it sends', () => {
  assert.match(SEND, /^installConsoleRedaction\(\);$/m);
  assert.match(SEND, /registerSecrets\(internalSecret\);/);
});

test('lib/client.js builds the API Client with the redacting logger and registers the app secret', () => {
  const client = read('../src/lib/client.js');
  assert.match(client, /registerSecrets\(creds\.app_secret\);\n\s*clientInstance = new lark\.Client\(\{/);
  assert.match(client, /logger: createRedactingLogger\(\),/);
});
