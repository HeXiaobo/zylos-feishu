import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTaskV2EventHandlerEntries,
  isTaskV2Enabled,
} from '../src/lib/task-v2-runtime-policy.js';

test('one explicit enable flag controls Task v2 outbound and reverse event capability', () => {
  assert.equal(isTaskV2Enabled({ COMMITMENT_FEISHU_TASK_V2_ENABLED: '1' }), true);
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    assert.equal(isTaskV2Enabled({ COMMITMENT_FEISHU_TASK_V2_ENABLED: value }), false);
  }

  const handle = async event => event;
  assert.deepEqual(createTaskV2EventHandlerEntries({ enabled: false, handle }), {});
  const enabled = createTaskV2EventHandlerEntries({ enabled: true, handle });
  assert.deepEqual(Object.keys(enabled).sort(), [
    'task.task.update_user_access_v2',
    'task.task.updated_v1',
  ]);
  assert.equal(enabled['task.task.update_user_access_v2'], handle);
  assert.equal(enabled['task.task.updated_v1'], handle);
  assert.equal(enabled['task.task.comment.updated_v1'], undefined);
});
