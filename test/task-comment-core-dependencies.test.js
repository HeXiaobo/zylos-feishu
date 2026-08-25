import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadTaskCommentReplyCoreDependencies,
} from '../src/lib/task-comment-core-dependencies.js';

test('reply runtime loads only the installed Commitment Core seam', async () => {
  const imported = [];
  const openCore = () => ({ close() {} });
  const dependencies = await loadTaskCommentReplyCoreDependencies({
    env: { ZYLOS_DIR: '/runtime/zylos' },
    async importModule(specifier) {
      imported.push(specifier);
      return { openCommitmentCore: openCore };
    },
  });

  assert.deepEqual(imported, [
    'file:///runtime/zylos/.claude/skills/commitment-core/scripts/core.js',
  ]);
  assert.equal(dependencies.openCore, openCore);
});
