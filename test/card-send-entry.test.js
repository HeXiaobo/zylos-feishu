import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Entry regression for [MEDIA:card]. The original bug lived in scripts/send.js,
// before sendCard(): the generic media regex needs a non-empty path and cannot
// match an embedded newline, so `[MEDIA:card]` (empty path) and a card path
// containing a newline fell through to sendText() and went out as literal text.
// The library tests could not catch that, so these run the real entry script as
// a child process with only src/lib/message.js replaced by a stub, and a local
// HTTP server standing in for the internal record-outgoing webhook. No Feishu
// credentials and no network access beyond 127.0.0.1.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SEND_JS = path.join(ROOT, 'scripts', 'send.js');
const LOADER = pathToFileURL(path.join(ROOT, 'test-fixtures', 'card-entry-loader.mjs')).href;

const CARD = {
  schema: '2.0',
  config: { summary: { content: 'entry summary' } },
  body: { elements: [{ tag: 'markdown', content: '**hi**' }] },
};

function callsFrom(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('ENTRY_CALL '))
    .map((line) => JSON.parse(line.slice('ENTRY_CALL '.length)));
}

test('scripts/send.js routes every [MEDIA:card] input through card validation', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-card-entry-'));
  const dataDir = path.join(home, 'zylos', 'components', 'feishu');
  const cardsDir = path.join(home, 'cards');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cardsDir, { recursive: true });

  const history = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      history.push(body ? JSON.parse(body) : null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ enabled: true, webhook_port: port, message: { useMarkdownCard: false } }),
  );

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runSend(message, msgId) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--experimental-loader', LOADER, SEND_JS, `oc_test_chat|type:p2p|msg:${msgId}`, message],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            HOME: home,
            FEISHU_APP_ID: '',
            FEISHU_APP_SECRET: '',
            FEISHU_INTERNAL_SECRET: 'test_entry_secret',
          },
          timeout: 10000,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  }

  function typingFile(msgId) {
    return path.join(dataDir, 'typing', `${msgId}.done`);
  }

  const cardPath = path.join(cardsDir, 'entry.card.json');
  fs.writeFileSync(cardPath, JSON.stringify(CARD));

  // POSIX allows a newline in a filename. The entry must read this path as-is
  // rather than treat the directive as text.
  const newlinePath = path.join(cardsDir, 'multi\nline.card.json');
  fs.writeFileSync(newlinePath, JSON.stringify(CARD));

  await t.test('a normal card sends one interactive message and records history', async () => {
    const result = await runSend(`[MEDIA:card]${cardPath}`, 'om_test_normal');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[feishu\] card sent message_id=om_test_entry via=send/);
    assert.match(result.stdout, /Message sent successfully/);

    const calls = callsFrom(result.stdout);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'sendMessage');
    assert.equal(calls[0].args[0], 'oc_test_chat');
    assert.deepEqual(calls[0].args.slice(2), ['chat_id', 'interactive']);
    assert.deepEqual(JSON.parse(calls[0].args[1]), CARD);

    assert.equal(history.length, 1);
    assert.equal(history[0].text, '[sent card] entry summary');
    assert.equal(history[0].chatId, 'oc_test_chat');
    assert.ok(fs.existsSync(typingFile('om_test_normal')), 'success must mark typing done');
  });

  await t.test('an empty [MEDIA:card] path fails with ERR_CARD_PATH and sends nothing', async () => {
    const historyBefore = history.length;
    const result = await runSend('[MEDIA:card]', 'om_test_empty');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Error: ERR_CARD_PATH:/);
    assert.equal(callsFrom(result.stdout).length, 0, 'no send/reply call may happen');
    assert.doesNotMatch(result.stdout, /Message sent successfully/);
    assert.equal(history.length, historyBefore, 'no outgoing history may be recorded');
    assert.equal(fs.existsSync(typingFile('om_test_empty')), false);
  });

  await t.test('a whitespace-only card path is treated the same way', async () => {
    const historyBefore = history.length;
    const result = await runSend('[MEDIA:card]   ', 'om_test_blank');

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Error: ERR_CARD_PATH:/);
    assert.equal(callsFrom(result.stdout).length, 0);
    assert.equal(history.length, historyBefore);
    assert.equal(fs.existsSync(typingFile('om_test_blank')), false);
  });

  await t.test('a card path containing a newline is sent as a card, never as text', async () => {
    const result = await runSend(`[MEDIA:card]${newlinePath}`, 'om_test_newline');

    assert.equal(result.code, 0, result.stderr);
    const calls = callsFrom(result.stdout);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'sendMessage');
    assert.deepEqual(calls[0].args.slice(2), ['chat_id', 'interactive']);
    assert.deepEqual(JSON.parse(calls[0].args[1]), CARD);
    assert.equal(history.at(-1).text, '[sent card] entry summary');
    assert.ok(fs.existsSync(typingFile('om_test_newline')));
  });
});
