/**
 * Loads the message-claim store that the WebSocket path shares with the
 * feishu-recovery poller (docker/3ai/lib/feishu-claim.mjs in the 3ai image).
 *
 * The module is not vendored here on purpose: one file on disk
 * (~/zylos/lib/3ai/feishu-claim.mjs) serves both processes, so the two paths
 * cannot drift. When it is missing — a plain `zylos add` of this component
 * without the 3ai image — the loader reports that and the caller keeps its
 * in-process Map, which is the pre-2026-10-30 behaviour.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export function claimLibPath(env = process.env) {
  const explicit = String(env.ZYLOS_FEISHU_CLAIM_LIB || '').trim();
  if (explicit) return explicit;
  const home = env.HOME || '/home/zylos';
  const zylosDir = String(env.ZYLOS_DIR || '').trim() || path.join(home, 'zylos');
  return path.join(zylosDir, 'lib', '3ai', 'feishu-claim.mjs');
}

/**
 * @returns {Promise<{store: object|null, path: string, error?: string}>}
 */
export async function loadClaimStore({ via = 'ws', env = process.env, log = () => {} } = {}) {
  const file = claimLibPath(env);
  if (!fs.existsSync(file)) {
    return { store: null, path: file, error: `claim module not found at ${file}` };
  }
  try {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.createClaimStore !== 'function') {
      throw new Error('createClaimStore is not exported');
    }
    return { store: mod.createClaimStore({ via, log }), path: file };
  } catch (err) {
    return { store: null, path: file, error: `${file}: ${err.message}` };
  }
}
