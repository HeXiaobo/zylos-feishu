function requireAttempt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer attempt`);
  }
  return value;
}

export function decideTaskActionFailure({ retryable, attempt, maxAttempts } = {}) {
  if (typeof retryable !== 'boolean') {
    throw new TypeError('task action retryable must be boolean');
  }
  const currentAttempt = requireAttempt(attempt, 'task action attempt');
  const attemptLimit = requireAttempt(maxAttempts, 'task action maxAttempts');
  if (currentAttempt > attemptLimit) {
    throw new TypeError('task action attempt exceeds maxAttempts');
  }
  const atAttemptLimit = currentAttempt === attemptLimit;
  if (retryable && !atAttemptLimit) {
    return Object.freeze({
      phase: 'retrying',
      message: '任务操作暂未完成，系统正在自动重试。',
      retryTask: true,
      atAttemptLimit,
    });
  }
  return Object.freeze({
    phase: retryable ? 'exhausted' : 'rejected',
    message: retryable
      ? '任务操作多次重试仍未完成，请重新操作。'
      : '任务状态已变化，请刷新任务后重试。',
    retryTask: false,
    atAttemptLimit,
  });
}
