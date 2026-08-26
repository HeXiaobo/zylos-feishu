import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

export async function loadTaskCommentReplyCoreDependencies({
  env = process.env,
  importModule = specifier => import(specifier),
} = {}) {
  const zylosDir = env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
  const coreScripts = path.join(zylosDir, '.claude/skills/commitment-core/scripts');
  const [coreModule, coordinatorModule] = await Promise.all([
    importModule(pathToFileURL(path.join(coreScripts, 'core.js')).href),
    importModule(pathToFileURL(path.join(coreScripts, 'task-comment-coordinator.js')).href),
  ]);
  return Object.freeze({
    openCore: requireFunction(
      coreModule?.openCommitmentCore,
      'installed Commitment Core.openCommitmentCore',
    ),
    createCoordinator: requireFunction(
      coordinatorModule?.createTaskCommentCoordinator,
      'installed Commitment Core.createTaskCommentCoordinator',
    ),
  });
}
