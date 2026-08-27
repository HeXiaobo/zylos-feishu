import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

import { isLiveNativeTaskGateReader } from './native-task-closure-gate-remote.js';
import { feishuNotificationDedupeKey } from './task-notification-adapter.js';

const REPORT_SCHEMA = 'zylos.native-task-closure-gate/v2';
const LINK_BACKEND = 'feishu-task-v2';
const CORE_EVENT_OUTBOUND_PREFIX = 'task-comment-core-event:';
const HUMAN_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 4_096) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function requireLatency(value) {
  if (!Number.isInteger(value) || value < 0 || value > 86_400_000) {
    throw new TypeError('maxInboundLatencyMs must be between 0 and 86400000');
  }
  return value;
}

function canonicalInstant(value, field) {
  const parsed = new Date(requireText(value, field, 64));
  if (!Number.isFinite(parsed.valueOf())) throw new TypeError(`${field} must be an instant`);
  return parsed.toISOString();
}

function normalizeCases(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('native Task closure cases must be a non-empty array');
  }
  return value.map((rawCase, index) => {
    const item = requireRecord(rawCase, `native Task closure cases[${index}]`);
    const unknown = Object.keys(item).find(key => !['taskGuid', 'commentId'].includes(key));
    if (unknown) {
      throw new TypeError(`native Task closure cases[${index}] contains unsupported field: ${unknown}`);
    }
    return Object.freeze({
      taskGuid: requireText(item.taskGuid, `native Task closure cases[${index}].taskGuid`),
      commentId: requireText(item.commentId, `native Task closure cases[${index}].commentId`),
    });
  });
}

function logicalCommentId(appId, commentId) {
  const digest = createHash('sha256')
    .update(JSON.stringify([appId, commentId]))
    .digest('base64url');
  return `external-comment:${digest}`;
}

function parseNotificationDecision(row, { eventId, taskId, allowEmpty = false }) {
  if (!row) return null;
  const decision = requireRecord(JSON.parse(row.resultJson), 'Core notification decision');
  if (
    decision.eventId !== eventId
    || decision.taskId !== taskId
    || decision.kind !== 'action_required'
    || !Array.isArray(decision.deliveries)
  ) {
    throw new TypeError('Core notification decision does not match the canonical comment event');
  }
  const deliveries = decision.deliveries.map((rawDelivery, index) => {
    const delivery = requireRecord(rawDelivery, `Core notification decision.deliveries[${index}]`);
    return Object.freeze({
      dedupeKey: feishuNotificationDedupeKey(requireText(
        delivery.dedupeKey,
        `Core notification decision.deliveries[${index}].dedupeKey`,
      )),
      recipientId: requireText(
        delivery.recipientId,
        `Core notification decision.deliveries[${index}].recipientId`,
      ),
    });
  });
  if (!allowEmpty && deliveries.length === 0) {
    throw new TypeError('Core notification decision has no human recipients');
  }
  return Object.freeze({ eventId, taskId, deliveries: Object.freeze(deliveries) });
}

function soleHumanAudience(coreDb, link, inboundActorId) {
  const subscribers = coreDb.prepare(`
    SELECT subscriber_id AS subscriberId
    FROM commitment_task_subscriptions
    WHERE task_id = ?
    ORDER BY subscriber_id
  `).all(link.taskId);
  const humanAudience = [...new Set([
    link.ownerId,
    link.acceptorId,
    link.assigneeId,
    ...subscribers.map(({ subscriberId }) => subscriberId),
  ].filter(identity => HUMAN_OPEN_ID.test(identity ?? '')))];
  return {
    valid: HUMAN_OPEN_ID.test(inboundActorId)
      && link.ownerId === inboundActorId
      && link.acceptorId === inboundActorId
      && typeof link.assigneeId === 'string'
      && link.assigneeId.startsWith('agent:')
      && humanAudience.length === 1
      && humanAudience[0] === inboundActorId,
    humanAudience,
  };
}

function openReadonly(dbPath, field) {
  return new Database(requireText(dbPath, field, 4_096), {
    readonly: true,
    fileMustExist: true,
  });
}

function latencyBetween(receivedAt, occurredAt) {
  return new Date(receivedAt).valueOf() - new Date(occurredAt).valueOf();
}

function failedCase(item, code, message, details = {}) {
  return Object.freeze({
    taskGuid: item.taskGuid,
    commentId: item.commentId,
    coreTaskId: null,
    passed: false,
    failures: Object.freeze([Object.freeze({ code, message, details: Object.freeze(details) })]),
    inbound: null,
    outbound: null,
    notifications: null,
  });
}

async function evaluateCase({ coreDb, commentsDb, appId, item, remoteReader, maxInboundLatencyMs }) {
  const links = coreDb.prepare(`
    SELECT links.task_id AS taskId, tasks.title AS title,
           tasks.owner_id AS ownerId, tasks.acceptor_id AS acceptorId,
           tasks.assignee_id AS assigneeId
    FROM commitment_external_links AS links
    JOIN commitment_tasks AS tasks ON tasks.id = links.task_id
    WHERE links.backend = ? AND links.external_id = ?
  `).all(LINK_BACKEND, item.taskGuid);
  if (links.length === 0) {
    return failedCase(
      item,
      'CORE_LINK_MISSING',
      'Task GUID has no feishu-task-v2 ExternalLink',
      { backend: LINK_BACKEND, taskGuid: item.taskGuid },
    );
  }
  if (links.length > 1) {
    return failedCase(
      item,
      'CORE_LINK_NOT_UNIQUE',
      'Task GUID is owned by more than one feishu-task-v2 ExternalLink',
      { backend: LINK_BACKEND, taskGuid: item.taskGuid, matches: links.length },
    );
  }
  const link = links[0];
  const taskLinks = coreDb.prepare(`
    SELECT external_id AS taskGuid
    FROM commitment_external_links
    WHERE backend = ? AND task_id = ?
    ORDER BY external_id
  `).all(LINK_BACKEND, link.taskId);
  if (taskLinks.length !== 1 || taskLinks[0].taskGuid !== item.taskGuid) {
    return failedCase(
      item,
      'CORE_TASK_LINK_NOT_UNIQUE',
      'Core Task does not own exactly one feishu-task-v2 GUID',
      {
        coreTaskId: link.taskId,
        observedTaskGuids: taskLinks.map(({ taskGuid }) => taskGuid),
      },
    );
  }

  const inboundRows = commentsDb.prepare(`
    SELECT event_id AS eventId, task_guid AS taskGuid, comment_id AS commentId,
           occurred_at AS occurredAt, source, status, received_at AS receivedAt
    FROM feishu_task_comment_inbox
    WHERE app_id = ? AND comment_id = ?
    ORDER BY received_at DESC, event_id DESC
  `).all(appId, item.commentId);
  if (inboundRows.length === 0) {
    return failedCase(
      item,
      'INBOUND_COMMENT_MISSING',
      'Comment is absent from the durable inbound ledger',
      { appId, commentId: item.commentId },
    );
  }
  const observedTaskGuids = [...new Set(inboundRows.map(row => row.taskGuid))].sort();
  if (
    observedTaskGuids.length > 0
    && (observedTaskGuids.length !== 1 || observedTaskGuids[0] !== item.taskGuid)
  ) {
    return failedCase(
      item,
      'COMMENT_TASK_MISMATCH',
      'Comment ledger identity belongs to a different Task GUID',
      { expectedTaskGuid: item.taskGuid, observedTaskGuids },
    );
  }
  const realtimeRows = inboundRows.filter(row => (
    row.taskGuid === item.taskGuid && row.source === 'event'
  ));
  if (inboundRows.length > 0 && realtimeRows.length === 0) {
    return failedCase(
      item,
      'INBOUND_SOURCE_NOT_REALTIME',
      'Comment was observed only by reconciliation, not the realtime event path',
      { observedSource: inboundRows[0].source },
    );
  }
  const inbound = inboundRows.find(row => (
    row.taskGuid === item.taskGuid && row.source === 'event' && row.status === 'processed'
  ));
  if (!inbound) {
    return failedCase(
      item,
      'INBOUND_NOT_PROCESSED',
      'Realtime comment intake did not reach processed status',
      { observedStatus: realtimeRows[0]?.status ?? null },
    );
  }
  const latencyMs = latencyBetween(inbound.receivedAt, inbound.occurredAt);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    return failedCase(
      item,
      'INBOUND_LATENCY_INVALID',
      'Comment intake timestamps do not form a valid non-negative latency',
      { occurredAt: inbound.occurredAt, receivedAt: inbound.receivedAt },
    );
  }
  if (latencyMs > maxInboundLatencyMs) {
    return failedCase(
      item,
      'INBOUND_LATENCY_EXCEEDED',
      'Realtime comment intake exceeded the configured latency SLO',
      { latencyMs, maxInboundLatencyMs },
    );
  }

  const outboundRows = commentsDb.prepare(`
    SELECT idempotency_key AS idempotencyKey, reply_to_comment_id AS replyToCommentId,
           content, status, comment_id AS commentId
    FROM feishu_task_comment_outbound
    WHERE app_id = ? AND task_guid = ? AND reply_to_comment_id = ?
  `).all(appId, item.taskGuid, item.commentId);
  if (outboundRows.length === 0) {
    return failedCase(
      item,
      'OUTBOUND_REPLY_MISSING',
      'No Agent reply targets the exact inbound comment',
      { replyToCommentId: item.commentId },
    );
  }
  const sentOutboundRows = outboundRows.filter(row => row.status === 'sent');
  if (sentOutboundRows.length === 0) {
    return failedCase(
      item,
      'OUTBOUND_REPLY_NOT_SENT',
      'Exact Agent reply has no sent delivery receipt',
      { statuses: [...new Set(outboundRows.map(row => row.status))].sort() },
    );
  }
  if (sentOutboundRows.length > 1) {
    return failedCase(
      item,
      'OUTBOUND_REPLY_NOT_UNIQUE',
      'More than one sent Agent reply targets the same inbound comment',
      { sentReplies: sentOutboundRows.length },
    );
  }
  const outbound = sentOutboundRows[0];

  const coreCommentId = logicalCommentId(appId, item.commentId);
  const commentEvents = coreDb.prepare(`
    SELECT id AS eventId, actor_id AS actorId
    FROM commitment_conversation_events
    WHERE task_id = ? AND comment_id = ? AND event_type = 'CommentAdded'
    ORDER BY occurred_at, recorded_at, id
  `).all(link.taskId, coreCommentId);
  if (commentEvents.length === 0) {
    return failedCase(
      item,
      'CORE_COMMENT_EVENT_MISSING',
      'The exact inbound comment has no canonical Core CommentAdded event',
      { coreTaskId: link.taskId, coreCommentId },
    );
  }
  if (commentEvents.length > 1) {
    return failedCase(
      item,
      'CORE_COMMENT_EVENT_NOT_UNIQUE',
      'The exact inbound comment has more than one canonical Core CommentAdded event',
      { coreTaskId: link.taskId, coreCommentId, matches: commentEvents.length },
    );
  }
  let notificationEventId = commentEvents[0].eventId;
  const decisionRow = coreDb.prepare(`
    SELECT result_json AS resultJson
    FROM commitment_notification_decisions
    WHERE event_id = ? AND task_id = ?
  `).get(notificationEventId, link.taskId);
  if (!decisionRow) {
    return failedCase(
      item,
      'CORE_NOTIFICATION_DECISION_MISSING',
      'The canonical comment event has no persisted Core notification decision',
      { eventId: notificationEventId, coreTaskId: link.taskId },
    );
  }
  let notificationDecision;
  try {
    notificationDecision = parseNotificationDecision(decisionRow, {
      eventId: notificationEventId,
      taskId: link.taskId,
      allowEmpty: true,
    });
  } catch (error) {
    return failedCase(
      item,
      'CORE_NOTIFICATION_DECISION_INVALID',
      'The persisted Core notification decision is malformed, empty, or mismatched',
      { eventId: notificationEventId, error: String(error?.message ?? error).slice(0, 4_000) },
    );
  }
  let notificationOrigin = 'inbound-comment';
  if (notificationDecision.deliveries.length === 0) {
    const unexpectedInboundReceipts = commentsDb.prepare(`
      SELECT dedupe_key AS dedupeKey, recipient_id AS recipientId, status
      FROM feishu_task_notifications
      WHERE event_id = ? AND task_id = ?
      ORDER BY recipient_id, dedupe_key
    `).all(notificationEventId, link.taskId);
    if (unexpectedInboundReceipts.length > 0) {
      return failedCase(
        item,
        'INBOUND_NOTIFICATION_RECEIPT_UNEXPECTED',
        'An empty inbound notification decision cannot have Feishu delivery receipts',
        { eventId: notificationEventId, unexpectedDeliveries: unexpectedInboundReceipts },
      );
    }
    const audience = soleHumanAudience(coreDb, link, commentEvents[0].actorId);
    if (!audience.valid) {
      return failedCase(
        item,
        'SOLE_HUMAN_AUDIENCE_INVALID',
        'An empty inbound notification decision is valid only for the sole acting human',
        {
          inboundActorId: commentEvents[0].actorId,
          assigneeId: link.assigneeId,
          humanAudience: audience.humanAudience,
        },
      );
    }
    if (!outbound.idempotencyKey.startsWith(CORE_EVENT_OUTBOUND_PREFIX)) {
      return failedCase(
        item,
        'CORE_AGENT_REPLY_EVENT_ID_MISSING',
        'The exact outbound reply is not correlated to a canonical Core Agent event',
        { idempotencyKey: outbound.idempotencyKey },
      );
    }
    const agentReplyEventId = outbound.idempotencyKey.slice(CORE_EVENT_OUTBOUND_PREFIX.length);
    if (!agentReplyEventId) {
      return failedCase(
        item,
        'CORE_AGENT_REPLY_EVENT_ID_MISSING',
        'The exact outbound reply has an empty canonical Core Agent event identity',
        { idempotencyKey: outbound.idempotencyKey },
      );
    }
    const agentReplyEvent = coreDb.prepare(`
      SELECT id AS eventId, task_id AS taskId, actor_id AS actorId, body,
             reply_to_comment_id AS replyToCommentId
      FROM commitment_conversation_events
      WHERE id = ? AND event_type = 'CommentAdded'
    `).get(agentReplyEventId);
    if (
      !agentReplyEvent
      || agentReplyEvent.taskId !== link.taskId
      || agentReplyEvent.actorId !== link.assigneeId
      || agentReplyEvent.replyToCommentId !== coreCommentId
      || agentReplyEvent.body !== outbound.content
    ) {
      return failedCase(
        item,
        'CORE_AGENT_REPLY_EVENT_INVALID',
        'The exact outbound reply does not match one canonical Core Agent reply event',
        {
          expectedEventId: agentReplyEventId,
          expectedActorId: link.assigneeId,
          observedEvent: agentReplyEvent ? {
            eventId: agentReplyEvent.eventId,
            taskId: agentReplyEvent.taskId,
            actorId: agentReplyEvent.actorId,
            replyToCommentId: agentReplyEvent.replyToCommentId,
            bodyMatchesOutbound: agentReplyEvent.body === outbound.content,
          } : null,
        },
      );
    }
    const agentDecisionRow = coreDb.prepare(`
      SELECT result_json AS resultJson
      FROM commitment_notification_decisions
      WHERE event_id = ? AND task_id = ?
    `).get(agentReplyEventId, link.taskId);
    if (!agentDecisionRow) {
      return failedCase(
        item,
        'CORE_AGENT_REPLY_NOTIFICATION_DECISION_MISSING',
        'The canonical Agent reply has no persisted Core notification decision',
        { eventId: agentReplyEventId, coreTaskId: link.taskId },
      );
    }
    try {
      notificationDecision = parseNotificationDecision(agentDecisionRow, {
        eventId: agentReplyEventId,
        taskId: link.taskId,
      });
    } catch (error) {
      return failedCase(
        item,
        'CORE_AGENT_REPLY_NOTIFICATION_DECISION_INVALID',
        'The canonical Agent reply notification decision is malformed, empty, or mismatched',
        { eventId: agentReplyEventId, error: String(error?.message ?? error).slice(0, 4_000) },
      );
    }
    if (
      notificationDecision.deliveries.length !== 1
      || notificationDecision.deliveries[0].recipientId !== commentEvents[0].actorId
    ) {
      return failedCase(
        item,
        'CORE_AGENT_REPLY_NOTIFICATION_RECIPIENT_MISMATCH',
        'The canonical Agent reply must notify exactly the sole human commenter',
        {
          expectedRecipientId: commentEvents[0].actorId,
          observedRecipients: notificationDecision.deliveries.map(({ recipientId }) => recipientId),
        },
      );
    }
    notificationEventId = agentReplyEventId;
    notificationOrigin = 'agent-reply';
  }
  const notificationRows = commentsDb.prepare(`
    SELECT dedupe_key AS dedupeKey, recipient_id AS recipientId,
           status, sent_at AS sentAt
    FROM feishu_task_notifications
    WHERE event_id = ? AND task_id = ?
    ORDER BY recipient_id, dedupe_key
  `).all(notificationEventId, link.taskId);
  const expectedDeliveries = new Map(notificationDecision.deliveries.map(delivery => (
    [`${delivery.recipientId}\u0000${delivery.dedupeKey}`, delivery]
  )));
  const observedDeliveries = new Map(notificationRows.map(row => (
    [`${row.recipientId}\u0000${row.dedupeKey}`, row]
  )));
  const missingDeliveries = [...expectedDeliveries]
    .filter(([key]) => !observedDeliveries.has(key))
    .map(([, delivery]) => delivery);
  if (missingDeliveries.length > 0) {
    return failedCase(
      item,
      'NOTIFICATION_RECEIPT_MISSING',
      'Core-derived notification deliveries are missing from the Feishu ledger',
      { eventId: notificationEventId, missingDeliveries },
    );
  }
  const unexpectedDeliveries = [...observedDeliveries]
    .filter(([key]) => !expectedDeliveries.has(key))
    .map(([, row]) => ({ dedupeKey: row.dedupeKey, recipientId: row.recipientId }));
  if (unexpectedDeliveries.length > 0) {
    return failedCase(
      item,
      'NOTIFICATION_RECEIPT_UNEXPECTED',
      'The Feishu ledger contains recipients outside the immutable Core decision',
      { eventId: notificationEventId, unexpectedDeliveries },
    );
  }
  const unsentDeliveries = notificationRows
    .filter(row => row.status !== 'sent' || !row.sentAt)
    .map(row => ({ dedupeKey: row.dedupeKey, recipientId: row.recipientId, status: row.status }));
  if (unsentDeliveries.length > 0) {
    return failedCase(
      item,
      'NOTIFICATION_RECEIPT_NOT_SENT',
      'Core-derived notification deliveries do not all have sent receipts',
      { eventId: notificationEventId, unsentDeliveries },
    );
  }

  let remoteTask;
  try {
    remoteTask = await remoteReader.getTask({ taskGuid: item.taskGuid });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_TASK_READ_ERROR',
      'Feishu Task could not be read',
      { error: String(error?.message ?? error ?? 'unknown remote Task read error').slice(0, 4_000) },
    );
  }
  if (remoteTask?.kind === 'missing') {
    return failedCase(
      item,
      'REMOTE_TASK_MISSING',
      'Feishu Task is deleted or no longer exists',
      { taskGuid: item.taskGuid },
    );
  }
  if (remoteTask?.kind !== 'found') {
    return failedCase(
      item,
      'REMOTE_TASK_UNREADABLE',
      'Feishu Task Adapter reported a non-readable result',
      { kind: remoteTask?.kind ?? null },
    );
  }
  if (remoteTask.task?.guid !== item.taskGuid) {
    return failedCase(
      item,
      'REMOTE_TASK_GUID_MISMATCH',
      'Remote Task GUID differs from the requested managed Task',
      { expectedTaskGuid: item.taskGuid, observedTaskGuid: remoteTask.task?.guid ?? null },
    );
  }
  if (remoteTask.task?.coreTaskId !== link.taskId) {
    return failedCase(
      item,
      'REMOTE_TASK_CORE_MISMATCH',
      'Remote Task marker differs from the linked Core Task',
      {
        expectedCoreTaskId: link.taskId,
        observedCoreTaskId: remoteTask.task?.coreTaskId ?? null,
      },
    );
  }
  if (remoteTask.task?.summary !== link.title) {
    return failedCase(
      item,
      'REMOTE_TASK_TITLE_MISMATCH',
      'Remote Task title differs from the linked Core Task title',
      { expectedTitle: link.title, observedTitle: remoteTask.task?.summary ?? null },
    );
  }
  let candidates;
  try {
    candidates = await remoteReader.findTasksBySummary({ summary: link.title });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_TASK_SEARCH_ERROR',
      'Feishu Tasks could not be searched for title collisions',
      { error: String(error?.message ?? error ?? 'unknown remote Task search error').slice(0, 4_000) },
    );
  }
  if (
    !Array.isArray(candidates)
    || candidates.length !== 1
    || candidates[0]?.guid !== item.taskGuid
  ) {
    return failedCase(
      item,
      'REMOTE_TASK_TITLE_COLLISION',
      'Remote Task title does not uniquely identify the requested GUID',
      {
        title: link.title,
        observedTaskGuids: Array.isArray(candidates)
          ? candidates.map(candidate => candidate?.guid ?? null)
          : [],
      },
    );
  }
  let remoteInbound;
  try {
    remoteInbound = await remoteReader.getComment({
      taskGuid: item.taskGuid,
      commentId: item.commentId,
    });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_COMMENT_READ_ERROR',
      'Inbound Feishu comment could not be read',
      { error: String(error?.message ?? error ?? 'unknown remote comment read error').slice(0, 4_000) },
    );
  }
  if (remoteInbound?.kind === 'missing') {
    return failedCase(
      item,
      'REMOTE_COMMENT_MISSING',
      'Inbound Feishu comment is deleted or no longer exists',
      { commentId: item.commentId },
    );
  }
  if (
    remoteInbound?.kind !== 'found'
    || remoteInbound.comment?.resourceType !== 'task'
    || remoteInbound.comment?.resourceId !== item.taskGuid
  ) {
    return failedCase(
      item,
      'REMOTE_COMMENT_TASK_MISMATCH',
      'Inbound Feishu comment belongs to a different resource or Task GUID',
      {
        expectedTaskGuid: item.taskGuid,
        observedTaskGuid: remoteInbound?.comment?.resourceId ?? null,
        observedResourceType: remoteInbound?.comment?.resourceType ?? null,
      },
    );
  }
  let remoteOutbound;
  try {
    remoteOutbound = await remoteReader.getComment({
      taskGuid: item.taskGuid,
      commentId: outbound.commentId,
    });
  } catch (error) {
    return failedCase(
      item,
      'REMOTE_REPLY_READ_ERROR',
      'Agent Feishu reply could not be read',
      { error: String(error?.message ?? error ?? 'unknown remote reply read error').slice(0, 4_000) },
    );
  }
  if (remoteOutbound?.kind === 'missing') {
    return failedCase(
      item,
      'REMOTE_REPLY_MISSING',
      'Agent Feishu reply is deleted or no longer exists',
      { commentId: outbound.commentId },
    );
  }
  if (
    remoteOutbound?.kind !== 'found'
    || remoteOutbound.comment?.resourceType !== 'task'
    || remoteOutbound.comment?.resourceId !== item.taskGuid
  ) {
    return failedCase(
      item,
      'REMOTE_REPLY_TASK_MISMATCH',
      'Agent Feishu reply belongs to a different resource or Task GUID',
      {
        expectedTaskGuid: item.taskGuid,
        observedTaskGuid: remoteOutbound?.comment?.resourceId ?? null,
        observedResourceType: remoteOutbound?.comment?.resourceType ?? null,
      },
    );
  }
  if (
    remoteOutbound.comment?.creator?.type !== 'app'
    || remoteOutbound.comment?.creator?.id !== appId
  ) {
    return failedCase(
      item,
      'REMOTE_REPLY_CREATOR_MISMATCH',
      'Agent Feishu reply was not authored by the configured App identity',
      {
        expectedCreator: { id: appId, type: 'app' },
        observedCreator: remoteOutbound.comment?.creator ?? null,
      },
    );
  }
  if (remoteOutbound.comment?.replyToCommentId !== item.commentId) {
    return failedCase(
      item,
      'REMOTE_REPLY_PARENT_MISMATCH',
      'Agent Feishu reply does not target the exact inbound comment',
      {
        expectedReplyToCommentId: item.commentId,
        observedReplyToCommentId: remoteOutbound.comment?.replyToCommentId ?? null,
      },
    );
  }
  if (remoteOutbound.comment?.content !== outbound.content) {
    return failedCase(
      item,
      'REMOTE_REPLY_CONTENT_MISMATCH',
      'Agent Feishu reply content does not match the durable outbound receipt',
      { contentMatchesOutbound: false },
    );
  }

  return Object.freeze({
    taskGuid: item.taskGuid,
    commentId: item.commentId,
    coreTaskId: link.taskId,
    passed: true,
    failures: Object.freeze([]),
    inbound: Object.freeze({
      eventId: inbound.eventId,
      source: inbound.source,
      status: inbound.status,
      latencyMs,
      receivedAt: inbound.receivedAt,
    }),
    outbound: Object.freeze({
      idempotencyKey: outbound.idempotencyKey,
      replyToCommentId: outbound.replyToCommentId,
      status: outbound.status,
      commentId: outbound.commentId,
    }),
    notifications: Object.freeze({
      eventId: notificationEventId,
      origin: notificationOrigin,
      recipients: Object.freeze(notificationDecision.deliveries.map(({ recipientId }) => recipientId)),
      receipts: Object.freeze(notificationRows
        .filter(row => row.status === 'sent' && row.sentAt)
        .map(row => Object.freeze({
          dedupeKey: row.dedupeKey,
          recipientId: row.recipientId,
          status: row.status,
          sentAt: row.sentAt,
        }))
        .sort((left, right) => (
          left.recipientId.localeCompare(right.recipientId)
          || left.dedupeKey.localeCompare(right.dedupeKey)
        ))),
    }),
  });
}

/**
 * Read-only acceptance gate for one or more managed Feishu Task comment closures.
 * SQLite ledgers are opened read-only and all remote reads cross the injected Adapter seam.
 */
export async function evaluateNativeTaskClosure({
  coreDbPath,
  taskCommentsDbPath,
  appId,
  cases,
  remoteReader,
  clock = () => new Date().toISOString(),
  maxInboundLatencyMs = 5_000,
} = {}) {
  const normalizedAppId = requireText(appId, 'native Task closure appId');
  const normalizedCases = normalizeCases(cases);
  const remote = requireRecord(remoteReader, 'native Task closure remoteReader');
  const attestable = isLiveNativeTaskGateReader(remote);
  const evidenceMode = attestable ? 'live' : 'injected';
  for (const operation of ['getTask', 'findTasksBySummary', 'getComment']) {
    requireFunction(remote[operation], `native Task closure remoteReader.${operation}`);
  }
  const checkedAt = canonicalInstant(clock(), 'native Task closure clock result');
  const latencyLimit = requireLatency(maxInboundLatencyMs);
  const coreDb = openReadonly(coreDbPath, 'native Task closure coreDbPath');
  const commentsDb = openReadonly(
    taskCommentsDbPath,
    'native Task closure taskCommentsDbPath',
  );
  try {
    const caseReports = [];
    for (const item of normalizedCases) {
      try {
        caseReports.push(await evaluateCase({
          coreDb,
          commentsDb,
          appId: normalizedAppId,
          item,
          remoteReader: remote,
          maxInboundLatencyMs: latencyLimit,
        }));
      } catch (error) {
        caseReports.push(failedCase(
          item,
          'GATE_CASE_READ_ERROR',
          'Closure case could not be evaluated from its read-only dependencies',
          { error: String(error?.message ?? error ?? 'unknown gate case read error').slice(0, 4_000) },
        ));
      }
    }
    const validated = caseReports.filter(item => item.passed).length;
    const failureCodes = [...new Set(caseReports.flatMap(item => (
      item.failures.map(({ code }) => code)
    )))].sort();
    const attestationFailureCodes = attestable ? [] : ['NON_LIVE_EVIDENCE'];
    const reports = caseReports.map(report => Object.freeze({
      ...report,
      validationPassed: report.passed,
      passed: attestable && report.passed,
    }));
    return Object.freeze({
      schema: REPORT_SCHEMA,
      checkedAt,
      evidenceMode,
      attestable,
      validationPassed: validated === caseReports.length,
      passed: attestable && validated === caseReports.length,
      failureCodes: Object.freeze(failureCodes),
      attestationFailureCodes: Object.freeze(attestationFailureCodes),
      totals: Object.freeze({
        cases: caseReports.length,
        validated,
        validationFailed: caseReports.length - validated,
        passed: attestable ? validated : 0,
        failed: attestable ? caseReports.length - validated : caseReports.length,
      }),
      cases: Object.freeze(reports),
    });
  } finally {
    commentsDb.close();
    coreDb.close();
  }
}

export const NATIVE_TASK_CLOSURE_GATE_SCHEMA = REPORT_SCHEMA;
