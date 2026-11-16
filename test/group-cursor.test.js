// Group context cursor: moves only after Core confirms delivery
// (markCursorDelivered, ported from zylos-lark).
//
// The flow tests drive the real sendToC4 + createRejectReply against a fake
// c4-receive in a temp HOME / ZYLOS_DIR (the real Core and the running feishu
// service are never touched), with a small harness that mirrors the group
// branch of handleMessage in src/index.js: log -> context -> marker -> send.
// The source checks at the end pin that src/index.js really is wired that way.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRejectReply, MAYBE_LOST, sendToC4, TRY_LATER } from '../src/lib/c4.js';
import {
  createCursorMarker,
  isBehindCursor,
  selectContextWindow,
  sortContextChronologically,
  timestampMillis
} from '../src/lib/group-context.js';

const CHAT = 'oc_fedcba9876543210fedcba9876543210';
const EP = id => `${CHAT}|type:group|msg:${id}`;
const LIMIT = 5;

let root, prevEnv, responsesFile, callsFile;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-cursor-'));
  prevEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  process.env.HOME = path.join(root, 'home');
  process.env.ZYLOS_DIR = path.join(root, 'zylos');
  const scriptsDir = path.join(process.env.ZYLOS_DIR, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  responsesFile = path.join(root, 'responses.json');
  callsFile = path.join(root, 'calls.jsonl');
  // Responses are keyed by the msg id in --endpoint; `delayMs` lets a test
  // finish two calls out of order.
  fs.writeFileSync(path.join(scriptsDir, 'c4-receive.js'), `
const fs = require('fs');
const argv = process.argv.slice(2);
const endpoint = argv[argv.indexOf('--endpoint') + 1];
const content = argv[argv.indexOf('--content') + 1];
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ endpoint, content }) + '\\n');
const id = /msg:([^|]+)/.exec(endpoint)[1];
const r = JSON.parse(fs.readFileSync(${JSON.stringify(responsesFile)}, 'utf8'))[id] || { exit: 0 };
setTimeout(() => {
  if (r.stdout) process.stdout.write(r.stdout);
  process.exit(r.exit);
}, r.delayMs || 0);
`);
  fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(responsesFile, '{}');
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const respond = map => fs.writeFileSync(responsesFile, JSON.stringify(map));
const rejected = persisted => ({
  exit: 1,
  stdout: JSON.stringify({ ok: false, error: { code: 'X', message: 'core text', persisted } })
});
const sentContents = () => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : [];

/**
 * Mirrors the group branch of handleMessage: history + cursor file, context
 * after the cursor, markCursorDelivered as onSuccess and onStored.
 */
function makeChat() {
  let t = Date.parse('2026-11-16T00:00:00Z');
  const history = [];
  const cursors = {};
  const writes = [];
  const notices = [];

  const log = id => { history.push({ message_id: id, timestamp: String(t += 1000), user_name: 'u', text: id }); };
  const updateCursor = (chatId, id) => {
    if (isBehindCursor(history, cursors[chatId], id)) return;
    cursors[chatId] = id;
    writes.push(id);
  };

  /** Handle an @mention; `beforeSend` may throw (download, name lookup, ...). */
  function mention(id, { beforeSend } = {}) {
    log(id);
    const context = selectContextWindow(history, id, LIMIT, { afterMessageId: cursors[CHAT] || null });
    const markCursorDelivered = createCursorMarker(() => updateCursor(CHAT, id));
    const reply = createRejectReply({
      removeTyping: () => {},
      onStored: markCursorDelivered,
      deliver: text => notices.push([id, text])
    });
    return new Promise((resolve, reject) => {
      try {
        if (beforeSend) beforeSend();
        sendToC4('feishu', EP(id), `${id} ctx=${context.map(m => m.message_id).join(',')}`,
          reply, markCursorDelivered, { retryDelayMs: 10, onDone: outcome => resolve({ outcome, context }) });
      } catch (err) {
        reject(err);
      }
    });
  }

  return { log, mention, cursors, writes, notices, history };
}

const ids = list => list.map(m => m.message_id);

describe('cursor moves only after Core confirms delivery', () => {
  test('confirmed delivery (exit 0) advances the cursor to the message', async () => {
    const chat = makeChat();
    chat.log('m1');
    const { outcome, context } = await chat.mention('m2');
    assert.equal(outcome, 'sent');
    assert.deepEqual(ids(context), ['m1']);
    assert.equal(chat.cursors[CHAT], 'm2');
    assert.deepEqual(chat.writes, ['m2']);
  });

  test('stored then rejected (persisted non-empty) counts as delivered: cursor advances, no notice', async () => {
    const chat = makeChat();
    respond({ m1: rejected([1]) });
    const { outcome } = await chat.mention('m1');
    assert.equal(outcome, 'stored');
    assert.equal(chat.cursors[CHAT], 'm1');
    assert.deepEqual(chat.notices, []);
  });

  for (const [label, response, notice] of [
    ['TRY_LATER (not stored)', rejected([]), TRY_LATER],
    ['MAYBE_LOST (Core cannot tell)', rejected(null), MAYBE_LOST],
    ['MAYBE_LOST (crash / no structured result)', { exit: 3 }, MAYBE_LOST]
  ]) {
    test(`${label}: cursor unchanged, notice delivered`, async () => {
      const chat = makeChat();
      await chat.mention('m1');
      assert.equal(chat.cursors[CHAT], 'm1');
      respond({ m2: response });
      await chat.mention('m2');
      assert.equal(chat.cursors[CHAT], 'm1');
      assert.deepEqual(chat.writes, ['m1']);
      assert.deepEqual(chat.notices, [['m2', notice]]);
    });
  }

  test('throw before sending (e.g. media download): cursor unchanged, Core never called', async () => {
    const chat = makeChat();
    await chat.mention('m1');
    await assert.rejects(chat.mention('m2', { beforeSend: () => { throw new Error('download failed'); } }), /download failed/);
    assert.equal(chat.cursors[CHAT], 'm1');
    assert.equal(sentContents().length, 1);
  });

  test('c4-receive spawn throwing synchronously: cursor unchanged', async () => {
    const chat = makeChat();
    chat.log('m1');
    const markCursorDelivered = createCursorMarker(() => { chat.cursors[CHAT] = 'm1'; });
    assert.throws(() => sendToC4('feishu', EP('m1'), 'x', () => {}, markCursorDelivered,
      { execFileImpl: () => { throw new Error('EMFILE'); } }), /EMFILE/);
    assert.equal(chat.cursors[CHAT], undefined);
  });
});

describe('a message that did not get through stays in the next context', () => {
  for (const [label, response] of [
    ['TRY_LATER', rejected([])],
    ['MAYBE_LOST', rejected(null)],
    ['unknown outcome', { exit: 3 }]
  ]) {
    test(`after ${label}, the next @mention carries the failed message and what preceded it`, async () => {
      const chat = makeChat();
      await chat.mention('a1');           // delivered: cursor a1
      chat.log('p1');                      // plain message, logged only
      respond({ a2: response });
      await chat.mention('a2');           // fails: cursor stays a1
      chat.log('p2');
      respond({});
      const { context } = await chat.mention('a3');
      assert.deepEqual(ids(context), ['p1', 'a2', 'p2']);
      assert.equal(chat.cursors[CHAT], 'a3');
      assert.match(sentContents().at(-1).content, /^a3 ctx=p1,a2,p2$/);
    });
  }

  test('after a confirmed delivery the next context starts after it (no repeats)', async () => {
    const chat = makeChat();
    chat.log('p0');
    await chat.mention('a1');
    chat.log('p1');
    const { context } = await chat.mention('a2');
    assert.deepEqual(ids(context), ['p1']);
  });

  test('a crash between logging and delivery (cursor never written) keeps the message in context', async () => {
    const chat = makeChat();
    await chat.mention('a1');
    chat.log('a2');                        // handled, then the process died before Core answered
    const { context } = await chat.mention('a3');
    assert.deepEqual(ids(context), ['a2']);
  });
});

describe('ordering and concurrency per chat', () => {
  test('markCursorDelivered advances at most once per message', () => {
    let calls = 0;
    const mark = createCursorMarker(() => calls++);
    mark(); mark(); mark();
    assert.equal(calls, 1);
  });

  test('two concurrent @mentions confirmed out of order: the cursor ends on the newer one', async () => {
    const chat = makeChat();
    respond({ a1: { exit: 0, delayMs: 300 }, a2: { exit: 0 } });
    const first = chat.mention('a1');
    const second = chat.mention('a2');
    await Promise.all([first, second]);
    assert.deepEqual(chat.writes, ['a2']);       // a1 confirmed later, not moved back
    assert.equal(chat.cursors[CHAT], 'a2');
  });

  test('concurrent @mentions: newer one fails, older one delivered later: cursor on the older, newer kept for next context', async () => {
    const chat = makeChat();
    respond({ a1: { exit: 0, delayMs: 200 }, a2: rejected([]) });
    await Promise.all([chat.mention('a1'), chat.mention('a2')]);
    assert.equal(chat.cursors[CHAT], 'a1');
    respond({});
    const { context } = await chat.mention('a3');
    assert.deepEqual(ids(context), ['a2']);
  });

  test('cursors are per chat', () => {
    const history = [{ message_id: 'x1', timestamp: '1' }, { message_id: 'x2', timestamp: '2' }];
    assert.equal(isBehindCursor(history, 'x2', 'x1'), true);
    assert.equal(isBehindCursor(history, 'x1', 'x2'), false);
    assert.equal(isBehindCursor([], 'x2', 'x1'), false, 'other chat history: order unknown, may move');
    assert.equal(isBehindCursor(history, 'gone', 'x1'), false, 'cursor no longer in memory: may move');
    assert.equal(isBehindCursor(history, null, 'x1'), false);
  });
});

describe('context window helpers', () => {
  test('timestampMillis accepts Feishu epoch-ms strings and ISO strings', () => {
    assert.equal(timestampMillis('1763251200000'), 1763251200000);
    assert.equal(timestampMillis('2025-11-16T00:00:00.000Z'), 1763251200000);
    assert.equal(timestampMillis(undefined), 0);
    assert.equal(timestampMillis('nope'), 0);
  });

  test('sorts mixed timestamp formats chronologically, ties keep arrival order', () => {
    const sorted = sortContextChronologically([
      { message_id: 'c', timestamp: '2025-11-16T00:00:03.000Z' },
      { message_id: 'a', timestamp: '1763251201000' },
      { message_id: 'z', timestamp: '1763251202000' },
      { message_id: 'y', timestamp: '1763251202000' }
    ]);
    assert.deepEqual(ids(sorted), ['a', 'z', 'y', 'c']);
  });

  test('window excludes the current message, is capped at the limit, starts after the cursor', () => {
    const h = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'].map((id, i) => ({ message_id: id, timestamp: String(1000 + i) }));
    assert.deepEqual(ids(selectContextWindow(h, 'm7', 3)), ['m4', 'm5', 'm6']);
    assert.deepEqual(ids(selectContextWindow(h, 'm7', 5, { afterMessageId: 'm4' })), ['m5', 'm6']);
    assert.deepEqual(ids(selectContextWindow(h, 'm7', 2, { afterMessageId: 'm1' })), ['m5', 'm6']);
    assert.deepEqual(ids(selectContextWindow(h, 'm7', 3, { afterMessageId: 'unknown' })), ['m4', 'm5', 'm6']);
    assert.deepEqual(ids(selectContextWindow(h, 'm7', 3, { afterMessageId: 'm6' })), []);
    assert.deepEqual(selectContextWindow(undefined, 'm1', 3), []);
    assert.deepEqual(selectContextWindow(h, 'm7', 0), []);
  });

  test('cursor slicing happens after sorting (out-of-order lazy-load + live entries)', () => {
    const h = [
      { message_id: 'live2', timestamp: '3000' },
      { message_id: 'old1', timestamp: '1000' },
      { message_id: 'cur', timestamp: '2000' }
    ];
    assert.deepEqual(ids(selectContextWindow(h, 'now', 5, { afterMessageId: 'cur' })), ['live2']);
  });
});

describe('src/index.js wiring (source checks)', () => {
  const RAW = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
    .split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
  const groupBranch = SRC.slice(SRC.indexOf("\n  if (chatType === 'group') {"), SRC.indexOf('\nfunction startWebSocket'));

  test('updateCursor is only reached through markCursorDelivered', () => {
    const calls = SRC.match(/\bupdateCursor\(/g) || [];
    assert.equal(calls.length, 2, 'definition + the marker');
    assert.match(groupBranch,
      /^[ \t]*const markCursorDelivered = createCursorMarker\(\(\) => updateCursor\(chatId, messageId\)\);$/m);
    assert.ok(!/^[ \t]*updateCursor\(chatId, messageId\);/m.test(groupBranch), 'no cursor move before sending');
  });

  test('the marker is created after the context is read, and every group send confirms through it', () => {
    const ctx = groupBranch.indexOf('const contextMessages = await getGroupContext(chatId, messageId);');
    const marker = groupBranch.indexOf('const markCursorDelivered = createCursorMarker(');
    assert.ok(ctx >= 0 && marker > ctx);
    const sends = groupBranch.match(/sendToC4\([^\n]*\);/g);
    assert.equal(sends.length, 5);
    for (const s of sends) assert.equal(s, "sendToC4('feishu', endpoint, msg, groupRejectReply, markCursorDelivered);");
    assert.match(groupBranch, /onStored: markCursorDelivered,/);
  });

  test('group context is read after the cursor; updateCursor refuses to move it back', () => {
    assert.match(SRC, /afterMessageId: groupCursors\[chatId\] \|\| null/);
    const fn = SRC.slice(SRC.indexOf('function updateCursor(chatId, messageId) {'));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')), /isBehindCursor\(chatHistories\.get\(chatId\), groupCursors\[chatId\], messageId\)/);
  });

  test('DM sends never pass a cursor marker', () => {
    const dmBranch = SRC.slice(SRC.indexOf("\n  if (chatType === 'p2p') {"), SRC.indexOf("\n  if (chatType === 'group') {"));
    for (const s of dmBranch.match(/sendToC4\([^\n]*\);/g)) assert.equal(s, "sendToC4('feishu', endpoint, msg, rejectReply);");
  });
});
