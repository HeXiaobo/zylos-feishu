import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDelivery } from '../src/lib/c4-delivery.js';
const ROOT = new URL('../', import.meta.url);
const loader = new URL('../test-fixtures/card-entry-loader.mjs', import.meta.url).href;

function runSend(t, content = '普通文本', extra = {}, endpoint = 'oc_1|type:p2p') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-delivery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'zylos/components/feishu'), { recursive: true });
  fs.writeFileSync(path.join(home, 'zylos/components/feishu/config.json'), JSON.stringify({ enabled: true }));
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'scripts/send.js', endpoint, content], {
    cwd: ROOT, env: { ...process.env, ZYLOS_ARCH2: '1', HOME: home, C4_OUTBOUND_ID: '42', C4_DELIVERY_ID: '', CARD_ENTRY_SEND_FAIL: '', ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const lines = result.stdout.trim().split('\n');
  return { ...result, receipt: JSON.parse(lines.at(-1).replace(/^C4_RESULT /, '')),
    calls: lines.filter(s => s.startsWith('ENTRY_CALL ')).map(s => JSON.parse(s.slice(11))) };
}
test('actual sender consumes C4_OUTBOUND_ID as uuid and emits final sent receipt', t => {
  const r = runSend(t);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls[0].name, 'sendMarkdownCard');
  assert.equal(r.calls[0].args[3].uuid, '42');
  assert.deepEqual(r.receipt, { status: 'sent', platform_msg_id: 'om_test_entry' });
  assert.equal(runSend(t).calls[0].args[3].uuid, '42');
});
test('group card replies receive the same stable uuid', t => {
  const r = runSend(t, '普通', {}, 'oc_1|type:group|msg:om_in');
  assert.equal(r.calls[0].name, 'replyMarkdownCard');
  assert.equal(r.calls[0].args[2].uuid, '42');
});
test('C4_DELIVERY_ID remains supported as alias', t => {
  assert.equal(runSend(t, '普通', { C4_OUTBOUND_ID: '', C4_DELIVERY_ID: 'legacy' }).calls[0].args[3].uuid, 'legacy');
});
test('actual sender emits failed receipt and nonzero exit on API rejection', t => {
  const r = runSend(t, '文本', { CARD_ENTRY_SEND_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.equal(r.receipt.status, 'failed');
  assert.equal(r.receipt.platform_msg_id, null);
  assert.ok(r.calls.every(c => c.args.at(-1).uuid === '42'));
});
test('validation failure emits final failed receipt without sending', t => {
  const r = runSend(t, '[MEDIA:card]');
  assert.equal(r.status, 1); assert.equal(r.calls.length, 0); assert.equal(r.receipt.status, 'failed');
});
test('long message chunks get stable distinct ids across replay', t => {
  const one = runSend(t, '长'.repeat(4100));
  const two = runSend(t, '长'.repeat(4100));
  assert.equal(one.status, 0);
  assert.deepEqual(one.calls.map(c => c.args.at(-1).uuid), ['42', '42:1']);
  assert.deepEqual(one.calls.map(c => c.args.at(-1).uuid), two.calls.map(c => c.args.at(-1).uuid));
});
test('images/files consume uuid and return platform message id', t => {
  for (const kind of ['image', 'file']) {
    const r = runSend(t, `[MEDIA:${kind}]/fixture`);
    assert.equal(r.status, 0);
    assert.equal(r.calls.at(-1).args.at(-1).uuid, '42');
    assert.equal(r.receipt.platform_msg_id, 'om_test_entry');
  }
});
test('ambiguous send never falls back or automatically retries', async () => {
  const delivery = createDelivery('42'); let calls = 0;
  const send = delivery.wrap(async () => { calls++; return { success: false, message: 'timeout' }; }, 2);
  await assert.rejects(send('target', 'content'), /unknown/);
  assert.equal(calls, 1);
  assert.equal(delivery.result(1).uncertain, true);
});
test('accepted response without platform id cannot report sent', async () => {
  const delivery = createDelivery('42');
  await assert.rejects(delivery.wrap(async () => ({ success: true }), 0)(), /platform message id/);
  assert.equal(delivery.result(1).status, 'failed');
});

test('current C4_DELIVERY_ID takes precedence over stale legacy id', t => {
  const r = runSend(t, '普通', { C4_DELIVERY_ID: 'c4.outbound.7', C4_OUTBOUND_ID: 'stale' });
  assert.equal(r.calls[0].args[3].uuid, 'c4.outbound.7');
});

test('actual sender stops after ambiguous platform response without text/base fallback', t => {
  const r = runSend(t, '普通', { CARD_ENTRY_UNCERTAIN: '1' }, 'oc_1|type:group|msg:om_in');
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 1);
  assert.equal(r.receipt.status, 'failed');
  assert.equal(r.receipt.uncertain, true);
});
