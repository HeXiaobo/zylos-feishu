import assert from 'node:assert/strict';
import test from 'node:test';

import { decideTaskActionFailure } from '../src/lib/task-action-failure-policy.js';

test('retryable task failures become a visible terminal outcome at the attempt limit', () => {
  assert.deepEqual(decideTaskActionFailure({
    retryable: true,
    attempt: 1,
    maxAttempts: 5,
  }), {
    phase: 'retrying',
    message: '任务操作暂未完成，系统正在自动重试。',
    retryTask: true,
    atAttemptLimit: false,
  });

  assert.deepEqual(decideTaskActionFailure({
    retryable: true,
    attempt: 5,
    maxAttempts: 5,
  }), {
    phase: 'exhausted',
    message: '任务操作多次重试仍未完成，请重新操作。',
    retryTask: false,
    atAttemptLimit: true,
  });
});

test('a permanent task conflict is presented as terminal without retrying the task', () => {
  assert.deepEqual(decideTaskActionFailure({
    retryable: false,
    attempt: 1,
    maxAttempts: 5,
  }), {
    phase: 'rejected',
    message: '任务状态已变化，请刷新任务后重试。',
    retryTask: false,
    atAttemptLimit: false,
  });
});

test('task failure policy rejects invalid attempt bounds', () => {
  for (const input of [
    { retryable: true, attempt: 0, maxAttempts: 5 },
    { retryable: true, attempt: 6, maxAttempts: 5 },
    { retryable: true, attempt: 1, maxAttempts: 0 },
  ]) assert.throws(() => decideTaskActionFailure(input), /attempt/);
});
