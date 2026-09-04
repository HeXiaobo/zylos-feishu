import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

test('the streaming path honors message.useMarkdownCard like the c4-send path (issue #57)', () => {
  // The response stream factory must receive a preferPlainPlaceholder getter,
  // so useMarkdownCard=false covers the runtime streaming path too instead of
  // only scripts/send.js (c4-send). The getter form keeps the admin hot-reload
  // toggle effective without a process restart.
  assert.match(
    indexSource,
    /preferPlainPlaceholder: \(\) => config\.message\?\.useMarkdownCard === false,/,
  );
});

test('the stream option is exposed and documented on the factory', () => {
  const streamSource = fs.readFileSync(
    path.join(REPO_ROOT, 'src/lib/conversation-response-stream.js'),
    'utf8',
  );
  assert.match(streamSource, /preferPlainPlaceholder = false/);
  assert.match(streamSource, /Issue #57/);
});
