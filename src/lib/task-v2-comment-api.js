import { normalizeFeishuTimestamp } from './task-comment-event.js';

const MAX_ID_LENGTH = 512;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field);
}

function apiError(response, operation) {
  const error = new Error(response?.msg || `${operation} failed`);
  error.code = response?.code ?? 'FEISHU_API_ERROR';
  error.retryable = true;
  return error;
}

function isMissingCommentResponse(response) {
  const status = response?.response?.status ?? response?.status;
  if (status === 404) return true;
  const text = String(response?.msg ?? response?.message ?? '').toLowerCase();
  return (
    text.includes('not found')
    || text.includes('deleted')
    || text.includes('不存在')
    || text.includes('已删除')
  );
}

function normalizeComment(rawComment) {
  const comment = requireRecord(rawComment, 'Feishu Task v2 comment');
  const createdAt = normalizeFeishuTimestamp(
    comment.created_at ?? comment.updated_at,
    'Feishu comment.created_at',
  );
  const updatedAt = normalizeFeishuTimestamp(
    comment.updated_at ?? comment.created_at,
    'Feishu comment.updated_at',
  );
  return {
    id: requireText(comment.id, 'Feishu comment.id'),
    content: requireText(comment.content, 'Feishu comment.content', 20_000),
    creator: {
      id: requireText(comment.creator?.id, 'Feishu comment.creator.id'),
      type: optionalText(comment.creator?.type, 'Feishu comment.creator.type'),
      role: optionalText(comment.creator?.role, 'Feishu comment.creator.role'),
      name: optionalText(comment.creator?.name, 'Feishu comment.creator.name'),
    },
    replyToCommentId: optionalText(
      comment.reply_to_comment_id,
      'Feishu comment.reply_to_comment_id',
    ),
    createdAt,
    updatedAt,
    resourceType: optionalText(comment.resource_type, 'Feishu comment.resource_type'),
    resourceId: optionalText(comment.resource_id, 'Feishu comment.resource_id'),
  };
}

export function createSdkTaskV2CommentApi({ client }) {
  const sdk = requireRecord(client, 'Feishu SDK client');
  const commentApi = sdk.task?.v2?.comment;
  if (
    !commentApi
    || typeof commentApi.get !== 'function'
    || typeof commentApi.list !== 'function'
    || typeof commentApi.create !== 'function'
  ) {
    throw new TypeError('Feishu SDK task.v2.comment API is unavailable');
  }
  return Object.freeze({
    async getComment({ commentId }) {
      const id = requireText(commentId, 'comment lookup.commentId');
      let response;
      try {
        response = await commentApi.get({
          params: { user_id_type: 'open_id' },
          path: { comment_id: id },
        });
      } catch (error) {
        if (isMissingCommentResponse(error)) return { kind: 'missing', commentId: id };
        error.retryable ??= true;
        throw error;
      }
      if (response?.code !== 0) {
        if (isMissingCommentResponse(response)) return { kind: 'missing', commentId: id };
        throw apiError(response, 'Feishu Task v2 comment get');
      }
      return { kind: 'found', comment: normalizeComment(response.data?.comment) };
    },
    async listComments({ taskGuid }) {
      const guid = requireText(taskGuid, 'comment list.taskGuid');
      const comments = [];
      let pageToken;
      do {
        const response = await commentApi.list({
          params: {
            page_size: 100,
            page_token: pageToken,
            resource_type: 'task',
            resource_id: guid,
            direction: 'asc',
            user_id_type: 'open_id',
          },
        });
        if (response?.code !== 0) throw apiError(response, 'Feishu Task v2 comment list');
        comments.push(...(response.data?.items ?? []).map(normalizeComment));
        pageToken = response.data?.has_more ? response.data?.page_token : null;
      } while (pageToken);
      return comments;
    },
    async reply({ taskGuid, replyToCommentId, content }) {
      const guid = requireText(taskGuid, 'comment reply.taskGuid');
      const parentId = requireText(replyToCommentId, 'comment reply.replyToCommentId');
      const body = requireText(content, 'comment reply.content', 20_000);
      const response = await commentApi.create({
        params: { user_id_type: 'open_id' },
        data: {
          content: body,
          resource_type: 'task',
          resource_id: guid,
          reply_to_comment_id: parentId,
        },
      });
      if (response?.code !== 0) throw apiError(response, 'Feishu Task v2 comment create');
      return normalizeComment(response.data?.comment);
    },
  });
}
