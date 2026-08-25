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
  const specifier = pathToFileURL(path.join(
    zylosDir,
    '.claude/skills/commitment-core/scripts/core.js',
  )).href;
  const coreModule = await importModule(specifier);
  return Object.freeze({
    openCore: requireFunction(
      coreModule?.openCommitmentCore,
      'installed Commitment Core.openCommitmentCore',
    ),
  });
}
