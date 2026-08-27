import {
  createCoreFirstTaskCommentReply,
  createCoreTaskV2CommentMapping,
} from './task-comment-production.js';
import { createTaskCommentReplyAdapter } from './task-comment-runtime.js';
import {
  createFeishuNotificationAdapter,
  createSdkFeishuNotificationSender,
} from './task-notification-adapter.js';
import { createSdkTaskV2CommentApi } from './task-v2-comment-api.js';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

/**
 * Assemble the short-lived C4 reply path with the same canonical comment
 * coordinator and durable notification ledger used by the live worker.
 */
export function createTaskCommentReplyProduction({
  appId,
  core,
  store,
  client,
  createCoordinator,
  clock,
}) {
  const canonicalCore = requireRecord(core, 'Task comment reply Core');
  const canonicalStore = requireRecord(store, 'Task comment reply store');
  const sdkClient = requireRecord(client, 'Task comment reply Feishu client');
  const coordinatorFactory = requireFunction(
    createCoordinator,
    'Task comment reply createCoordinator',
  );
  const notifications = createFeishuNotificationAdapter({
    store: canonicalStore,
    sender: createSdkFeishuNotificationSender({ client: sdkClient }),
  });
  const conversation = coordinatorFactory({
    core: canonicalCore,
    async publishNotification(publication) {
      notifications.enqueue(publication);
    },
  });
  return createCoreFirstTaskCommentReply({
    appId,
    taskMapping: createCoreTaskV2CommentMapping({ core: canonicalCore }),
    commentQuery: canonicalCore.conversation,
    conversation,
    replyAdapter: createTaskCommentReplyAdapter({
      appId,
      store: canonicalStore,
      commentApi: createSdkTaskV2CommentApi({ client: sdkClient }),
    }),
    ...(clock === undefined ? {} : { clock }),
  });
}
