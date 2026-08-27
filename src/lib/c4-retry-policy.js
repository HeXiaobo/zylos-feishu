const NON_RETRYABLE_C4_CODES = new Set([
  'INVALID_ARGS',
  'INVALID_COMMAND',
  'INVALID_TRANSITION',
  'INVALID_CONFIRMATION_CAPABILITY',
  'FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'TASK_NOT_FOUND',
  'VERSION_CONFLICT',
  'CONFIRMATION_NOT_FOUND',
  'CONFIRMATION_ALREADY_RESOLVED',
  'TASK_INTAKE_FAILED',
]);

/** Retry unknown and infrastructure failures; reject only known deterministic input/state errors. */
export function isRetryableC4Failure(response) {
  const code = response?.error?.code;
  return typeof code !== 'string' || !NON_RETRYABLE_C4_CODES.has(code);
}
