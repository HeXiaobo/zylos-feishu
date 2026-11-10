import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { buildC4ReceiveArgs } from '../src/lib/task-entry.js';
import { isRetryableC4Failure } from '../src/lib/c4-retry-policy.js';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const sender = source.slice(source.indexOf('async function sendToC4('), source.indexOf('function executeC4Receive('));
const detail = 'TypeError: appAccessToken /private/internal';
for (const silentStatus of [false, true]) {
  for (const code of ['INVALID_ARGS', 'UNHEALTHY_NOTIFY_FAILED', 'unknown', 'healthy']) {
    test(`C4 ${code} silentStatus=${silentStatus} keeps routing and sanitizes replies`, async () => {
      const calls = [], replies = [], logs = [];
      const context = {
        process: { env: {} }, INTERNAL_SECRET: 'test', C4_RECEIVE: '/test/receive.js',
        buildC4ReceiveArgs, isRetryableC4Failure,
        parseC4Response: stdout => { try { return JSON.parse(stdout); } catch { return null; } },
        requiresAssistantResponse: () => false, setTimeout: fn => fn(),
        console: Object.fromEntries(['log', 'warn', 'error'].map(k => [k, (...args) => logs.push(args.join(' '))])),
        execFile: (_node, args, _options, callback) => {
          calls.push(args);
          if (code === 'healthy') return callback(null, '{"ok":true}');
          const error = new Error(detail);
          if (code !== 'unknown') error.stdout = JSON.stringify({ ok: false, error: { code, message: detail } });
          callback(error, '');
        },
      };
      vm.createContext(context);
      vm.runInContext(sender, context);
      const send = context.sendToC4('feishu', 'oc-chat|msg:om-test', 'hello', text => replies.push(text), { silentStatus });
      if (code === 'healthy') await send;
      else await assert.rejects(send, error => error.message === detail);
      assert.deepEqual(replies, silentStatus || code === 'healthy' ? [] : ['暂时无法处理消息，请稍后重试。']);
      if (code !== 'healthy') assert.ok(logs.some(line => line.includes(detail)));
      for (const args of calls) {
        assert.equal(args.includes('--silent-status'), silentStatus);
        assert.equal(args.includes('--no-reply'), false);
        assert.equal(args[args.indexOf('--endpoint') + 1], 'oc-chat|msg:om-test');
      }
    });
  }
}

test('all three group media paths propagate passive status policy', () => {
  const group = source.slice(source.indexOf('// Group chat handling'));
  assert.equal((group.match(/silentStatus: !groupActivation.showImmediateResponse/g) || []).length, 3);
  assert.match(group, /const groupRejectReply = async \(\) => \{\s*if \(!groupActivation.showImmediateResponse\) return;/);
});
