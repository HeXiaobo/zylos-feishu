import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openTaskCommentStore } from '../src/lib/task-comment-store.js';

const request = {
  appId: 'app-retry', idempotencyKey: 'progress-event', taskGuid: 'task-guid',
  content: 'progress update', replyToCommentId: null,
};

function dbPathFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-comment-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'comments.db');
}

test('confirmed rejection survives restart and only one connection can reclaim it', t => {
  const dbPath = dbPathFor(t);
  const first = openTaskCommentStore({ dbPath });
  first.beginOutbound(request);
  first.failOutbound({ ...request, error: 'rate limited', retryAllowed: true });
  first.close();
  const store = openTaskCommentStore({ dbPath });
  const other = openTaskCommentStore({ dbPath });
  t.after(() => { other.close(); store.close(); });
  assert.throws(() => store.beginOutbound({ ...request, content: 'changed' }), /different content/);
  assert.equal(store.adoptOutboundComment({ ...request, commentId: 'unrelated' }), null);
  const retry = store.beginOutbound(request);
  assert.equal(retry.created, true);
  assert.equal(retry.delivery.attempt, 2);
  assert.equal(other.beginOutbound(request).created, false);
  // Once the retry itself has an uncertain outcome, replay must block again.
  store.failOutbound({ ...request, error: 'timeout' });
  assert.equal(other.beginOutbound(request).created, false);
});

test('legacy database migration keeps uncertain sends blocked', t => {
  const dbPath = dbPathFor(t);
  const original = openTaskCommentStore({ dbPath });
  original.beginOutbound(request);
  original.failOutbound({ ...request, error: 'legacy uncertain send' });
  original.close();
  const legacy = new Database(dbPath);
  legacy.exec('ALTER TABLE feishu_task_comment_outbound DROP COLUMN retry_allowed');
  legacy.close();
  const migrated = openTaskCommentStore({ dbPath });
  t.after(() => migrated.close());
  assert.equal(migrated.beginOutbound(request).created, false);
  assert.equal(migrated.queryOutbound(request).status, 'dead_letter');
});
