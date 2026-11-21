import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as realExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildC4ReceiveArgs,
  C4_RECEIVE_TIMEOUT_MS,
  c4ReceiveSupportsOption,
  classifyC4Rejection,
  createRejectReply,
  getC4ReceivePath,
  MAYBE_LOST,
  sendToC4,
  TRY_LATER
} from '../src/lib/c4.js';

// Isolated deployment: temp HOME and ZYLOS_DIR with a fake c4-receive.js that
// records its argv and replays scripted responses. The real Core and the
// running feishu service are never touched.
let root, prevEnv, scriptsDir, callsFile, responsesFile, envFile;
const SG = { '--session-group': { takesValue: true } };
const CORE_TEXT = 'Core text meant for the agent';
const CHAT = 'oc_fedcba9876543210fedcba9876543210';
const TOPIC_EP = `${CHAT}|type:group|root:om_r|msg:om_m|thread:omt_0a1b2c3d4e5f6a7b`;
const TOPIC_GROUP = `group-${CHAT}:topic-omt_0a1b2c3d4e5f6a7b`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-c4-'));
  prevEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  process.env.HOME = path.join(root, 'home');
  process.env.ZYLOS_DIR = path.join(root, 'zylos');
  scriptsDir = path.join(process.env.ZYLOS_DIR, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  callsFile = path.join(root, 'calls.jsonl');
  responsesFile = path.join(root, 'responses.json');
  envFile = path.join(root, 'env.jsonl');
  fs.writeFileSync(path.join(scriptsDir, 'c4-receive.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.appendFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env.FEISHU_INTERNAL_SECRET ?? null) + '\\n');
const list = JSON.parse(fs.readFileSync(${JSON.stringify(responsesFile)}, 'utf8'));
const r = list.length > 1 ? list.shift() : list[0];
fs.writeFileSync(${JSON.stringify(responsesFile)}, JSON.stringify(list));
if (r.hangMs) { setTimeout(() => process.exit(0), r.hangMs); return; }
if (r.signal) process.kill(process.pid, r.signal);
if (r.stdout) process.stdout.write(r.stdout);
// a large write must flush before exit, so end without process.exit()
if (r.stdoutBytes) { process.stdout.write('x'.repeat(r.stdoutBytes)); process.exitCode = r.exit; } else process.exit(r.exit);
`);
  fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{"type":"commonjs"}');
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const optionsPath = () => path.join(scriptsDir, 'c4-receive-options.json');
const writeOptions = options => fs.writeFileSync(optionsPath(), JSON.stringify({ options }));
const script = (...list) => fs.writeFileSync(responsesFile, JSON.stringify(list));
const recorded = () => fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : [];
const recordedSecrets = () => fs.existsSync(envFile)
  ? fs.readFileSync(envFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  : [];
const reject = (code, persisted) => {
  const error = { code, message: CORE_TEXT };
  if (persisted !== 'absent') error.persisted = persisted;
  return { exit: 1, stdout: JSON.stringify({ ok: false, error }) };
};

/**
 * Run sendToC4 against the fake Core.
 * spawnFailures: how many attempts run a missing executable instead (a real
 * spawn failure, so c4-receive never starts); onSpawnFail runs on each.
 */
function send(endpoint = TOPIC_EP, { spawnFailures = 0, onSpawnFail, timeoutMs, env } = {}) {
  const replies = [];
  const execCalls = [];
  let successes = 0;
  const missing = path.join(root, 'missing-node');
  const execFileImpl = (file, args, opts, cb) => {
    execCalls.push({ file, args, opts });
    if (spawnFailures > 0) {
      spawnFailures--;
      if (onSpawnFail) onSpawnFail();
      return realExecFile(missing, args, opts, cb);
    }
    return realExecFile(file, args, opts, cb);
  };
  return new Promise(resolve => {
    sendToC4('feishu', endpoint, 'hello', m => replies.push(m), () => successes++, {
      retryDelayMs: 10,
      ...(timeoutMs !== undefined && { timeoutMs }),
      ...(env !== undefined && { env }),
      execFileImpl,
      onDone: outcome => resolve({ outcome, replies, successes, execCalls, calls: recorded() })
    });
  });
}

const assertNoCoreText = replies => {
  for (const r of replies) assert.ok(r === null || !String(r).includes(CORE_TEXT), `leaked core text: ${r}`);
};

describe('option probe and argv', () => {
  const base = { source: 'feishu', endpoint: 'oc_x|type:p2p', content: 'hi', sessionGroup: 'dm-oc_x' };
  // Golden sample: argv after c4-receive.js exactly as origin/main 890a7fd (v0.3.6) built it.
  const GOLDEN = ['--channel', 'feishu', '--endpoint', 'oc_x|type:p2p', '--json', '--content', 'hi'];

  test('no options file (old Core): argv identical to the pre-multi-session build', () => {
    assert.equal(c4ReceiveSupportsOption('--session-group'), false);
    assert.deepEqual(buildC4ReceiveArgs(base), GOLDEN);
  });

  test('options file without --session-group (0.9.x shape): not passed', () => {
    writeOptions({ '--channel': { takesValue: true }, '--endpoint': { takesValue: true }, '--json': {} });
    assert.deepEqual(buildC4ReceiveArgs(base), GOLDEN);
  });

  test('malformed options files count as unsupported', () => {
    const bad = [
      '{not json',
      'null',
      '[]',
      JSON.stringify({ options: ['--session-group'] }),
      JSON.stringify({ options: null }),
      JSON.stringify({ options: 'x' }),
      JSON.stringify({ '--session-group': {} }),
    ];
    for (const text of bad) {
      fs.writeFileSync(optionsPath(), text);
      assert.equal(c4ReceiveSupportsOption('--session-group'), false, text);
      assert.deepEqual(buildC4ReceiveArgs(base), GOLDEN, text);
    }
  });

  test('inherited keys are ignored (own keys only)', () => {
    fs.writeFileSync(optionsPath(), JSON.stringify({ options: { __proto__: null } }));
    assert.equal(c4ReceiveSupportsOption('toString'), false);
    assert.equal(c4ReceiveSupportsOption('constructor'), false);
  });

  test('unreadable options path counts as unsupported', () => {
    fs.mkdirSync(optionsPath());
    assert.equal(c4ReceiveSupportsOption('--session-group'), false);
  });

  test('supported: group appended last', () => {
    writeOptions(SG);
    assert.deepEqual(buildC4ReceiveArgs(base), [...GOLDEN, '--session-group', 'dm-oc_x']);
  });

  test('empty or missing group is never passed', () => {
    writeOptions(SG);
    assert.deepEqual(buildC4ReceiveArgs({ ...base, sessionGroup: '' }), GOLDEN);
    assert.deepEqual(buildC4ReceiveArgs({ ...base, sessionGroup: undefined }), GOLDEN);
  });

  test('options file is re-read on every call', () => {
    assert.equal(c4ReceiveSupportsOption('--session-group'), false);
    writeOptions(SG);
    assert.equal(c4ReceiveSupportsOption('--session-group'), true);
    fs.rmSync(optionsPath());
    assert.equal(c4ReceiveSupportsOption('--session-group'), false);
  });

  test('c4-receive path follows ZYLOS_DIR, falling back to $HOME/zylos', () => {
    assert.equal(getC4ReceivePath(), path.join(scriptsDir, 'c4-receive.js'));
    process.env.ZYLOS_DIR = '';
    assert.equal(getC4ReceivePath(),
      path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js'));
  });
});

describe('rejection classification', () => {
  test('separates stored, not stored and uncertain', () => {
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: ['D1'] } }), 'stored');
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: [] } }), 'not_stored');
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: null } }), 'uncertain');
    assert.equal(classifyC4Rejection({ ok: false, error: {} }), 'uncertain');
    assert.equal(classifyC4Rejection({ ok: false, error: { persisted: 'D1' } }), 'uncertain');
  });

  test('notices are the Telegram sentences, verbatim', () => {
    assert.equal(TRY_LATER, "Sorry, I couldn't take this message right now. Please try again later.");
    assert.equal(MAYBE_LOST, "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.");
  });
});

describe('sendToC4 rejection and retry handling', () => {
  test('new Core: sends the topic group, runs process.execPath with the 35s timeout', async () => {
    writeOptions(SG);
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    assert.equal(r.outcome, 'sent');
    assert.equal(r.successes, 1);
    assert.deepEqual(r.replies, []);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', TOPIC_GROUP]);
    assert.equal(r.execCalls[0].file, process.execPath);
    assert.equal(r.execCalls[0].args[0], path.join(scriptsDir, 'c4-receive.js'));
    assert.equal(C4_RECEIVE_TIMEOUT_MS, 35000);
    assert.equal(r.execCalls[0].opts.timeout, 35000);
  });

  test('new Core: DM and plain group names', async () => {
    writeOptions(SG);
    script({ exit: 0, stdout: '{"ok":true}' });
    let r = await send('oc_dm|type:p2p|msg:om_1|thread:omt_1');
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', 'dm-oc_dm']);
    fs.rmSync(callsFile);
    r = await send(`${CHAT}|type:group|parent:om_p|msg:om_1`);
    assert.deepEqual(r.calls[0].slice(-2), ['--session-group', `group-${CHAT}`]);
  });

  test('old Core: argv identical to origin/main (golden)', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    assert.deepEqual(r.calls[0], ['--channel', 'feishu', '--endpoint', TOPIC_EP, '--json', '--content', 'hello']);
    assert.equal(r.successes, 1);
  });

  for (const code of ['SESSION_GROUP_INVALID', 'SESSION_GROUP_TOO_LONG']) {
    test(`${code} with persisted []: TRY_LATER, one call, never resent without the group`, async () => {
      writeOptions(SG);
      script(reject(code, []), { exit: 0, stdout: '{"ok":true}' });
      const r = await send();
      assert.equal(r.outcome, 'not_stored');
      assert.deepEqual(r.replies, [TRY_LATER]);
      assert.equal(r.calls.length, 1);
      assert.deepEqual(r.calls.at(-1).slice(-2), ['--session-group', TOPIC_GROUP]);
      assert.equal(r.successes, 0);
      assertNoCoreText(r.replies);
    });
  }

  test('stored (persisted non-empty): onReject(null), nothing sent, no resend', async () => {
    writeOptions(SG);
    script(reject('STATUS_NOTICE_FAILED', ['D1']), { exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    assert.equal(r.outcome, 'stored');
    assert.deepEqual(r.replies, [null]);
    assert.equal(r.calls.length, 1);
    assert.equal(r.successes, 0);
  });

  for (const persisted of [null, 'absent']) {
    test(`uncertain (persisted ${persisted}): MAYBE_LOST, no resend`, async () => {
      script(reject('SOME_ERROR', persisted), { exit: 0, stdout: '{"ok":true}' });
      const r = await send();
      assert.equal(r.outcome, 'uncertain');
      assert.deepEqual(r.replies, [MAYBE_LOST]);
      assert.equal(r.calls.length, 1);
      assertNoCoreText(r.replies);
    });
  }

  const unknownCases = [
    ['non-zero exit without output', { exit: 1 }],
    ['non-JSON output', { exit: 2, stdout: 'boom' }],
    ['killed by SIGKILL', { signal: 'SIGKILL', exit: 0 }],
    ['output beyond maxBuffer', { stdoutBytes: 2 * 1024 * 1024, exit: 0 }],
  ];
  for (const [label, response] of unknownCases) {
    test(`unknown outcome (${label}): MAYBE_LOST, not resent`, async () => {
      writeOptions(SG);
      script(response, { exit: 0, stdout: '{"ok":true}' });
      const r = await send();
      assert.equal(r.outcome, 'unknown');
      assert.deepEqual(r.replies, [MAYBE_LOST]);
      assert.equal(r.calls.length, 1);
      assert.equal(r.execCalls.length, 1);
      assert.equal(r.successes, 0);
    });
  }

  test('spawn failure: retried once, options re-read, same group', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    // Core gets upgraded between the attempts: the retry must see the new options file.
    const r = await send(TOPIC_EP, { spawnFailures: 1, onSpawnFail: () => writeOptions(SG) });
    assert.equal(r.outcome, 'sent');
    assert.equal(r.execCalls.length, 2);
    assert.ok(!r.execCalls[0].args.includes('--session-group'));
    assert.deepEqual(r.execCalls[1].args.slice(-2), ['--session-group', TOPIC_GROUP]);
    assert.equal(r.calls.length, 1);
    assert.equal(r.successes, 1);
    assert.deepEqual(r.replies, []);
  });

  test('spawn failure twice: MAYBE_LOST after exactly one retry', async () => {
    writeOptions(SG);
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send(TOPIC_EP, { spawnFailures: 2 });
    assert.equal(r.outcome, 'failed');
    assert.equal(r.execCalls.length, 2);
    assert.deepEqual(r.execCalls[0].args, r.execCalls[1].args);
    assert.deepEqual(r.replies, [MAYBE_LOST]);
    assert.equal(r.calls.length, 0);
  });

  test('spawn failure then structured rejection: handled like the first attempt', async () => {
    writeOptions(SG);
    script(reject('SESSION_GROUP_INVALID', []));
    const r = await send(TOPIC_EP, { spawnFailures: 1 });
    assert.equal(r.outcome, 'not_stored');
    assert.deepEqual(r.replies, [TRY_LATER]);
    assert.equal(r.execCalls.length, 2);
  });

  for (const endpoint of ['oc_bare', `${CHAT}|type:topic`, 'oc_a.b|type:group']) {
    test(`no session group for ${JSON.stringify(endpoint)}: TRY_LATER, Core never called`, async () => {
      writeOptions(SG);
      script({ exit: 0, stdout: '{"ok":true}' });
      const r = await send(endpoint);
      assert.equal(r.outcome, 'no_group');
      assert.deepEqual(r.replies, [TRY_LATER]);
      assert.equal(r.execCalls.length, 0);
      assert.equal(r.calls.length, 0);
    });
  }

  for (const endpoint of ['oc_bare', `${CHAT}|type:topic`, 'oc_a.b|type:group']) {
    test(`old Core: no session group is derived, ${JSON.stringify(endpoint)} is sent exactly as on main`, async () => {
      script({ exit: 0, stdout: '{"ok":true}' });
      const r = await send(endpoint);
      assert.equal(r.outcome, 'sent');
      assert.deepEqual(r.replies, []);
      assert.deepEqual(r.calls, [['--channel', 'feishu', '--endpoint', endpoint, '--json', '--content', 'hello']]);
      assert.equal(r.execCalls[0].opts.timeout, 35000);
    });
  }

  test('old Core: the session group is never derived (mapping not consulted)', async () => {
    // 0.9.x shape: options file exists but does not list --session-group.
    writeOptions({ '--channel': { takesValue: true } });
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send('oc_bare');
    assert.equal(r.outcome, 'sent');
    assert.ok(!r.execCalls[0].args.includes('--session-group'));
  });

  for (const core of ['new', 'old']) {
    test(`${core} Core: timeout kills c4-receive, MAYBE_LOST, not resent`, async () => {
      if (core === 'new') writeOptions(SG);
      script({ hangMs: 5000, exit: 0 }, { exit: 0, stdout: '{"ok":true}' });
      const r = await send(TOPIC_EP, { timeoutMs: 300 });
      assert.equal(r.outcome, 'unknown');
      assert.deepEqual(r.replies, [MAYBE_LOST]);
      assert.equal(r.execCalls.length, 1);
      assert.equal(r.execCalls[0].opts.timeout, 300);
      assert.equal(r.successes, 0);
    });
  }

  test('spawn failure on an old Core, Core upgraded before the retry, unmappable endpoint: TRY_LATER, Core never reached', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send('oc_bare', { spawnFailures: 1, onSpawnFail: () => writeOptions(SG) });
    assert.equal(r.outcome, 'no_group');
    assert.deepEqual(r.replies, [TRY_LATER]);
    assert.equal(r.execCalls.length, 1);
    assert.equal(r.calls.length, 0);
  });

  test('empty content: not sent', async () => {
    const r = await new Promise(resolve => {
      const calls = [];
      sendToC4('feishu', TOPIC_EP, '', () => calls.push('reject'), () => calls.push('ok'), {
        execFileImpl: () => calls.push('exec'),
        onDone: outcome => resolve({ outcome, calls })
      });
    });
    assert.equal(r.outcome, 'empty');
    assert.deepEqual(r.calls, []);
  });
});

describe('child environment', () => {
  const SECRET = 'secret-for-send-js';
  const childEnv = () => ({ ...process.env, FEISHU_INTERNAL_SECRET: SECRET });

  test('env reaches c4-receive on new and old Core', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    let r = await send(TOPIC_EP, { env: childEnv() });
    assert.equal(r.outcome, 'sent');
    assert.equal(r.execCalls[0].opts.env.FEISHU_INTERNAL_SECRET, SECRET);
    writeOptions(SG);
    r = await send(TOPIC_EP, { env: childEnv() });
    assert.equal(r.outcome, 'sent');
    assert.deepEqual(recordedSecrets(), [SECRET, SECRET]);
  });

  test('env is kept on the spawn-failure retry', async () => {
    writeOptions(SG);
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send(TOPIC_EP, { spawnFailures: 1, env: childEnv() });
    assert.equal(r.outcome, 'sent');
    assert.equal(r.execCalls.length, 2);
    for (const call of r.execCalls) assert.equal(call.opts.env.FEISHU_INTERNAL_SECRET, SECRET);
    assert.deepEqual(recordedSecrets(), [SECRET]);
  });

  test('without env the child inherits this process environment', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    assert.equal(r.execCalls[0].opts.env, undefined);
    assert.equal(r.outcome, 'sent');
  });
});

describe('createRejectReply callback', () => {
  const make = (withStored = true) => {
    const log = [];
    const reply = createRejectReply({
      removeTyping: () => log.push('typing-removed'),
      onStored: withStored ? () => log.push('cursor') : undefined,
      deliver: text => log.push(['deliver', text])
    });
    return { reply, log };
  };

  test('stored (null): removes typing, calls onStored, sends nothing', () => {
    const { reply, log } = make();
    reply(null);
    assert.deepEqual(log, ['typing-removed', 'cursor']);
  });

  test('stored (null) without onStored (feishu DM handler): removes typing only', () => {
    const { reply, log } = make(false);
    reply(null);
    assert.deepEqual(log, ['typing-removed']);
  });

  test('notice: removes typing and delivers exactly that text, onStored not called', () => {
    for (const notice of [TRY_LATER, MAYBE_LOST]) {
      const { reply, log } = make();
      reply(notice);
      assert.deepEqual(log, ['typing-removed', ['deliver', notice]]);
    }
  });

  test('default smart-mode without @mention delivers the same notice as a mentioned message', async () => {
    writeOptions(SG);
    script(reject('SESSION_GROUP_INVALID', []));
    const log = [];
    const reply = createRejectReply({
      removeTyping: () => log.push('typing-removed'),
      onStored: () => log.push('cursor'),
      deliver: text => log.push(['deliver', text])
    });
    await new Promise(resolve => sendToC4('feishu', TOPIC_EP, 'hi', reply, null, { onDone: resolve }));
    assert.deepEqual(log, ['typing-removed', ['deliver', TRY_LATER]]);
  });
});

describe('index.js wiring (source checks)', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  test('every inbound call goes through the wrapper that passes FEISHU_INTERNAL_SECRET', () => {
    assert.match(src, /import \{ sendToC4 as sendToC4Core, createRejectReply \} from '\.\/lib\/c4\.js';/);
    const wrapper = src.slice(src.indexOf('function sendToC4(source, endpoint, content, onReject, onSuccess = null, options = {}) {'));
    assert.ok(wrapper.length < src.length, 'local sendToC4 wrapper exists');
    const body = wrapper.slice(0, wrapper.indexOf('\n}\n'));
    assert.match(body, /sendToC4Core\(source, endpoint, content, onReject, onSuccess,/);
    assert.match(body, /env: \{ \.\.\.process\.env, FEISHU_INTERNAL_SECRET: INTERNAL_SECRET \}/);
    assert.equal(src.match(/sendToC4Core\(/g).length, 1, 'only the wrapper calls lib/c4.js directly');
    assert.ok(!/\bexecFile\b/.test(src), 'index.js no longer spawns c4-receive itself');
  });

  test('DM and group reject notices go through sendThreadAwareMessage; only the group one advances the cursor when stored', () => {
    const callbacks = src.match(/createRejectReply\(\{[\s\S]*?\n    \}\);/g);
    assert.equal(callbacks.length, 2);
    for (const cb of callbacks) {
      assert.match(cb, /removeTyping: \(\) => removeTypingIndicator\(messageId\)/);
      assert.match(cb, /deliver: \(errMsg\) => sendThreadAwareMessage\(chatId, errMsg, \{ chatType, rootId, parentId, messageId, threadId \}\)/);
    }
    const [dm, group] = callbacks;
    assert.ok(!dm.includes('onStored'), 'DMs have no group cursor');
    assert.match(group, /onStored: markCursorDelivered,/);
  });
});

describe('opt-in silent smart groups', () => {
  test('default arguments remain unchanged; enabled and supported adds the flag', () => {
    const base = { source: 'feishu', endpoint: TOPIC_EP, content: 'hi', supportsSessionGroup: false };
    const defaults = buildC4ReceiveArgs(base);
    assert.ok(!defaults.includes('--silent-status'));
    assert.deepEqual(buildC4ReceiveArgs({ ...base, silentStatus: true, supportsSilentStatus: true }),
      [...defaults, '--silent-status']);
    assert.deepEqual(buildC4ReceiveArgs({ ...base, silentStatus: true, supportsSilentStatus: false }), defaults);
  });

  test('real Core subprocess receives silent flag without losing session grouping', async () => {
    writeOptions({ ...SG, '--silent-status': { takesValue: false } });
    script({ exit: 0 });
    const outcome = await new Promise(resolve => sendToC4('feishu', TOPIC_EP, 'hi', null, null,
      { silentStatus: true, onDone: resolve }));
    assert.equal(outcome, 'sent');
    assert.deepEqual(recorded(), [['--channel', 'feishu', '--endpoint', TOPIC_EP,
      '--json', '--content', 'hi', '--session-group', TOPIC_GROUP, '--silent-status']]);
  });

  test('unsupported Core cannot accidentally post a status for a silent message', async () => {
    writeOptions(SG);
    let attempts = 0;
    const notices = [];
    const outcome = await new Promise(resolve => sendToC4('feishu', TOPIC_EP, 'hi',
      notice => notices.push(notice), null,
      { silentStatus: true, execFileImpl: () => { attempts++; }, onDone: resolve }));
    assert.equal(outcome, 'unsupported_silent_status');
    assert.equal(attempts, 0);
    assert.deepEqual(notices, [TRY_LATER]);
  });

  test('silent rejects clear typing; only confirmed storage advances the cursor', () => {
    for (const notice of [TRY_LATER, MAYBE_LOST, null]) {
      const actions = [];
      const rejectReply = createRejectReply({ silent: true,
        removeTyping: () => actions.push('typing'), onStored: () => actions.push('cursor'),
        deliver: () => assert.fail('silent message must not post a notice') });
      rejectReply(notice);
      assert.deepEqual(actions, notice === null ? ['typing', 'cursor'] : ['typing']);
    }
  });

  test('only smart unmentioned group calls opt in; DM reject callback has no silent option', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /const silentGroup = config\.c4\?\.smartNoMentionSilent === true && smartNoMention;/);
    assert.equal(source.match(/sendToC4\('feishu', endpoint, msg, groupRejectReply, markCursorDelivered, \{ silentStatus: silentGroup \}\)/g)?.length, 5);
    const callbacks = source.match(/createRejectReply\(\{[\s\S]*?\n    \}\);/g);
    assert.ok(!callbacks[0].includes('silent:'));
    assert.match(callbacks[1], /silent: silentGroup,/);
  });
});
