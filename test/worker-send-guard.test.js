// Card F / review item 2, the cheap part: a worker session must not be able to
// send a message to a person.
//
// The full fix (separate OS identity, read-only database, no channel tools) is
// next version. This is only the default guard: the sender refuses to run when
// ZYLOS_TICKET_ROLE=worker, whatever the arguments are, and exits non-zero so
// C4 records the outbound row as failed instead of silently dropping it.
//
// It is a guard, not a security boundary: the same system user can still run the
// channel API directly or unset the variable. That limit is documented in the
// README.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);
const loader = new URL('../test-fixtures/card-entry-loader.mjs', import.meta.url).href;

function runSend(t, { content = '普通文本', endpoint = 'oc_1|type:p2p', env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-worker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'zylos/components/feishu'), { recursive: true });
  fs.writeFileSync(path.join(home, 'zylos/components/feishu/config.json'), JSON.stringify({ enabled: true }));
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader, 'scripts/send.js', endpoint, content], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: {
      ...process.env, HOME: home, ZYLOS_ARCH2: '1', C4_OUTBOUND_ID: '',
      CARD_ENTRY_SEND_FAIL: '', CARD_ENTRY_UNCERTAIN: '', ZYLOS_TICKET_ROLE: '', ...env,
    },
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return {
    status: result.status,
    stderr: result.stderr,
    receipts: lines.filter(line => line.startsWith('C4_RESULT ')).map(line => JSON.parse(line.slice('C4_RESULT '.length))),
    calls: lines.filter(line => line.startsWith('ENTRY_CALL ')).map(line => JSON.parse(line.slice('ENTRY_CALL '.length))),
  };
}

test('a worker session cannot send text', t => {
  const r = runSend(t, { env: { ZYLOS_TICKET_ROLE: 'worker' } });
  assert.notEqual(r.status, 0, 'a refused send must exit non-zero');
  assert.deepEqual(r.calls, [], 'nothing may reach the Feishu API');
  assert.match(r.stderr, /worker/i, 'the refusal must say why');
});

test('a worker session cannot send a card either', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-worker-card-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'zylos/components/feishu'), { recursive: true });
  fs.writeFileSync(path.join(home, 'zylos/components/feishu/config.json'), JSON.stringify({ enabled: true }));
  const cardPath = path.join(home, 'card.json');
  fs.writeFileSync(cardPath, JSON.stringify({ schema: '2.0', config: { summary: { content: 's' } }, body: { elements: [] } }));
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-loader', loader,
    'scripts/send.js', 'oc_1|type:p2p', `[MEDIA:card]${cardPath}`], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: home, ZYLOS_ARCH2: '1', C4_OUTBOUND_ID: '', ZYLOS_TICKET_ROLE: 'worker' },
  });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('ENTRY_CALL'), 'a worker may not create any message');
});

test('a worker session cannot send media', t => {
  const r = runSend(t, { content: '[MEDIA:image]/tmp/none.png', env: { ZYLOS_TICKET_ROLE: 'worker' } });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
});

test('a failed worker send still reports a receipt so C4 can record it', t => {
  const r = runSend(t, { env: { ZYLOS_TICKET_ROLE: 'worker', C4_OUTBOUND_ID: '77' } });
  assert.equal(r.receipts.length, 1, 'the refused send still emits C4_RESULT');
  assert.equal(r.receipts[0].status, 'failed');
  assert.equal(r.receipts[0].platform_msg_id, null);
});

test('the other roles and an unset role keep working', t => {
  for (const role of ['front', '']) {
    const r = runSend(t, { env: { ZYLOS_TICKET_ROLE: role } });
    assert.equal(r.status, 0, `role=${role}: ${r.stderr}`);
    assert.equal(r.calls.length, 1);
  }
  const unknown = runSend(t, { env: { ZYLOS_TICKET_ROLE: 'auditor' } });
  assert.equal(unknown.status, 0, 'only the literal worker role is refused');
});

test('the refusal happens before any card or media handling', () => {
  const source = fs.readFileSync(new URL('../scripts/send.js', import.meta.url), 'utf8');
  const guard = source.indexOf('ZYLOS_TICKET_ROLE');
  assert.notEqual(guard, -1, 'the sender must check the ticket role');
  for (const later of ['isCardMessage', 'mediaMatch =', 'async function send()']) {
    assert.ok(source.indexOf(later) > guard, `${later} must come after the role check`);
  }
});

// ---------------------------------------------------------------------------
// The limits of this guard are documented, not discovered later.
// ---------------------------------------------------------------------------
test('the README states that this is a guard and not a security boundary', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Worker Sessions Cannot Send'));
  assert.ok(section.length > 0, 'the worker guard must be documented');
  assert.match(section, /not a security boundary/i);
  assert.match(section, /same system user/i, 'the residual risk must be named concretely');
  assert.match(section, /next version/i, 'when the real isolation lands');
});

test('the README lists the multi-chunk message id limitation', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.slice(readme.indexOf('## Known Limitations'));
  assert.ok(section.length > 0, 'known limitations must be documented');
  assert.match(section, /last platform message id/i);
  assert.match(section, /earlier\*? chunk/i, 'the consequence for quoting an earlier chunk');
  assert.match(section, /optional item 1/i, 'which review item this limitation comes from');
});
