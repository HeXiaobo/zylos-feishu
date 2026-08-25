import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { resolveZylosCli } from './zylos-cli-resolver.js';

const CAPABILITIES_URL = new URL('../../capabilities.json', import.meta.url);

export function loadFeishuCapabilities() {
  return JSON.parse(fs.readFileSync(CAPABILITIES_URL, 'utf8'));
}

export function checkCoreCompatibility({ env = process.env } = {}) {
  const required = loadFeishuCapabilities().requires['zylos-core'];
  const errors = [];
  let core = null;

  try {
    const zylosCli = resolveZylosCli({ env });
    const output = execFileSync(zylosCli, ['capabilities', '--json'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    });
    core = JSON.parse(output);
  } catch (error) {
    errors.push(`Core capabilities could not be read: ${error.message}`);
    return { ok: false, errors, core, required };
  }

  if (core?.product !== 'zylos-core') {
    errors.push(`Expected product zylos-core, found ${core?.product || 'unknown'}`);
  }
  if (core?.schemaVersion !== required.schemaVersion) {
    errors.push(`Capability schema ${core?.schemaVersion ?? 'missing'} does not match required ${required.schemaVersion}`);
  }

  for (const [name, minimum] of Object.entries(required.protocols)) {
    const actual = core?.protocols?.[name];
    if (!Number.isInteger(actual) || actual < minimum) {
      errors.push(`Protocol ${name} requires >= ${minimum}, found ${actual ?? 'missing'}`);
    }
  }

  return { ok: errors.length === 0, errors, core, required };
}

export function requireCompatibleCore(options) {
  const result = checkCoreCompatibility(options);
  if (result.ok) return result;

  const error = new Error(`Incompatible zylos-core:\n- ${result.errors.join('\n- ')}`);
  error.code = 'ZYLOS_CORE_INCOMPATIBLE';
  error.details = result;
  throw error;
}
