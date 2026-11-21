import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// End-to-end regression for "ask inside a DM topic thread, reply lands in that
// thread". The routing decision is unit-tested in reply-target.test.js and
// reply-send.test.js; what those cannot show is that scripts/send.js — the path
// an agent actually uses to answer — passes `reply_in_thread: true` to the
// Feishu reply API for every outbound shape (plain text, markdown card, image,
// file). Before upstream PR #54 the entry derived no reply target for a p2p DM
// at all, so the answer went out as a base send and showed up in the main DM
// view, outside the thread the user was reading.
//
// These tests run the real entry script as a child process with only
// src/lib/message.js replaced by test-fixtures/card-entry-message-stub.mjs, and
// a local HTTP server standing in for the internal record-outgoing webhook. No
// Feishu credentials and no network access beyond 127.0.0.1.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SEND_JS = path.join(ROOT, 'scripts', 'send.js');
const LOADER = pathToFileURL(path.join(ROOT, 'test-fixtures', 'card-entry-loader.mjs')).href;

// A message sent from inside a DM topic thread: root + parent + msg + thread.
const THREAD_ENDPOINT = 'oc_dm_chat|type:p2p|root:om_root|parent:om_parent|msg:om_msg|thread:omt_topic1';

function callsFrom(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('ENTRY_CALL '))
    .map((line) => JSON.parse(line.slice('ENTRY_CALL '.length)));
}

function lastDataOption(call) {
  // replyToMessage(target, content, msgType, opts) / replyMarkdownCard(target, text, opts)
  return call.args[call.args.length - 1];
}

test('a DM topic question is answered inside the same topic thread', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-reply-thread-entry-'));
  const dataDir = path.join(home, 'zylos', 'components', 'feishu');
  fs.mkdirSync(dataDir, { recursive: true });

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // useMarkdownCard off for the text case, on for the card case below.
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ enabled: true, webhook_port: port, message: { useMarkdownCard: false } }),
  );

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runSend(endpoint, message, msgId) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--experimental-loader', LOADER, SEND_JS, endpoint, message],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            HOME: home,
            FEISHU_APP_ID: '',
            FEISHU_APP_SECRET: '',
            FEISHU_INTERNAL_SECRET: 'test_entry_secret',
          },
          timeout: 15000,
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

  await t.test('plain text replies to parent with replyInThread, no base send', async () => {
    const result = await runSend(THREAD_ENDPOINT, 'the answer', 'om_msg');
    assert.equal(result.code, 0, result.stderr);

    const calls = callsFrom(result.stdout);
    assert.equal(calls.length, 1, `exactly one Feishu call expected, got ${JSON.stringify(calls)}`);
    assert.equal(calls[0].name, 'replyToMessage');
    assert.equal(calls[0].args[0], 'om_parent', 'must reply to the thread parent, not the chat');
    assert.equal(calls[0].args[1], 'the answer');
    assert.equal(calls[0].args[2], 'text');
    assert.deepEqual(lastDataOption(calls[0]), { replyInThread: true });
    assert.equal(calls.some((call) => call.name === 'sendMessage'), false,
      'a base send would land in the main DM view, outside the thread');
  });

  await t.test('markdown card replies in the thread with replyInThread', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ enabled: true, webhook_port: port, message: { useMarkdownCard: true } }),
    );
    const result = await runSend(THREAD_ENDPOINT, '**the answer**', 'om_msg_card');
    assert.equal(result.code, 0, result.stderr);

    const calls = callsFrom(result.stdout);
    assert.equal(calls.length, 1, `exactly one Feishu call expected, got ${JSON.stringify(calls)}`);
    assert.equal(calls[0].name, 'replyMarkdownCard');
    assert.equal(calls[0].args[0], 'om_parent');
    assert.deepEqual(lastDataOption(calls[0]), { replyInThread: true });
    assert.equal(calls.some((call) => call.name === 'sendMarkdownCard'), false);
  });

  await t.test('image replies in the thread with replyInThread', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ enabled: true, webhook_port: port, message: { useMarkdownCard: false } }),
    );
    const imagePath = path.join(home, 'shot.png');
    fs.writeFileSync(imagePath, 'not-a-real-png');

    const result = await runSend(THREAD_ENDPOINT, `[MEDIA:image]${imagePath}`, 'om_msg_image');
    assert.equal(result.code, 0, result.stderr);

    const calls = callsFrom(result.stdout);
    const replies = calls.filter((call) => call.name === 'replyToMessage');
    assert.equal(replies.length, 1, `expected one reply, got ${JSON.stringify(calls)}`);
    assert.equal(replies[0].args[0], 'om_parent');
    assert.equal(replies[0].args[2], 'image');
    assert.deepEqual(lastDataOption(replies[0]), { replyInThread: true });
    assert.equal(calls.some((call) => call.name === 'sendImage'), false);
  });

  await t.test('a DM message without a thread still base-sends (unchanged behaviour)', async () => {
    const result = await runSend(
      'oc_dm_chat|type:p2p|root:om_root|parent:om_parent|msg:om_msg',
      'the answer',
      'om_msg_plain',
    );
    assert.equal(result.code, 0, result.stderr);

    const calls = callsFrom(result.stdout);
    assert.equal(calls.length, 1, `exactly one Feishu call expected, got ${JSON.stringify(calls)}`);
    assert.equal(calls[0].name, 'sendMessage',
      'p2p without a topic must keep the base send from #36');
    assert.equal(calls[0].args[0], 'oc_dm_chat');
  });
});
