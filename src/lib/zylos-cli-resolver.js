import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function unavailable(message) {
  const error = new Error(message);
  error.code = 'ZYLOS_CLI_UNAVAILABLE';
  return error;
}

/**
 * Resolve the executable passed directly to child_process.execFile.
 */
export function resolveZylosCli({ env = process.env } = {}) {
  const configured = env.ZYLOS_CLI_PATH;
  if (typeof configured === 'string' && configured.trim() !== '') {
    if (!path.isAbsolute(configured)) {
      throw unavailable('ZYLOS_CLI_PATH must be an absolute path');
    }
    if (!isExecutable(configured)) {
      throw unavailable('ZYLOS_CLI_PATH is not executable');
    }
    return configured;
  }

  const home = typeof env.HOME === 'string' && env.HOME.trim() !== ''
    ? env.HOME
    : os.homedir();
  const deployed = path.join(home, 'zylos/bin/zylos');
  if (isExecutable(deployed)) return deployed;

  const npmGlobal = path.join(home, '.npm-global/bin/zylos');
  if (isExecutable(npmGlobal)) return npmGlobal;

  if (typeof env.PATH === 'string') {
    for (const directory of env.PATH.split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, 'zylos');
      if (isExecutable(candidate)) return candidate;
    }
  }

  throw unavailable('Zylos CLI executable was not found');
}
