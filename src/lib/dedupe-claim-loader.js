/**
 * Loads the message-claim store that the WebSocket path shares with the
 * feishu-recovery poller (docker/3ai/lib/feishu-claim.mjs in the 3ai image).
 *
 * It is OFF by default, on purpose. Persistent claims change recovery on
 * restart: a message claimed but not yet queued is not replayed after a crash.
 * That trade is only acceptable when the poller runs, so the switch lives on the
 * data volume next to the claims — `<dedup dir>/.enabled`, written by the
 * entrypoint only when ZYLOS_FEISHU_RECOVERY_CHAT_ID and the app credentials are
 * configured. It is not an environment variable: the poller is not the only
 * process that reads this file, and a bare `node` in the container would miss it.
 *
 * With no marker the component keeps its in-process Map and behaves exactly as
 * it did before this file existed: same restart behaviour, no claim files.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const ENABLED_MARKER = '.enabled';

export function claimLibPath(env = process.env) {
  const explicit = String(env.ZYLOS_FEISHU_CLAIM_LIB || '').trim();
  if (explicit) return explicit;
  const home = env.HOME || '/home/zylos';
  const zylosDir = String(env.ZYLOS_DIR || '').trim() || path.join(home, 'zylos');
  return path.join(zylosDir, 'lib', '3ai', 'feishu-claim.mjs');
}

export function claimDirPath(env = process.env) {
  const explicit = String(env.ZYLOS_FEISHU_DEDUP_DIR || '').trim();
  if (explicit) return explicit;
  const home = env.HOME || '/home/zylos';
  const zylosDir = String(env.ZYLOS_DIR || '').trim() || path.join(home, 'zylos');
  return path.join(zylosDir, 'components', 'feishu', 'dedup');
}

/** True when the entrypoint marked this deployment for shared claims. */
export function sharedClaimEnabled(env = process.env) {
  try {
    return fs.existsSync(path.join(claimDirPath(env), ENABLED_MARKER));
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{store: object|null, path: string, error?: string}>}
 */
export async function loadClaimStore({ via = 'ws', env = process.env, log = () => {} } = {}) {
  const dir = claimDirPath(env);
  const file = claimLibPath(env);
  if (!sharedClaimEnabled(env)) {
    return { store: null, path: file, error: `shared claim is off (${path.join(dir, ENABLED_MARKER)} is missing)` };
  }
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
