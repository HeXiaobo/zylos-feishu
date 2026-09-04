import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { replyRefactorEnabled, REPLY_REFACTOR_FLAG } from '../src/lib/feishu-reply-composition.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

function sourceSlice(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  assert.notEqual(start, -1, `source marker not found: ${startMarker}`);
  const end = indexSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `end marker not found after ${startMarker}: ${endMarker}`);
  return indexSource.slice(start, end);
}

test('flag defaults to off so a default-config host takes the legacy path', () => {
  assert.equal(replyRefactorEnabled({}), false);
  assert.equal(replyRefactorEnabled({ [REPLY_REFACTOR_FLAG]: '' }), false);
  assert.equal(replyRefactorEnabled({ [REPLY_REFACTOR_FLAG]: '0' }), false);
  assert.equal(replyRefactorEnabled({ [REPLY_REFACTOR_FLAG]: '1' }), true);
  assert.equal(replyRefactorEnabled({ [REPLY_REFACTOR_FLAG]: 'true' }), true);
  assert.equal(replyRefactorEnabled({ [REPLY_REFACTOR_FLAG]: 'enabled' }), true);
});

test('legacy mode never opens a conversation response card it cannot complete (issue #54)', () => {
  const body = sourceSlice(
    'async function openConversationResponse(',
    '\nfunction requiresAssistantResponse(',
  );
  const guardIndex = body.indexOf('if (!replyRefactorV1Enabled)');
  assert.notEqual(guardIndex, -1, 'openConversationResponse must guard on the refactor flag');
  const openIndex = body.indexOf("getConversationResponseStream().open(");
  assert.notEqual(openIndex, -1, 'openConversationResponse must keep the flag-on card open path');
  assert.ok(
    guardIndex < openIndex,
    'the legacy gate must run before any card open attempt',
  );
  assert.match(body, /return responseRequest;/, 'legacy mode must still return the request for requestId matching');
});

test('legacy mode never tries to fail a card that was never opened', () => {
  const body = sourceSlice(
    'function failConversationResponse(',
    '\nfunction responseProjectionEvent(',
  );
  assert.match(body, /if \(!request \|\| !replyRefactorV1Enabled\) return Promise\.resolve\(false\);/);
});

test('card projection attempts are logged with the requestId and outcome (issue #54, observability)', () => {
  const body = sourceSlice(
    'function createConversationResponseProjectionPort(',
    '\nfunction createReplyReactionPort(',
  );
  assert.match(body, /Response card opened requestId=/);
  assert.match(body, /Response card projection requestId=\$\{operation\.requestId\} events=\$\{events\.length\} handled=/);
  assert.match(body, /terminal=/, 'projection log must surface terminal run events');
});

test('startup warns loudly when markdown cards are enabled without the refactor flag', () => {
  assert.match(
    indexSource,
    /useMarkdownCard is enabled but C4_REPLY_REFACTOR_V1 is unset/,
    'the legacy+markdown-card combination must produce a startup warning',
  );
});

test('terminal run event names keep a single source of truth in the composition module', () => {
  const libSource = fs.readFileSync(
    path.join(REPO_ROOT, 'src/lib/feishu-reply-composition.js'),
    'utf8',
  );
  assert.match(libSource, /export const TERMINAL_RUN_EVENTS = new Set\(\['RunCompleted', 'RunFailed', 'RunCancelled'\]\);/);
  assert.match(indexSource, /import \{[\s\S]*?TERMINAL_RUN_EVENTS[\s\S]*?\} from '\.\/lib\/feishu-reply-composition\.js';/);
});
