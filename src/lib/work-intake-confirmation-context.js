import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';
const CLAIM_FIELDS = new Set([
  'channel',
  'messageId',
  'intentRevision',
  'sourceKey',
  'senderId',
  'endpoint',
  'originalText',
  'taskDraft',
  'expiresAt',
]);
const TASK_FIELDS = new Set([
  'title',
  'description',
  'ownerId',
  'acceptorId',
  'assigneeId',
  'dueText',
  'riskLevel',
]);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 8_192;
const MIN_SECRET_BYTES = 32;

function invalidContext() {
  return new Error('WorkIntake confirmation context is invalid or expired');
}

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field, maxLength = 4_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function optionalText(value, field, maxLength) {
  if (value === null) return null;
  return requireText(value, field, maxLength);
}

function readNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('clock must return Unix epoch milliseconds');
  return now;
}

function normalizeClaims(input, now) {
  const claims = requireRecord(input, 'WorkIntake confirmation claims');
  requireExactFields(claims, CLAIM_FIELDS, 'WorkIntake confirmation claims');
  if (!Number.isSafeInteger(claims.intentRevision) || claims.intentRevision < 1) {
    throw new TypeError('intentRevision must be a positive integer');
  }
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now) {
    throw new TypeError('expiresAt must be a future Unix epoch millisecond');
  }
  const task = requireRecord(claims.taskDraft, 'WorkIntake TaskDraft');
  requireExactFields(task, TASK_FIELDS, 'WorkIntake TaskDraft');
  const channel = requireText(claims.channel, 'channel', 64);
  const messageId = requireText(claims.messageId, 'messageId', 256);
  const sourceKey = requireText(claims.sourceKey, 'sourceKey', 512);
  const senderId = requireText(claims.senderId, 'senderId', 256);
  if (sourceKey !== `${channel}:${messageId}:work-intake:r${claims.intentRevision}`) {
    throw new TypeError('sourceKey must be derived from message_id + intent_revision');
  }
  if (task.ownerId !== senderId || task.acceptorId !== senderId) {
    throw new TypeError('TaskDraft owner and acceptor must be the human sender');
  }
  if (
    task.assigneeId === 'agent:yueran'
    && !/(?:交给|让|请|麻烦|安排)\s*@?玥然|@?玥然\s*(?:来|负责|处理|完成|跟进|整理|帮)/u.test(claims.originalText)
  ) {
    throw new TypeError('agent:yueran requires an explicit assignment to 玥然');
  }
  return {
    channel,
    messageId,
    intentRevision: claims.intentRevision,
    sourceKey,
    senderId,
    endpoint: requireText(claims.endpoint, 'endpoint', 2_000),
    originalText: requireText(claims.originalText, 'originalText', 4_000),
    taskDraft: {
      title: requireText(task.title, 'TaskDraft.title', 256),
      description: optionalText(task.description, 'TaskDraft.description', 4_000),
      ownerId: requireText(task.ownerId, 'TaskDraft.ownerId', 256),
      acceptorId: requireText(task.acceptorId, 'TaskDraft.acceptorId', 256),
      assigneeId: optionalText(task.assigneeId, 'TaskDraft.assigneeId', 256),
      dueText: optionalText(task.dueText, 'TaskDraft.dueText', 100),
      riskLevel: requireText(task.riskLevel, 'TaskDraft.riskLevel', 32),
    },
    expiresAt: claims.expiresAt,
  };
}

function decode(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw invalidContext();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalidContext();
  return decoded;
}

export function createWorkIntakeConfirmationContextSigner(input) {
  const options = requireRecord(input, 'WorkIntake context signer options');
  const secret = requireText(options.secret, 'secret');
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new TypeError(`secret must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (typeof options.clock !== 'function') throw new TypeError('clock must be a function');
  const key = Buffer.from(secret, 'utf8');
  const sign = (value) => createHmac('sha256', key).update(value).digest();

  return Object.freeze({
    issue(input) {
      const claims = normalizeClaims(input, readNow(options.clock));
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const versioned = `${TOKEN_VERSION}.${payload}`;
      const token = `${versioned}.${sign(versioned).toString('base64url')}`;
      if (token.length > MAX_TOKEN_LENGTH) throw new TypeError('WorkIntake context is too long');
      return token;
    },
    verify(token) {
      try {
        if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) throw invalidContext();
        const [version, payload, signature, ...extra] = token.split('.');
        if (version !== TOKEN_VERSION || !payload || !signature || extra.length > 0) throw invalidContext();
        const versioned = `${version}.${payload}`;
        const actual = decode(signature);
        const expected = sign(versioned);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidContext();
        return normalizeClaims(JSON.parse(decode(payload).toString('utf8')), readNow(options.clock));
      } catch {
        throw invalidContext();
      }
    },
  });
}
