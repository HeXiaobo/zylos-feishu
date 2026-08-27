import assert from 'node:assert/strict';
import test from 'node:test';

import { isTaskCommentsEnabled } from '../src/lib/task-comment-runtime-policy.js';

test('Task comments require the shared Task v2 and comments opt-in flags', () => {
  assert.equal(isTaskCommentsEnabled({
    COMMITMENT_FEISHU_TASK_V2_ENABLED: '1',
    FEISHU_TASK_COMMENTS_ENABLED: '1',
  }), true);

  for (const env of [
    {},
    { COMMITMENT_FEISHU_TASK_V2_ENABLED: '1' },
    { FEISHU_TASK_COMMENTS_ENABLED: '1' },
    {
      COMMITMENT_FEISHU_TASK_V2_ENABLED: '0',
      FEISHU_TASK_COMMENTS_ENABLED: '1',
    },
  ]) {
    assert.equal(isTaskCommentsEnabled(env), false);
  }
});
