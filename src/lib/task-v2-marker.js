import { types as utilTypes } from 'node:util';

import { parseCanonicalSha256 } from './canonical-sha256.js';

export const TASK_V2_MARKER_SCHEMA = 'zylos.task-v2-projection/v1';

const BASE_FIELDS = Object.freeze(['schema', 'coreTaskId', 'coreTaskVersion']);
const IDENTITY_FIELDS = Object.freeze(['tenantRef', 'accountRef', 'effectId', 'payloadHash']);
const ALLOWED_FIELDS = new Set([...BASE_FIELDS, ...IDENTITY_FIELDS]);
const FORBIDDEN_ID_CHARACTERS = /[\p{White_Space}\u0000-\u001f\u007f\u200b\u200c\u200d\u2060\ufeff]/u;

function invalid(field, detail) {
  const error = new TypeError(`${field} is not a canonical Task v2 marker: ${detail}`);
  error.code = 'EXTERNAL_IDENTITY_CONFLICT';
  error.retryable = false;
  return error;
}

export function snapshotCanonicalDataRecord(value, field = 'canonical data record') {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
      throw new TypeError('invalid record');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('invalid prototype');
    }
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError('symbol key');
      const descriptor = descriptors[key];
      if (!descriptor
          || !Object.hasOwn(descriptor, 'value')
          || descriptor.enumerable !== true
          || descriptor.configurable !== true
          || descriptor.writable !== true) {
        throw new TypeError('invalid property descriptor');
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    throw invalid(field, 'expected a canonical non-proxy plain data object');
  }
}

function requireCanonicalId(value, field) {
  if (typeof value !== 'string'
      || value.length === 0
      || FORBIDDEN_ID_CHARACTERS.test(value)) {
    throw invalid(field, 'expected a non-empty exact string without whitespace or format controls');
  }
  return value;
}

function requireCanonicalVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(field, 'expected a positive safe integer number');
  }
  return value;
}

export function parseCanonicalTaskV2Marker(value, field = 'Task v2 marker') {
  const marker = snapshotCanonicalDataRecord(value, field);
  const keys = Reflect.ownKeys(marker);
  const unknown = keys.find(key => !ALLOWED_FIELDS.has(key));
  if (unknown) throw invalid(field, `unsupported field: ${unknown}`);
  for (const required of BASE_FIELDS) {
    if (!Object.hasOwn(marker, required)) {
      throw invalid(field, `missing field: ${required}`);
    }
  }
  if (marker.schema !== TASK_V2_MARKER_SCHEMA) {
    throw invalid(field, 'schema is unsupported');
  }
  const coreTaskId = requireCanonicalId(marker.coreTaskId, `${field}.coreTaskId`);
  const coreTaskVersion = requireCanonicalVersion(
    marker.coreTaskVersion,
    `${field}.coreTaskVersion`,
  );
  const presentIdentityFields = IDENTITY_FIELDS.filter(key => Object.hasOwn(marker, key));
  if (presentIdentityFields.length === 0) {
    return Object.freeze({
      classification: 'legacy',
      schema: TASK_V2_MARKER_SCHEMA,
      coreTaskId,
      coreTaskVersion,
      tenantRef: null,
      accountRef: null,
      effectId: null,
      payloadHash: null,
    });
  }
  if (presentIdentityFields.length !== IDENTITY_FIELDS.length) {
    throw invalid(field, 'TaskEffect identity fields must be all present or all absent');
  }
  let payloadHash;
  try {
    payloadHash = parseCanonicalSha256(marker.payloadHash, `${field}.payloadHash`);
  } catch (cause) {
    throw invalid(field, cause.message);
  }
  return Object.freeze({
    classification: 'complete',
    schema: TASK_V2_MARKER_SCHEMA,
    coreTaskId,
    coreTaskVersion,
    tenantRef: requireCanonicalId(marker.tenantRef, `${field}.tenantRef`),
    accountRef: requireCanonicalId(marker.accountRef, `${field}.accountRef`),
    effectId: requireCanonicalId(marker.effectId, `${field}.effectId`),
    payloadHash,
  });
}

export function taskV2MarkerRecord(parsedInput) {
  const parsed = parseCanonicalTaskV2Marker(parsedInput);
  return Object.freeze({
    schema: parsed.schema,
    coreTaskId: parsed.coreTaskId,
    coreTaskVersion: parsed.coreTaskVersion,
    ...(parsed.classification === 'complete'
      ? {
        tenantRef: parsed.tenantRef,
        accountRef: parsed.accountRef,
        effectId: parsed.effectId,
        payloadHash: parsed.payloadHash,
      }
      : {}),
  });
}
