import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const STREAM_ENTRYPOINT = fileURLToPath(new URL('../scripts/stream.js', import.meta.url));

test('stream adapter loads Feishu credentials from the shared Zylos dotenv file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-stream-env-'));
  try {
    const zylosDir = path.join(home, 'zylos');
    fs.mkdirSync(zylosDir, { recursive: true });
    fs.writeFileSync(
      path.join(zylosDir, '.env'),
      'FEISHU_APP_ID=cli_stream_test\nFEISHU_APP_SECRET=stream_test_secret\n',
      { mode: 0o600 },
    );
    const env = { ...process.env, HOME: home, ZYLOS_DIR: zylosDir };
    delete env.FEISHU_APP_ID;
    delete env.FEISHU_APP_SECRET;

    const result = spawnSync('node', [STREAM_ENTRYPOINT], {
      env,
      input: '{}\n',
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid C4 assistant response delivery/);
    assert.doesNotMatch(result.stderr, /FEISHU_APP_ID and FEISHU_APP_SECRET must be set/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
