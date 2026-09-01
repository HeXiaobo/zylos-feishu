const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * Parse an opaque canonical SHA-256 identity without changing any input byte.
 * Whitespace, Unicode format characters, uppercase, alternate prefixes and
 * non-strings are invalid rather than normalized.
 */
export function parseCanonicalSha256(value, field = 'SHA-256 identity') {
  if (typeof value !== 'string' || !CANONICAL_SHA256.test(value)) {
    throw new TypeError(`${field} must be canonical sha256:<64 lowercase hex>`);
  }
  return value;
}
