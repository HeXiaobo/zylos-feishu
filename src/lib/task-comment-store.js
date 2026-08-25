import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const MAX_ID_LENGTH = 512;
const MAX_ERROR_LENGTH = 4_000;
const MAX_NOTIFICATION_SUMMARY = 4_000;

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

function optionalText(value, field, maxLength = MAX_ID_LENGTH) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, maxLength);
}

function requireInstant(value, field) {
  const text = requireText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw new TypeError(`${field} must be a canonical ISO-8601 instant`);
  }
  return text;
}

function currentInstant(clock) {
  return requireInstant(clock(), 'clock result');
}

function addMilliseconds(instant, milliseconds) {
  return new Date(new Date(instant).valueOf() + milliseconds).toISOString();
}

function requireBoundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeInboxEvent(rawEvent) {
  const event = requireRecord(rawEvent, 'task comment inbox event');
  return {
    appId: requireText(event.appId, 'task comment inbox event.appId'),
    eventId: requireText(event.eventId, 'task comment inbox event.eventId'),
    businessKey: requireText(event.businessKey, 'task comment inbox event.businessKey'),
    taskGuid: requireText(event.taskGuid, 'task comment inbox event.taskGuid'),
    commentId: requireText(event.commentId, 'task comment inbox event.commentId'),
    parentCommentId: optionalText(
      event.parentCommentId,
      'task comment inbox event.parentCommentId',
    ),
    objType: event.objType === null || event.objType === undefined
      ? null
      : requireBoundedInteger(event.objType, 'task comment inbox event.objType', 0, 1_000_000),
    occurredAt: requireInstant(event.occurredAt, 'task comment inbox event.occurredAt'),
    source: requireText(event.source, 'task comment inbox event.source', 32),
  };
}

function toInboxView(row) {
  if (!row) return null;
  return {
    appId: row.app_id,
    eventId: row.event_id,
    businessKey: row.business_key,
    taskGuid: row.task_guid,
    commentId: row.comment_id,
    parentCommentId: row.parent_comment_id,
    objType: row.obj_type,
    occurredAt: row.occurred_at,
    source: row.source,
    status: row.status,
    attempt: row.attempt,
    version: row.version,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    duplicateOfEventId: row.duplicate_of_event_id,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function toOutboundView(row) {
  if (!row) return null;
  return {
    appId: row.app_id,
    idempotencyKey: row.idempotency_key,
    taskGuid: row.task_guid,
    replyToCommentId: row.reply_to_comment_id,
    content: row.content,
    status: row.status,
    commentId: row.comment_id,
    attempt: row.attempt,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNotificationView(row) {
  if (!row) return null;
  return {
    dedupeKey: row.dedupe_key,
    eventId: row.event_id,
    taskId: row.task_id,
    recipientId: row.recipient_id,
    reason: row.reason,
    urgency: row.urgency,
    deliveryMode: row.delivery_mode,
    coalesceWindowMs: row.coalesce_window_ms,
    summary: row.summary,
    status: row.status,
    attempt: row.attempt,
    version: row.version,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS feishu_task_comment_inbox (
      app_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      business_key TEXT NOT NULL,
      task_guid TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      parent_comment_id TEXT,
      obj_type INTEGER,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'retry_wait', 'processed', 'suppressed', 'dead_letter')
      ),
      attempt INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT,
      duplicate_of_event_id TEXT,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_comment_inbox_claim
      ON feishu_task_comment_inbox(status, available_at, occurred_at, app_id, event_id);

    CREATE TABLE IF NOT EXISTS feishu_task_comment_business_keys (
      app_id TEXT NOT NULL,
      business_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (app_id, business_key),
      FOREIGN KEY (app_id, event_id)
        REFERENCES feishu_task_comment_inbox(app_id, event_id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS feishu_task_comment_outbound (
      app_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      task_guid TEXT NOT NULL,
      reply_to_comment_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'dead_letter')),
      comment_id TEXT,
      attempt INTEGER NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, idempotency_key),
      UNIQUE (app_id, comment_id)
    );

    CREATE TABLE IF NOT EXISTS feishu_task_comment_observed (
      app_id TEXT NOT NULL,
      task_guid TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (app_id, task_guid, comment_id)
    );

    CREATE TABLE IF NOT EXISTS feishu_task_comment_reconciliation (
      app_id TEXT NOT NULL,
      task_guid TEXT NOT NULL,
      last_success_at TEXT NOT NULL,
      PRIMARY KEY (app_id, task_guid)
    );

    CREATE TABLE IF NOT EXISTS feishu_task_notifications (
      dedupe_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      event_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      urgency TEXT NOT NULL,
      delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('immediate', 'coalesce')),
      coalesce_window_ms INTEGER NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'retry_wait', 'sent', 'dead_letter')
      ),
      attempt INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_task_notifications_claim
      ON feishu_task_notifications(status, available_at, recipient_id, created_at);
  `);
}

export function openTaskCommentStore({ dbPath, clock = () => new Date().toISOString() }) {
  const databasePath = requireText(dbPath, 'task comment store dbPath', 4_096);
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('busy_timeout = 5000');
  if (databasePath !== ':memory:') database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  initializeSchema(database);

  const selectInbox = database.prepare(`
    SELECT * FROM feishu_task_comment_inbox WHERE app_id = ? AND event_id = ?
  `);
  const selectBusinessKey = database.prepare(`
    SELECT event_id FROM feishu_task_comment_business_keys
    WHERE app_id = ? AND business_key = ?
  `);
  const insertInbox = database.prepare(`
    INSERT INTO feishu_task_comment_inbox (
      app_id, event_id, request_fingerprint, business_key, task_guid, comment_id,
      parent_comment_id, obj_type, occurred_at, source, status, available_at,
      duplicate_of_event_id, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBusinessKey = database.prepare(`
    INSERT INTO feishu_task_comment_business_keys (
      app_id, business_key, event_id, created_at
    ) VALUES (?, ?, ?, ?)
  `);
  const enqueueTransaction = database.transaction((rawEvent) => {
    const event = normalizeInboxEvent(rawEvent);
    const requestFingerprint = fingerprint(event);
    const existing = selectInbox.get(event.appId, event.eventId);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw domainError(
          'IDEMPOTENCY_CONFLICT',
          `event ID belongs to different content: ${event.appId}/${event.eventId}`,
        );
      }
      return { accepted: false, duplicate: 'event', entry: toInboxView(existing) };
    }
    const now = currentInstant(clock);
    const businessReceipt = selectBusinessKey.get(event.appId, event.businessKey);
    const status = businessReceipt ? 'suppressed' : 'pending';
    insertInbox.run(
      event.appId,
      event.eventId,
      requestFingerprint,
      event.businessKey,
      event.taskGuid,
      event.commentId,
      event.parentCommentId,
      event.objType,
      event.occurredAt,
      event.source,
      status,
      now,
      businessReceipt?.event_id ?? null,
      now,
      now,
    );
    if (!businessReceipt) {
      insertBusinessKey.run(event.appId, event.businessKey, event.eventId, now);
    }
    return {
      accepted: !businessReceipt,
      duplicate: businessReceipt ? 'business' : null,
      entry: toInboxView(selectInbox.get(event.appId, event.eventId)),
    };
  });

  const claimInboxTransaction = database.transaction(({ appId, workerId, leaseMs, limit }) => {
    const now = currentInstant(clock);
    const leaseUntil = addMilliseconds(now, leaseMs);
    const candidates = database.prepare(`
      SELECT app_id, event_id
      FROM feishu_task_comment_inbox
      WHERE app_id = ? AND (
        (status IN ('pending', 'retry_wait') AND available_at <= ?)
        OR (status = 'leased' AND lease_until <= ?)
      )
      ORDER BY occurred_at, app_id, event_id
      LIMIT ?
    `).all(appId, now, now, limit);
    const update = database.prepare(`
      UPDATE feishu_task_comment_inbox
      SET status = 'leased', attempt = attempt + 1, version = version + 1,
          lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE app_id = ? AND event_id = ?
        AND (
          (status IN ('pending', 'retry_wait') AND available_at <= ?)
          OR (status = 'leased' AND lease_until <= ?)
        )
    `);
    const claimed = [];
    for (const candidate of candidates) {
      const result = update.run(
        workerId,
        leaseUntil,
        now,
        candidate.app_id,
        candidate.event_id,
        now,
        now,
      );
      if (result.changes === 1) {
        claimed.push(toInboxView(selectInbox.get(candidate.app_id, candidate.event_id)));
      }
    }
    return claimed;
  });

  function settleInbox({ appId, eventId, workerId, expectedVersion, mode, error, retryAfterMs, maxAttempts }) {
    const normalizedAppId = requireText(appId, 'inbox settlement.appId');
    const normalizedEventId = requireText(eventId, 'inbox settlement.eventId');
    const normalizedWorkerId = requireText(workerId, 'inbox settlement.workerId');
    requireBoundedInteger(expectedVersion, 'inbox settlement.expectedVersion', 1, 2_147_483_647);
    const now = currentInstant(clock);
    const current = selectInbox.get(normalizedAppId, normalizedEventId);
    if (!current) throw domainError('INBOX_EVENT_NOT_FOUND', 'inbox event was not found');
    if (current.status !== 'leased') throw domainError('INBOX_EVENT_NOT_LEASED', 'event is not leased');
    if (current.lease_owner !== normalizedWorkerId) {
      throw domainError('INBOX_EVENT_FORBIDDEN', 'event lease belongs to another worker');
    }
    if (current.version !== expectedVersion) {
      throw domainError('INBOX_VERSION_CONFLICT', 'event version changed');
    }
    if (current.lease_until <= now) throw domainError('INBOX_LEASE_EXPIRED', 'event lease expired');
    let status = 'processed';
    let availableAt = now;
    let lastError = null;
    if (mode === 'fail') {
      requireBoundedInteger(maxAttempts, 'inbox failure.maxAttempts', 1, 100);
      const normalizedError = requireText(error, 'inbox failure.error', MAX_ERROR_LENGTH);
      lastError = normalizedError;
      if (current.attempt >= maxAttempts || retryAfterMs === null) {
        status = 'dead_letter';
      } else {
        requireBoundedInteger(retryAfterMs, 'inbox failure.retryAfterMs', 0, 86_400_000);
        status = 'retry_wait';
        availableAt = addMilliseconds(now, retryAfterMs);
      }
    }
    const result = database.prepare(`
      UPDATE feishu_task_comment_inbox
      SET status = ?, version = version + 1, available_at = ?,
          lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ?
      WHERE app_id = ? AND event_id = ? AND status = 'leased'
        AND lease_owner = ? AND version = ?
    `).run(
      status,
      availableAt,
      lastError,
      now,
      normalizedAppId,
      normalizedEventId,
      normalizedWorkerId,
      expectedVersion,
    );
    if (result.changes !== 1) throw domainError('INBOX_VERSION_CONFLICT', 'event changed');
    return toInboxView(selectInbox.get(normalizedAppId, normalizedEventId));
  }

  const selectOutbound = database.prepare(`
    SELECT * FROM feishu_task_comment_outbound
    WHERE app_id = ? AND idempotency_key = ?
  `);
  const beginOutboundTransaction = database.transaction((rawRequest) => {
    const request = requireRecord(rawRequest, 'outbound comment request');
    const normalized = {
      appId: requireText(request.appId, 'outbound comment request.appId'),
      idempotencyKey: requireText(
        request.idempotencyKey,
        'outbound comment request.idempotencyKey',
      ),
      taskGuid: requireText(request.taskGuid, 'outbound comment request.taskGuid'),
      replyToCommentId: optionalText(
        request.replyToCommentId,
        'outbound comment request.replyToCommentId',
      ),
      content: requireText(request.content, 'outbound comment request.content', 20_000),
    };
    const requestFingerprint = fingerprint(normalized);
    const existing = selectOutbound.get(normalized.appId, normalized.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'outbound comment key belongs to different content');
      }
      return { created: false, delivery: toOutboundView(existing) };
    }
    const now = currentInstant(clock);
    database.prepare(`
      INSERT INTO feishu_task_comment_outbound (
        app_id, idempotency_key, request_fingerprint, task_guid,
        reply_to_comment_id, content, status, attempt, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
    `).run(
      normalized.appId,
      normalized.idempotencyKey,
      requestFingerprint,
      normalized.taskGuid,
      normalized.replyToCommentId,
      normalized.content,
      now,
      now,
    );
    return {
      created: true,
      delivery: toOutboundView(selectOutbound.get(normalized.appId, normalized.idempotencyKey)),
    };
  });

  function finishOutbound({ appId, idempotencyKey, commentId }) {
    const normalizedAppId = requireText(appId, 'outbound completion.appId');
    const normalizedKey = requireText(idempotencyKey, 'outbound completion.idempotencyKey');
    const normalizedCommentId = requireText(commentId, 'outbound completion.commentId');
    const existing = selectOutbound.get(normalizedAppId, normalizedKey);
    if (!existing) throw domainError('OUTBOUND_NOT_FOUND', 'outbound comment was not found');
    if (existing.status === 'sent') {
      if (existing.comment_id !== normalizedCommentId) {
        throw domainError('OUTBOUND_COMMENT_CONFLICT', 'outbound comment ID changed');
      }
      return toOutboundView(existing);
    }
    if (existing.status !== 'pending') {
      throw domainError('OUTBOUND_NOT_PENDING', 'outbound comment is not pending');
    }
    const now = currentInstant(clock);
    database.prepare(`
      UPDATE feishu_task_comment_outbound
      SET status = 'sent', comment_id = ?, last_error = NULL, updated_at = ?
      WHERE app_id = ? AND idempotency_key = ? AND status = 'pending'
    `).run(normalizedCommentId, now, normalizedAppId, normalizedKey);
    return toOutboundView(selectOutbound.get(normalizedAppId, normalizedKey));
  }

  function failOutbound({ appId, idempotencyKey, error }) {
    const normalizedAppId = requireText(appId, 'outbound failure.appId');
    const normalizedKey = requireText(idempotencyKey, 'outbound failure.idempotencyKey');
    const normalizedError = requireText(error, 'outbound failure.error', MAX_ERROR_LENGTH);
    const existing = selectOutbound.get(normalizedAppId, normalizedKey);
    if (!existing) throw domainError('OUTBOUND_NOT_FOUND', 'outbound comment was not found');
    if (existing.status !== 'pending') return toOutboundView(existing);
    const now = currentInstant(clock);
    database.prepare(`
      UPDATE feishu_task_comment_outbound
      SET status = 'dead_letter', last_error = ?, updated_at = ?
      WHERE app_id = ? AND idempotency_key = ? AND status = 'pending'
    `).run(normalizedError, now, normalizedAppId, normalizedKey);
    return toOutboundView(selectOutbound.get(normalizedAppId, normalizedKey));
  }

  function recordObserved({ appId, taskGuid, commentId, updatedAt }) {
    const normalized = {
      appId: requireText(appId, 'observed comment.appId'),
      taskGuid: requireText(taskGuid, 'observed comment.taskGuid'),
      commentId: requireText(commentId, 'observed comment.commentId'),
      updatedAt: requireInstant(updatedAt, 'observed comment.updatedAt'),
    };
    const now = currentInstant(clock);
    database.prepare(`
      INSERT INTO feishu_task_comment_observed (
        app_id, task_guid, comment_id, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(app_id, task_guid, comment_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
    `).run(
      normalized.appId,
      normalized.taskGuid,
      normalized.commentId,
      normalized.updatedAt,
      now,
    );
  }

  function normalizeNotification(rawNotification) {
    const notification = requireRecord(rawNotification, 'Feishu notification');
    const deliveryMode = requireText(notification.deliveryMode, 'notification.deliveryMode', 32);
    if (deliveryMode !== 'immediate' && deliveryMode !== 'coalesce') {
      throw new TypeError('notification.deliveryMode is unsupported');
    }
    const coalesceWindowMs = requireBoundedInteger(
      notification.coalesceWindowMs,
      'notification.coalesceWindowMs',
      0,
      60_000,
    );
    if (deliveryMode === 'immediate' && coalesceWindowMs !== 0) {
      throw new TypeError('immediate notifications cannot have a coalesce window');
    }
    if (deliveryMode === 'coalesce' && coalesceWindowMs < 30_000) {
      throw new TypeError('coalesced notifications require a 30-60 second window');
    }
    return {
      dedupeKey: requireText(notification.dedupeKey, 'notification.dedupeKey'),
      eventId: requireText(notification.eventId, 'notification.eventId'),
      taskId: requireText(notification.taskId, 'notification.taskId'),
      recipientId: requireText(notification.recipientId, 'notification.recipientId'),
      reason: requireText(notification.reason, 'notification.reason', 64),
      urgency: requireText(notification.urgency, 'notification.urgency', 32),
      deliveryMode,
      coalesceWindowMs,
      summary: requireText(notification.summary, 'notification.summary', MAX_NOTIFICATION_SUMMARY),
    };
  }

  function enqueueNotification(rawNotification) {
    const notification = normalizeNotification(rawNotification);
    const requestFingerprint = fingerprint(notification);
    const existing = database.prepare(`
      SELECT * FROM feishu_task_notifications WHERE dedupe_key = ?
    `).get(notification.dedupeKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw domainError('IDEMPOTENCY_CONFLICT', 'notification key belongs to different content');
      }
      return { created: false, delivery: toNotificationView(existing) };
    }
    const now = currentInstant(clock);
    const availableAt = addMilliseconds(now, notification.coalesceWindowMs);
    database.prepare(`
      INSERT INTO feishu_task_notifications (
        dedupe_key, request_fingerprint, event_id, task_id, recipient_id,
        reason, urgency, delivery_mode, coalesce_window_ms, summary,
        status, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      notification.dedupeKey,
      requestFingerprint,
      notification.eventId,
      notification.taskId,
      notification.recipientId,
      notification.reason,
      notification.urgency,
      notification.deliveryMode,
      notification.coalesceWindowMs,
      notification.summary,
      availableAt,
      now,
      now,
    );
    return {
      created: true,
      delivery: toNotificationView(database.prepare(`
        SELECT * FROM feishu_task_notifications WHERE dedupe_key = ?
      `).get(notification.dedupeKey)),
    };
  }

  const claimNotificationTransaction = database.transaction(({ workerId, leaseMs, limit }) => {
    const now = currentInstant(clock);
    const leaseUntil = addMilliseconds(now, leaseMs);
    const candidates = database.prepare(`
      SELECT dedupe_key
      FROM feishu_task_notifications
      WHERE (
        (status IN ('pending', 'retry_wait') AND available_at <= ?)
        OR (status = 'leased' AND lease_until <= ?)
      )
      ORDER BY recipient_id, created_at, dedupe_key
      LIMIT ?
    `).all(now, now, limit);
    const claimed = [];
    const update = database.prepare(`
      UPDATE feishu_task_notifications
      SET status = 'leased', attempt = attempt + 1, version = version + 1,
          lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE dedupe_key = ?
        AND (
          (status IN ('pending', 'retry_wait') AND available_at <= ?)
          OR (status = 'leased' AND lease_until <= ?)
        )
    `);
    const select = database.prepare(`SELECT * FROM feishu_task_notifications WHERE dedupe_key = ?`);
    for (const candidate of candidates) {
      if (update.run(workerId, leaseUntil, now, candidate.dedupe_key, now, now).changes === 1) {
        claimed.push(toNotificationView(select.get(candidate.dedupe_key)));
      }
    }
    return claimed;
  });

  function settleNotification({ dedupeKey, workerId, expectedVersion, mode, error, retryAfterMs, maxAttempts }) {
    const key = requireText(dedupeKey, 'notification settlement.dedupeKey');
    const owner = requireText(workerId, 'notification settlement.workerId');
    requireBoundedInteger(expectedVersion, 'notification settlement.expectedVersion', 1, 2_147_483_647);
    const select = database.prepare(`SELECT * FROM feishu_task_notifications WHERE dedupe_key = ?`);
    const current = select.get(key);
    const now = currentInstant(clock);
    if (!current) throw domainError('NOTIFICATION_NOT_FOUND', 'notification was not found');
    if (current.status !== 'leased' || current.lease_owner !== owner) {
      throw domainError('NOTIFICATION_NOT_LEASED', 'notification lease is not owned');
    }
    if (current.version !== expectedVersion) {
      throw domainError('NOTIFICATION_VERSION_CONFLICT', 'notification version changed');
    }
    if (current.lease_until <= now) {
      throw domainError('NOTIFICATION_LEASE_EXPIRED', 'notification lease expired');
    }
    let status = 'sent';
    let availableAt = now;
    let lastError = null;
    let sentAt = now;
    if (mode === 'fail') {
      lastError = requireText(error, 'notification failure.error', MAX_ERROR_LENGTH);
      requireBoundedInteger(maxAttempts, 'notification failure.maxAttempts', 1, 100);
      sentAt = null;
      if (current.attempt >= maxAttempts || retryAfterMs === null) {
        status = 'dead_letter';
      } else {
        requireBoundedInteger(retryAfterMs, 'notification failure.retryAfterMs', 0, 86_400_000);
        status = 'retry_wait';
        availableAt = addMilliseconds(now, retryAfterMs);
      }
    }
    const updated = database.prepare(`
      UPDATE feishu_task_notifications
      SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
          last_error = ?, sent_at = ?, version = version + 1, updated_at = ?
      WHERE dedupe_key = ? AND status = 'leased' AND lease_owner = ? AND version = ?
    `).run(status, availableAt, lastError, sentAt, now, key, owner, expectedVersion);
    if (updated.changes !== 1) {
      throw domainError('NOTIFICATION_VERSION_CONFLICT', 'notification changed');
    }
    return toNotificationView(select.get(key));
  }

  return Object.freeze({
    enqueue(event) {
      return enqueueTransaction.immediate(event);
    },
    claim({ appId, workerId, leaseMs = 30_000, limit = 25 }) {
      return claimInboxTransaction.immediate({
        appId: requireText(appId, 'inbox claim.appId'),
        workerId: requireText(workerId, 'inbox claim.workerId'),
        leaseMs: requireBoundedInteger(leaseMs, 'inbox claim.leaseMs', 1, 86_400_000),
        limit: requireBoundedInteger(limit, 'inbox claim.limit', 1, 100),
      });
    },
    acknowledge(request) {
      return settleInbox({ ...requireRecord(request, 'inbox acknowledgement'), mode: 'ack' });
    },
    fail(request) {
      return settleInbox({ ...requireRecord(request, 'inbox failure'), mode: 'fail' });
    },
    queryInbox({ appId, eventId }) {
      return toInboxView(selectInbox.get(
        requireText(appId, 'inbox query.appId'),
        requireText(eventId, 'inbox query.eventId'),
      ));
    },
    beginOutbound(request) {
      return beginOutboundTransaction.immediate(request);
    },
    finishOutbound,
    failOutbound,
    queryOutbound({ appId, idempotencyKey }) {
      return toOutboundView(selectOutbound.get(
        requireText(appId, 'outbound query.appId'),
        requireText(idempotencyKey, 'outbound query.idempotencyKey'),
      ));
    },
    isOutboundComment({ appId, commentId }) {
      return Boolean(database.prepare(`
        SELECT 1 FROM feishu_task_comment_outbound
        WHERE app_id = ? AND comment_id = ? AND status = 'sent'
      `).get(
        requireText(appId, 'outbound comment lookup.appId'),
        requireText(commentId, 'outbound comment lookup.commentId'),
      ));
    },
    recordObserved,
    listObserved({ appId, taskGuid }) {
      return database.prepare(`
        SELECT comment_id AS commentId, updated_at AS updatedAt, last_seen_at AS lastSeenAt
        FROM feishu_task_comment_observed
        WHERE app_id = ? AND task_guid = ?
        ORDER BY comment_id
      `).all(
        requireText(appId, 'observed query.appId'),
        requireText(taskGuid, 'observed query.taskGuid'),
      );
    },
    getLastReconciledAt({ appId, taskGuid }) {
      return database.prepare(`
        SELECT last_success_at FROM feishu_task_comment_reconciliation
        WHERE app_id = ? AND task_guid = ?
      `).get(
        requireText(appId, 'reconciliation query.appId'),
        requireText(taskGuid, 'reconciliation query.taskGuid'),
      )?.last_success_at ?? null;
    },
    markReconciled({ appId, taskGuid }) {
      const normalizedAppId = requireText(appId, 'reconciliation result.appId');
      const normalizedTaskGuid = requireText(taskGuid, 'reconciliation result.taskGuid');
      const now = currentInstant(clock);
      database.prepare(`
        INSERT INTO feishu_task_comment_reconciliation (app_id, task_guid, last_success_at)
        VALUES (?, ?, ?)
        ON CONFLICT(app_id, task_guid) DO UPDATE SET last_success_at = excluded.last_success_at
      `).run(normalizedAppId, normalizedTaskGuid, now);
      return now;
    },
    notifications: Object.freeze({
      enqueue: enqueueNotification,
      claim({ workerId, leaseMs = 30_000, limit = 50 }) {
        return claimNotificationTransaction.immediate({
          workerId: requireText(workerId, 'notification claim.workerId'),
          leaseMs: requireBoundedInteger(
            leaseMs,
            'notification claim.leaseMs',
            1,
            86_400_000,
          ),
          limit: requireBoundedInteger(limit, 'notification claim.limit', 1, 100),
        });
      },
      acknowledge(request) {
        return settleNotification({
          ...requireRecord(request, 'notification acknowledgement'),
          mode: 'ack',
        });
      },
      acknowledgeBatch(requests) {
        if (!Array.isArray(requests) || requests.length === 0) {
          throw new TypeError('notification acknowledgement batch must be non-empty');
        }
        return database.transaction(() => requests.map((request) => settleNotification({
          ...requireRecord(request, 'notification acknowledgement'),
          mode: 'ack',
        }))).immediate();
      },
      fail(request) {
        return settleNotification({
          ...requireRecord(request, 'notification failure'),
          mode: 'fail',
        });
      },
      query({ dedupeKey }) {
        return toNotificationView(database.prepare(`
          SELECT * FROM feishu_task_notifications WHERE dedupe_key = ?
        `).get(requireText(dedupeKey, 'notification query.dedupeKey')));
      },
      lastSentAt({ recipientId }) {
        return database.prepare(`
          SELECT MAX(sent_at) AS sent_at
          FROM feishu_task_notifications
          WHERE recipient_id = ? AND status = 'sent'
        `).get(requireText(recipientId, 'notification query.recipientId')).sent_at ?? null;
      },
    }),
    close() {
      database.close();
    },
  });
}
