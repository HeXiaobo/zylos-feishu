import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createReplyReceipts } from '../src/lib/reply-receipts.js';
import { installConsoleRedaction } from '../src/lib/redact.js';

const execute = promisify(execFile);
const token = 'test-receipt-correlation';

test('receipt opt-in requires a token and all native IDs; duplicate IDs emit once', () => {
  for (const config of [{}, { enabled: false, token }, { enabled: true }, { enabled: 'true', token }]) {
    const lines = [];
    const receipts = createReplyReceipts({ ...config, write: line => lines.push(line) });
    receipts.collect({ success: true, messageId: 'om_one' }); receipts.emit();
    assert.deepEqual(lines, []);
  }
  const lines = [];
  const receipts = createReplyReceipts({ enabled: true, token, write: line => lines.push(line) });
  receipts.collect({ success: true, messageId: 'om_one' });
  receipts.collect({ success: true, messageId: 'om_one' });
  receipts.collect({ success: true, messageId: 'om_two' }); receipts.emit();
  assert.deepEqual(lines.map(line => JSON.parse(line.slice('C4_RECEIPT '.length))),
    ['om_one', 'om_two'].map(platformMessageId => ({ platformMessageId, receiptToken: token })));
  for (const invalid of [{ success: false }, { success: true }, { success: true, messageId: '' }]) {
    const missing = createReplyReceipts({ enabled: true, token, write: () => assert.fail('incomplete evidence') });
    missing.collect({ success: true, messageId: 'om_one' }); missing.collect(invalid); missing.emit();
  }
});

test('real send entry emits complete receipts for card, text, fallbacks and media only after success', async context => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-receipt-entry-'));
  const dataDir = path.join(home, 'zylos/components/feishu');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  const cardPath = path.join(home, 'card.json');
  fs.writeFileSync(cardPath, JSON.stringify({ schema: '2.0', body: { elements: [] } }));
  const server = http.createServer((request, response) => { request.resume(); response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const loader = new URL('../test-fixtures/card-entry-loader.mjs', import.meta.url).href;
  const run = async (message, { enabled = true, markdown = false, endpoint = 'oc_test|type:p2p', env = {} } = {}) => {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: true, webhook_port: server.address().port,
      c4: { replyReceipts: enabled }, message: { useMarkdownCard: markdown } }));
    try {
      const result = await execute(process.execPath, ['--no-warnings', '--experimental-loader', loader,
        path.join(root, 'scripts/send.js'), endpoint, message],
      { env: { ...process.env, HOME: home, FEISHU_APP_ID: '', FEISHU_APP_SECRET: '',
        FEISHU_INTERNAL_SECRET: 'synthetic-entry-key', ZYLOS_REPLY_RECEIPT_TOKEN: token,
        CARD_ENTRY_UNIQUE_IDS: '1', ...env }, timeout: 15000 });
      return { ...result, code: 0 };
    } catch (error) { return error; }
  };
  const read = result => result.stdout.split('\n').filter(line => line.startsWith('C4_RECEIPT '))
    .map(line => JSON.parse(line.slice('C4_RECEIPT '.length)));
  const ids = result => read(result).map(receipt => receipt.platformMessageId);

  assert.deepEqual(ids(await run('hello', { enabled: false })), []);
  assert.deepEqual(ids(await run('hello', { env: { ZYLOS_REPLY_RECEIPT_TOKEN: '' } })), []);
  assert.deepEqual(ids(await run('[SKIP]')), []);
  const plain = await run('hello');
  assert.equal(plain.code, 0);
  assert.deepEqual(read(plain), [{ platformMessageId: 'om_entry_1', receiptToken: token }]);
  assert.deepEqual(ids(await run('x'.repeat(4500))), ['om_entry_1', 'om_entry_2', 'om_entry_3']);
  assert.deepEqual(ids(await run(`**${'x'.repeat(3000)}**`,
    { markdown: true, env: { CARD_ENTRY_CARD_FAIL: '1' } })), ['om_entry_2', 'om_entry_3']);
  const partial = await run('x'.repeat(3000), { env: { CARD_ENTRY_FAIL_AT: '2' } });
  assert.notEqual(partial.code, 0);
  assert.deepEqual(ids(partial), []);
  assert.deepEqual(ids(await run('x'.repeat(3000), { env: { CARD_ENTRY_MISSING_ID_AT: '2' } })), []);
  assert.deepEqual(ids(await run(`[MEDIA:card]${cardPath}`)), ['om_entry_1']);
  for (const type of ['image', 'file']) {
    assert.deepEqual(ids(await run(`[MEDIA:${type}]/synthetic`)), ['om_entry_1']);
    assert.deepEqual(ids(await run(`[MEDIA:${type}]/synthetic`,
      { endpoint: 'oc_test|type:group|root:om_root|parent:om_parent' })), ['om_entry_1']);
    assert.deepEqual(ids(await run(`[MEDIA:${type}]/synthetic`,
      { endpoint: 'oc_test|type:group|root:om_root|parent:om_parent',
        env: { CARD_ENTRY_REPLY_FAIL: '1' } })), ['om_entry_3']);
  }
});

test('correlation token remains valid JSON through the installed log redactor', () => {
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try {
    installConsoleRedaction();
    const receipts = createReplyReceipts({ enabled: true, token, write: console.log });
    receipts.collect({ success: true, messageId: 'om_one' }); receipts.emit();
    assert.equal(JSON.parse(lines[0].slice('C4_RECEIPT '.length)).receiptToken, token);
  } finally { console.log = original; }
});
