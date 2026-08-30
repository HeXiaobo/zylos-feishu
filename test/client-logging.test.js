import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('shared SDK client construction keeps stdout machine-readable', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "process.env.FEISHU_APP_ID='cli_test';"
        + "process.env.FEISHU_APP_SECRET='secret_test';"
        + "const { getClient } = await import('./src/lib/client.js');"
        + 'getClient();',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
