import assert from 'node:assert/strict';
import test from 'node:test';

import { createSdkTaskV2CommentApi } from '../src/lib/task-v2-comment-api.js';

function apiComment(overrides = {}) {
  return {
    id: 'comment-1',
    content: 'Please review this.',
    creator: { id: 'ou_author', type: 'user', name: 'Author' },
    reply_to_comment_id: 'comment-parent',
    created_at: '1787652000000',
    updated_at: '1787652001000',
    resource_type: 'task',
    resource_id: 'task-guid-1',
    ...overrides,
  };
}

test('uses official Task v2 Comment get/create shapes including reply_to_comment_id', async () => {
  const calls = [];
  const api = createSdkTaskV2CommentApi({
    client: {
      task: {
        v2: {
          comment: {
            async get(payload) {
              calls.push(['get', payload]);
              return { code: 0, data: { comment: apiComment() } };
            },
            async list() {
              return { code: 0, data: { items: [], has_more: false } };
            },
            async create(payload) {
              calls.push(['create', payload]);
              return { code: 0, data: { comment: apiComment({ id: 'comment-reply' }) } };
            },
          },
        },
      },
    },
  });

  const read = await api.getComment({ commentId: 'comment-1' });
  const reply = await api.reply({
    taskGuid: 'task-guid-1',
    replyToCommentId: 'comment-1',
    content: 'Agent answer',
  });

  assert.equal(read.kind, 'found');
  assert.equal(read.comment.replyToCommentId, 'comment-parent');
  assert.equal(reply.id, 'comment-reply');
  assert.deepEqual(calls[0][1], {
    params: { user_id_type: 'open_id' },
    path: { comment_id: 'comment-1' },
  });
  assert.deepEqual(calls[1][1].data, {
    content: 'Agent answer',
    resource_type: 'task',
    resource_id: 'task-guid-1',
    reply_to_comment_id: 'comment-1',
  });
});

test('treats a deleted/not-found read as missing while transient failures remain retryable', async () => {
  const missingApi = createSdkTaskV2CommentApi({
    client: {
      task: { v2: { comment: {
        async get() { return { code: 1470404, msg: 'comment has been deleted' }; },
        async list() { return { code: 0, data: { items: [], has_more: false } }; },
        async create() { throw new Error('unused'); },
      } } },
    },
  });
  assert.deepEqual(await missingApi.getComment({ commentId: 'deleted-comment' }), {
    kind: 'missing',
    commentId: 'deleted-comment',
  });

  const failingApi = createSdkTaskV2CommentApi({
    client: {
      task: { v2: { comment: {
        async get() { return { code: 99999, msg: 'temporary upstream failure' }; },
        async list() { return { code: 0, data: { items: [], has_more: false } }; },
        async create() { throw new Error('unused'); },
      } } },
    },
  });
  await assert.rejects(
    () => failingApi.getComment({ commentId: 'comment-1' }),
    (error) => error?.retryable === true,
  );
});
