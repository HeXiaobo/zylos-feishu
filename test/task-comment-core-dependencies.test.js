import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadTaskCommentReplyCoreDependencies,
} from '../src/lib/task-comment-core-dependencies.js';

test('reply runtime loads the installed Commitment Core and comment coordinator seams', async () => {
  const imported = [];
  const openCore = () => ({ close() {} });
  const createCoordinator = () => ({ record() {} });
  const dependencies = await loadTaskCommentReplyCoreDependencies({
    env: { ZYLOS_DIR: '/runtime/zylos' },
    async importModule(specifier) {
      imported.push(specifier);
      if (specifier.endsWith('/core.js')) return { openCommitmentCore: openCore };
      return { createTaskCommentCoordinator: createCoordinator };
    },
  });

  assert.deepEqual(imported, [
    'file:///runtime/zylos/.claude/skills/commitment-core/scripts/core.js',
    'file:///runtime/zylos/.claude/skills/commitment-core/scripts/task-comment-coordinator.js',
  ]);
  assert.equal(dependencies.openCore, openCore);
  assert.equal(dependencies.createCoordinator, createCoordinator);
});
