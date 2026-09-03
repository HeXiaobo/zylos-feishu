import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

test('owner DMs enter the runtime admission queue ahead of default-priority traffic (issue #53)', () => {
  assert.match(
    indexSource,
    /const dmPriority = chatType === 'p2p' && isOwner\(senderUserId, senderOpenId\) \? 2 : undefined;/,
    'p2p owner messages must be admitted at priority 2 via the existing isOwner() seam',
  );
});

test('every p2p sendToC4 call site passes the admission priority; group call sites do not', () => {
  const p2pSites = indexSource.match(/rejectReply, \{ assistantRequest: assistantRequest \|\| undefined, priority: dmPriority \}\);/g) ?? [];
  assert.equal(p2pSites.length, 4, 'the four single-line p2p call sites must pass priority');

  assert.match(
    indexSource,
    /assistantRequest: assistantRequest \|\| undefined,\n      priority: dmPriority,/,
    'the work-intake p2p call site must pass priority',
  );

  const groupSites = indexSource.match(/groupRejectReply, \{ assistantRequest: assistantRequest \|\| undefined \}\);/g) ?? [];
  assert.ok(groupSites.length >= 2, 'group call sites must stay on the default priority');
  for (const site of groupSites) {
    assert.equal(site.includes('priority'), false, 'group call sites must not pass priority');
  }
});

test('sendToC4 forwards priority to buildC4ReceiveArgs', () => {
  const signatureStart = indexSource.indexOf('async function sendToC4(');
  assert.notEqual(signatureStart, -1);
  const body = indexSource.slice(signatureStart, indexSource.indexOf('\nfunction ', signatureStart));
  assert.match(body, /\{ taskEnvelope, workIntakeEnvelope, assistantRequest, priority, onSuccess \} = \{\}/);
  assert.match(body, /buildC4ReceiveArgs\(\{[\s\S]*?priority,[\s\S]*?\}\);/);
});
