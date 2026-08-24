import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_VERSION = 'v1';
const CLAIM_KEYS = Object.freeze(['taskId', 'expectedVersion', 'expiresAt']);
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 4096;
const MIN_SECRET_BYTES = 32;

function invalidContext() {
  return new Error('task action context is invalid or expired');
}

function decodeBase64url(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw invalidContext();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw invalidContext();
  return decoded;
}

function parseToken(token) {
  if (
    typeof token !== 'string'
    || token.length === 0
    || token.length > MAX_TOKEN_LENGTH
  ) {
    throw invalidContext();
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw invalidContext();
  const [, payload, signature] = parts;
  return {
    payload,
    signature: decodeBase64url(signature),
  };
}

function normalizeClaims(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('task action context claims must be an object');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== CLAIM_KEYS.length
    || !CLAIM_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError('task action context claims contain unsupported fields');
  }
  if (typeof value.taskId !== 'string' || value.taskId.trim() === '') {
    throw new TypeError('taskId must be a non-empty string');
  }
  if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now) {
    throw new TypeError('expiresAt must be a future Unix epoch millisecond');
  }
  return {
    taskId: value.taskId,
    expectedVersion: value.expectedVersion,
    expiresAt: value.expiresAt,
  };
}

function readNow(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('clock must return Unix epoch milliseconds');
  }
  return now;
}

export function createTaskActionContextSigner(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('task action context signer options must be an object');
  }
  const { secret, clock } = options;
  if (
    typeof secret !== 'string'
    || secret.trim() === ''
    || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES
  ) {
    throw new TypeError(`secret must contain at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (typeof clock !== 'function') {
    throw new TypeError('clock must be a function');
  }
  const secretKey = Buffer.from(secret, 'utf8');

  function sign(versionedPayload) {
    return createHmac('sha256', secretKey).update(versionedPayload).digest();
  }

  return Object.freeze({
    issue(claims) {
      const normalizedClaims = normalizeClaims(claims, readNow(clock));
      const payload = Buffer.from(JSON.stringify(normalizedClaims)).toString('base64url');
      const versionedPayload = `${TOKEN_VERSION}.${payload}`;
      const token = `${versionedPayload}.${sign(versionedPayload).toString('base64url')}`;
      if (token.length > MAX_TOKEN_LENGTH) {
        throw new TypeError('task action context exceeds the token size limit');
      }
      return token;
    },

    verify(token) {
      try {
        const { payload, signature: actualSignature } = parseToken(token);
        const versionedPayload = `${TOKEN_VERSION}.${payload}`;
        const expectedSignature = sign(versionedPayload);
        if (
          actualSignature.length !== expectedSignature.length
          || !timingSafeEqual(actualSignature, expectedSignature)
        ) {
          throw invalidContext();
        }
        const claims = JSON.parse(decodeBase64url(payload).toString('utf8'));
        return normalizeClaims(claims, readNow(clock));
      } catch {
        throw invalidContext();
      }
    },
  });
}
