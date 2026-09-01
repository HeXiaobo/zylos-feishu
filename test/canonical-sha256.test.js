import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCanonicalSha256 } from '../src/lib/canonical-sha256.js';

test('canonical SHA-256 parser rejects every non-exact byte representation', () => {
  const canonical = `sha256:${'a'.repeat(64)}`;
  assert.equal(parseCanonicalSha256(canonical), canonical);

  const invalid = [
    ` ${canonical}`,
    `${canonical} `,
    `\t${canonical}`,
    `${canonical}\n`,
    `\u00a0${canonical}`,
    `${canonical}\u2003`,
    `\u3000${canonical}`,
    `\u200b${canonical}`,
    `${canonical}\u200b`,
    `sha256:${'a'.repeat(32)}\u200b${'a'.repeat(32)}`,
    `sha256:${'A'.repeat(64)}`,
    `SHA256:${'a'.repeat(64)}`,
    `sha-256:${'a'.repeat(64)}`,
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'a'.repeat(65)}`,
    `sha256：${'a'.repeat(64)}`,
    null,
    undefined,
    42,
    { value: canonical },
    Buffer.from(canonical),
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseCanonicalSha256(value),
      /canonical sha256/,
      typeof value === 'string' ? JSON.stringify(value) : String(value),
    );
  }
});
