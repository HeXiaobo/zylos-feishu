import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCanonicalTaskV2Marker,
  TASK_V2_MARKER_SCHEMA,
  taskV2MarkerRecord,
} from '../src/lib/task-v2-marker.js';

function completeMarker() {
  return {
    schema: TASK_V2_MARKER_SCHEMA,
    coreTaskId: 'task-1',
    coreTaskVersion: 3,
    tenantRef: 'tenant-1',
    accountRef: 'acct-1',
    effectId: 'effect-task-1-v3',
    payloadHash: `sha256:${'a'.repeat(64)}`,
  };
}

test('canonical Task v2 marker parser admits only exact legacy or complete states', () => {
  const legacy = {
    schema: TASK_V2_MARKER_SCHEMA,
    coreTaskId: 'task-1',
    coreTaskVersion: 3,
  };
  assert.equal(parseCanonicalTaskV2Marker(legacy).classification, 'legacy');
  assert.deepEqual(taskV2MarkerRecord(legacy), legacy);
  assert.equal(parseCanonicalTaskV2Marker(completeMarker()).classification, 'complete');
  assert.deepEqual(taskV2MarkerRecord(completeMarker()), completeMarker());

  const invalid = [];
  for (const field of ['schema', 'coreTaskId', 'coreTaskVersion']) {
    const missing = { ...completeMarker() };
    delete missing[field];
    invalid.push([`${field}=missing`, missing]);
    invalid.push([`${field}=undefined`, { ...completeMarker(), [field]: undefined }]);
    invalid.push([`${field}=null`, { ...completeMarker(), [field]: null }]);
  }
  invalid.push(
    ['schema=different', { ...completeMarker(), schema: 'zylos.task-v2-projection/v2' }],
    ['unknown field', { ...completeMarker(), extraField: true }],
    ['non-plain marker', Object.create({ inherited: true }, Object.getOwnPropertyDescriptors(completeMarker()))],
    ['proxy marker', new Proxy(completeMarker(), {})],
  );
  for (const [name, value] of [
    ['empty', ''],
    ['ASCII whitespace', ' '],
    ['Unicode whitespace', '\u00a0task-1'],
    ['format control', 'task-1\u200b'],
    ['String object', new String('task-1')],
    ['proxied String object', new Proxy(new String('task-1'), {})],
  ]) {
    invalid.push([`coreTaskId=${name}`, { ...completeMarker(), coreTaskId: value }]);
  }
  for (const [name, value] of [
    ['string', '3'],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['Number object', new Number(3)],
    ['proxied Number object', new Proxy(new Number(3), {})],
  ]) {
    invalid.push([`coreTaskVersion=${name}`, { ...completeMarker(), coreTaskVersion: value }]);
  }
  for (const field of ['tenantRef', 'accountRef', 'effectId', 'payloadHash']) {
    const missing = { ...completeMarker() };
    delete missing[field];
    invalid.push([`${field}=missing`, missing]);
    invalid.push([`${field}=undefined`, { ...completeMarker(), [field]: undefined }]);
    invalid.push([`${field}=null`, { ...completeMarker(), [field]: null }]);
  }
  for (const field of ['tenantRef', 'accountRef', 'effectId']) {
    invalid.push([`${field}=whitespace`, { ...completeMarker(), [field]: ` ${field}` }]);
    invalid.push([`${field}=String object`, {
      ...completeMarker(),
      [field]: new String(completeMarker()[field]),
    }]);
  }
  invalid.push(
    ['all identity explicitly null', {
      ...legacy,
      tenantRef: null,
      accountRef: null,
      effectId: null,
      payloadHash: null,
    }],
    ['payloadHash padded', { ...completeMarker(), payloadHash: ` ${completeMarker().payloadHash}` }],
  );

  for (const [name, marker] of invalid) {
    assert.throws(
      () => parseCanonicalTaskV2Marker(marker),
      error => error?.code === 'EXTERNAL_IDENTITY_CONFLICT'
        && error?.retryable === false,
      name,
    );
  }
});
