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

  function runSend(message, msgId, { endpoint, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--no-warnings', '--experimental-loader', LOADER, SEND_JS,
          endpoint ?? `oc_test_chat|type:p2p|msg:${msgId}`, message],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            HOME: home,
            ZYLOS_ARCH2: '1',
            FEISHU_APP_ID: '',
            FEISHU_APP_SECRET: '',
            FEISHU_INTERNAL_SECRET: 'test_entry_secret',
            ...env,
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

  // 波总 2026-11-17 点名要的这一条（生产上有过 660/662/665 先发「卡已发」、
  // 661/663 紧接着发卡失败的账）：**发卡失败时，不许有任何含「卡已发」的出站。**
  //
  // 做法是把它做成结构性的，而不是靠一句提醒：这句话的唯一载体是卡片自己
  // （`buildAskCard` 的最后一个 markdown 元素）。卡发不出去，人什么都收不到，
  // 也就不存在假话。所以这里断言的不是「Error 里没有这句话」，而是**整次运行
  // 里不存在任何一条出站（sendMessage / replyToMessage / 记录历史）带着它**。
  const CLAIM = '卡已发';

  function outboundTexts(result) {
    const fromCalls = callsFrom(result.stdout).map((call) => String(call.args?.[1] ?? ''));
    return { fromCalls, fromStdout: String(result.stdout), fromStderr: String(result.stderr) };
  }

  await t.test('a card that cannot be sent produces no outgoing message containing 卡已发', async () => {
    // 三张卡：一张结构必被拒（action 壳）、一张路径不存在、一张飞书拒收。
    const brokenStructure = path.join(cardsDir, 'broken.card.json');
    fs.writeFileSync(brokenStructure, JSON.stringify({
      schema: '2.0',
      config: { summary: { content: '需要你定' } },
      body: { elements: [
        { tag: 'markdown', content: '**走哪个方案？**' },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '甲' }, value: { z: 'ask' } }] },
        { tag: 'markdown', content: `${CLAIM}，点按钮或直接回复都行` },
      ] },
    }));
    const missing = path.join(cardsDir, 'does-not-exist.card.json');

    // 前两种在本地就被拦住：一次发送尝试都不该有，什么都不会到人眼前。
    // 第三种飞书真的拒了：那一次尝试会发生（这是「投递过但没成功」与「根本没投」
    // 的区别），但同样不能有任何成功的记录，也不能有任何出站文本说卡已发。
    const cases = [
      ['structure rejected before any send', brokenStructure, 0],
      ['file missing', missing, 0],
      ['feishu refuses the card', cardPath, 1],
    ];

    for (const [label, target, attempts, env] of cases) {
      const historyBefore = history.length;
      const result = await runSend(`[MEDIA:card]${target}`, `om_fail_${label.replace(/\W+/g, '_')}`, { env });

      assert.equal(result.code, 1, `${label}: must exit non-zero`);
      const { fromCalls, fromStdout, fromStderr } = outboundTexts(result);
      // 本地拦住的：一次发送尝试都没有。被飞书拒的：只有那一次尝试。
      assert.equal(fromCalls.length, attempts, `${label}: unexpected number of send attempts`);
      // 无论哪条路，都不能记下一条「发出去了」的历史。
      assert.equal(history.length, historyBefore, `${label}: no outgoing history may be recorded`);
      // 这句话不许以任何形式出现在出站侧——这是波总点名的那一条。
      const outgoing = [...fromCalls, ...history.slice(historyBefore).map((entry) => String(entry?.text ?? ''))];
      for (const text of outgoing) {
        assert.equal(text.includes(CLAIM), false, `${label}: no outgoing text may claim the card was sent`);
      }
      assert.doesNotMatch(fromStdout, /card sent|Message sent successfully/, `${label}: no success line`);
      // 失败必须明说，不能沉默。
      assert.match(fromStderr, /Error: /, `${label}: the failure must be reported`);
    }
  });

  await t.test('every failed send attempt writes its own line: via / code / message', async () => {
    const result = await runSend(`[MEDIA:card]${cardPath}`, 'om_fail_attempts', { env: { CARD_ENTRY_SEND_FAIL: '1' } });
    assert.equal(result.code, 1);
    // 只打最后一条，等于把前几次飞书说的话丢掉：生产上就是因此查不出 661/663 被拒的原因。
    assert.match(result.stderr, /\[feishu\] card attempt 1\/\d+ via=\S+ code=230020 message=/,
      'the failing attempt must name its via, code and message');
    assert.match(result.stderr, /Error: ERR_CARD_SEND: 230020/);
    // 不记卡片正文：日志里不许出现卡片里的内容。
    assert.equal(result.stderr.includes('entry summary'), false, 'the card body/summary must not be logged');
  });

  // 反向锁：卡片能发出去的时候，这句话在卡片里（人看得到），且仍然没有独立的
  // 一句话出站——这样「说」和「发」永远是同一件事。
  await t.test('a card that does send carries 卡已发 inside itself, never as a separate message', async () => {
    const claimCard = path.join(cardsDir, 'claim.card.json');
    fs.writeFileSync(claimCard, JSON.stringify({
      schema: '2.0',
      config: { summary: { content: '需要你定' } },
      body: { elements: [{ tag: 'markdown', content: `${CLAIM}，点按钮或直接回复都行` }] },
    }));
    const historyBefore = history.length;
    const result = await runSend(`[MEDIA:card]${claimCard}`, 'om_claim_ok');
    assert.equal(result.code, 0, result.stderr);

    const calls = callsFrom(result.stdout);
    assert.equal(calls.length, 1, 'exactly one message leaves this run: the card');
    assert.match(String(calls[0].args?.[1] ?? ''), new RegExp(CLAIM), 'the claim lives inside the card');
    // 出站历史只有一行，而且是卡片记录，不是一句话。
    assert.equal(history.length, historyBefore + 1);
    assert.match(history.at(-1).text, /^\[sent card\] /);
    assert.equal(history.at(-1).text.includes(CLAIM), false, 'the claim is not also sent as text');
  });
});
