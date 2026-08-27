import { createHmac } from 'node:crypto';

const TOKEN_VERSION = 'wic1';
const AUDIENCE = 'c4-work-intake-confirmation';
const ACTIONS = new Set(['create_task', 'chat_only', 'edit']);
const MIN_SECRET_BYTES = 32;
const MAX_TTL_MS = 24 * 60 * 60_000;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

/**
 * Issue the channel-neutral capability consumed by C4 after Feishu's signed
 * callback context and operator identity have already been verified locally.
 */
export function createWorkIntakeConfirmationCapabilityIssuer({ secret, clock = Date.now } = {}) {
  const safeSecret = requireText(secret, 'secret', 4_096);
  if (Buffer.byteLength(safeSecret, 'utf8') < MIN_SECRET_BYTES) {
    throw new TypeError(`secret must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const key = Buffer.from(safeSecret, 'utf8');

  return Object.freeze({
    issue(input) {
      const request = requireRecord(input, 'capability issue request');
      const keys = Object.keys(request);
      const expected = ['sourceKey', 'action', 'actorId', 'expiresAt', 'nonce'];
      if (keys.length !== expected.length || keys.some((keyName) => !expected.includes(keyName))) {
        throw new TypeError('capability issue request contains unsupported or missing fields');
      }
      const now = clock();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw new TypeError('clock must return epoch milliseconds');
      }
      if (!Number.isSafeInteger(request.expiresAt)
        || request.expiresAt <= now
        || request.expiresAt - now > MAX_TTL_MS) {
        throw new TypeError('expiresAt must be within the next 24 hours');
      }
      const action = requireText(request.action, 'action', 32);
      if (!ACTIONS.has(action)) throw new TypeError('action is unsupported');
      const claims = {
        audience: AUDIENCE,
        sourceKey: requireText(request.sourceKey, 'sourceKey'),
        action,
        actorId: requireText(request.actorId, 'actorId', 256),
        issuedAt: now,
        expiresAt: request.expiresAt,
        nonce: requireText(request.nonce, 'nonce', 256),
      };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signed = `${TOKEN_VERSION}.${payload}`;
      const signature = createHmac('sha256', key).update(signed).digest('base64url');
      return `${signed}.${signature}`;
    },
  });
}
