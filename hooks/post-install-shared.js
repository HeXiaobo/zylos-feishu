#!/usr/bin/env node
/**
 * Shared entry point for post-install and post-upgrade hooks.
 *
 * `requireMinCoreVersion()` is the component guard: it applies to every
 * install, with or without the Feishu business tools.
 *
 * The lark-cli steps moved to ./post-install-tools.js when the deployment
 * layer split "Feishu messaging" from "Feishu business tools" (zylos-core
 * issue #132). They are re-exported here so old entry points
 * (`import ... from './post-install-shared.js'`) keep working unchanged.
 *
 * The target lark-cli version is read from package.json `larkCli.version`,
 * falling back to a hardcoded minimum for backward compatibility with
 * package.json files that predate the `larkCli` field.
 *
 * Each function throws on failure; the caller decides whether to abort.
 */

import { execSync } from 'child_process';

const MIN_CORE_VERSION = '0.5.0';
const LOG_PREFIX = '[zylos-feishu]';

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

/**
 * Guard: abort if zylos-core is not installed or is too old.
 * Called by both post-install and post-upgrade hooks.
 */
export function requireMinCoreVersion() {
  let coreVersion = null;
  try {
    coreVersion = execSync('zylos --version', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // not installed or not on PATH
  }
  if (!coreVersion) {
    console.error(
      `${LOG_PREFIX} requires zylos-core > ${MIN_CORE_VERSION}, but \`zylos --version\` could not be read.`
    );
    console.error(
      `${LOG_PREFIX} Aborting to avoid a broken install. Please run: zylos upgrade --self  (then retry).`
    );
    process.exit(1);
  }
  if (semverCompare(coreVersion, MIN_CORE_VERSION) <= 0) {
    console.error(
      `${LOG_PREFIX} requires zylos-core > ${MIN_CORE_VERSION}, found ${coreVersion}.`
    );
    console.error(`${LOG_PREFIX} Please run: zylos upgrade --self  (then retry).`);
    process.exit(1);
  }
}

// Compatibility re-exports: the lark-cli tool steps now live in their own
// module so a messaging-only install can skip them.
export {
  installLarkCliBinary,
  installLarkCliSkills,
  installLarkCliTools,
  syncCredentialsToLarkCli,
  toolsEnabled,
} from './post-install-tools.js';
