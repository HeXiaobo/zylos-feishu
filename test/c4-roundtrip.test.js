import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Cross-repository acceptance is opt-in, using only the local sibling checkout.
const core = process.env.ARCH2_CORE_DIR;
test('real C4 outbox to real Feishu sender records sent/failed/unknown with platform id', { skip: !core }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-feishu-roundtrip-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scripts = path.join(home, '.claude/skills/feishu/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(home, 'zylos/components/feishu'), { recursive: true });
  fs.writeFileSync(path.join(home, 'zylos/components/feishu/config.json'), '{"enabled":true}');
  fs.writeFileSync(path.join(scripts, 'send.js'), `import ${JSON.stringify(new URL('../scripts/send.js', import.meta.url).href)};`);
  const loader = new URL('../test-fixtures/card-entry-loader.mjs', import.meta.url).href;
  // The uuid/carrier receipt contract is an arch2 feature; opt in explicitly.
  const env = { HOME: home, ZYLOS_DIR: home, ZYLOS_ARCH2: '1', PATH: process.env.PATH, LANG: 'C', NODE_OPTIONS: `--no-warnings --experimental-loader=${loader}` };
  for (const [mode, expected] of [['success', 'sent'], ['rejected', 'failed'], ['uncertain', 'unknown']]) {
    const result = spawnSync(process.execPath, [path.join(core, 'skills/comm-bridge/scripts/c4-send.js'), 'feishu', 'oc_1|type:p2p', '普通文本'], {
      env: { ...env, CARD_ENTRY_SEND_FAIL: mode === 'rejected' ? '1' : '', CARD_ENTRY_UNCERTAIN: mode === 'uncertain' ? '1' : '' }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, expected === 'sent' ? 0 : 1, result.stdout + result.stderr);
    const read = spawnSync(process.execPath, ['--input-type=module', '-e', `const {getDb,close}=await import(${JSON.stringify(new URL('skills/comm-bridge/scripts/c4-db.js', `file://${core}/`).href)}); console.log(JSON.stringify(getDb().prepare("SELECT * FROM conversations ORDER BY id DESC LIMIT 1").get()));close();`], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(read.status, 0, read.stderr);
    const row = JSON.parse(read.stdout.trim().split('\n').at(-1));
    assert.equal(row.send_status, expected);
    assert.equal(row.platform_msg_id, expected === 'sent' ? 'om_test_entry' : null);
    const call = JSON.parse(result.stdout.split('\n').find(s => s.startsWith('ENTRY_CALL ')).slice(11));
    assert.equal(call.name, 'sendMarkdownCard');
    assert.equal(call.args.at(-1).uuid, `c4.outbound.${row.id}`);
  }
});
