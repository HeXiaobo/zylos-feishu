#!/usr/bin/env node
/**
 * Shared helpers for post-install and post-upgrade hooks.
 *
 * Four exported functions:
 *   0. requireCompatibleCore()          - guard: Core protocol contract
 *   1. installLarkCliBinary()           - probe + version check + install/upgrade
 *   2. installLarkCliSkills(skillDir)   - probe + version check + install/upgrade
 *   3. syncCredentialsToLarkCli(opts)   - read ~/zylos/.env, delegate to
 *                                          `lark-cli config init --app-secret-stdin`
 *
 * The target lark-cli version is read from package.json `larkCli.version`,
 * falling back to a hardcoded minimum for backward compatibility with
 * package.json files that predate the `larkCli` field.
 *
 * Each function throws on failure; the caller decides whether to abort.
 */

import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { parse as parseDotenv } from 'dotenv';
import { fileURLToPath } from 'url';
export { requireCompatibleCore } from '../src/lib/core-compatibility.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LARK_CLI_NPM_PACKAGE = '@larksuite/cli';
const FALLBACK_VERSION = '1.0.41';
const XC_SKILLS_SOURCE = 'https://github.com/larksuite/cli';
const EXPECTED_SUB_SKILLS = Object.freeze([
  'lark-apps',
  'lark-approval',
  'lark-attendance',
  'lark-base',
  'lark-calendar',
  'lark-contact',
  'lark-doc',
  'lark-drive',
  'lark-event',
  'lark-im',
  'lark-mail',
  'lark-markdown',
  'lark-minutes',
  'lark-note',
  'lark-okr',
  'lark-openapi-explorer',
  'lark-shared',
  'lark-sheets',
  'lark-skill-maker',
  'lark-slides',
  'lark-task',
  'lark-vc',
  'lark-vc-agent',
  'lark-whiteboard',
  'lark-wiki',
  'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
]);
const LARK_BRAND = 'feishu';
const DEFAULT_LARK_LANG = 'zh';
const DEFAULT_ENV_FILE = path.join(process.env.HOME || '', 'zylos/.env');
const LOG_PREFIX = '[zylos-feishu]';
const SKILLS_VERSION_FILE = '.lark-cli-version';

function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

function getTargetVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
    );
    return pkg.larkCli?.version || FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getInstalledVersion() {
  try {
    const out = execSync('lark-cli --version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the `lark-cli` binary is on PATH at the target version.
 */
export function installLarkCliBinary() {
  const target = getTargetVersion();
  const installed = getInstalledVersion();

  if (installed) {
    if (semverCompare(installed, target) >= 0) {
      console.log(`${LOG_PREFIX} lark-cli ${installed} >= target ${target}, skipping`);
      return;
    }
    console.log(`${LOG_PREFIX} lark-cli ${installed} < target ${target}, upgrading`);
  } else {
    console.log(`${LOG_PREFIX} lark-cli not found, installing ${target}`);
  }

  execSync(`npm install -g ${LARK_CLI_NPM_PACKAGE}@${target}`, { stdio: 'inherit' });

  if (!commandExists('lark-cli')) {
    throw new Error(
      `lark-cli not found in PATH after npm install -g ${LARK_CLI_NPM_PACKAGE}@${target}`
    );
  }

  const newVersion = getInstalledVersion();
  console.log(`${LOG_PREFIX} lark-cli now at ${newVersion}`);
}

/**
 * Install or upgrade lark-cli's bundled Agent Skills into `<skillDir>/references/`.
 *
 * Triggers a (re-)install when:
 *   - Any sub-skill directory is missing (partial install / manual deletion)
 *   - The version marker file is absent (legacy install) or below target
 */
export function installLarkCliSkills(skillDir) {
  if (!skillDir) {
    throw new Error('installLarkCliSkills: skillDir is required');
  }
  const target = getTargetVersion();
  const bundlesDir = path.join(skillDir, 'references');
  fs.mkdirSync(bundlesDir, { recursive: true });

  const versionFile = path.join(bundlesDir, SKILLS_VERSION_FILE);

  const findMissing = () =>
    EXPECTED_SUB_SKILLS.filter(
      (name) => !fs.existsSync(path.join(bundlesDir, name, 'SKILL.md'))
    );

  let installedSkillsVersion = null;
  try {
    installedSkillsVersion = fs.readFileSync(versionFile, 'utf-8').trim();
  } catch { /* missing = needs install */ }

  const missing = findMissing();
  const needsVersionUpgrade =
    !installedSkillsVersion || semverCompare(installedSkillsVersion, target) < 0;

  if (missing.length === 0 && !needsVersionUpgrade) {
    console.log(
      `${LOG_PREFIX} all ${EXPECTED_SUB_SKILLS.length} sub-skills present at ${installedSkillsVersion}, skipping`
    );
    return;
  }

  if (needsVersionUpgrade) {
    console.log(
      `${LOG_PREFIX} sub-skills version ${installedSkillsVersion || '(none)'} → ${target}, upgrading`
    );
  }
  if (missing.length > 0) {
    console.log(
      `${LOG_PREFIX} ${missing.length}/${EXPECTED_SUB_SKILLS.length} sub-skill(s) missing, repairing`
    );
  }

  execSync(
    `npx xc-skills@latest add ${XC_SKILLS_SOURCE}#v${target} --out "${bundlesDir}" -y`,
    { stdio: 'inherit' }
  );

  const stillMissing = findMissing();
  if (stillMissing.length > 0) {
    throw new Error(
      `installLarkCliSkills: still missing after install: ${stillMissing.join(', ')}`
    );
  }

  fs.writeFileSync(versionFile, target + '\n');
  console.log(`${LOG_PREFIX} sub-skills updated to ${target}`);
}

/**
 * Push FEISHU_APP_ID / FEISHU_APP_SECRET into lark-cli's keychain by delegating
 * to `lark-cli config init --app-secret-stdin`.
 *
 * Resolution order (first non-empty wins per field):
 *   appId / appSecret:
 *     1. opts.appId / opts.appSecret
 *     2. ~/zylos/.env  (parsed via dotenv.parse, no side effects on process.env)
 *     3. process.env.FEISHU_APP_ID / FEISHU_APP_SECRET
 *   lang:
 *     1. opts.lang
 *     2. ~/zylos/.env  FEISHU_LANG
 *     3. process.env.FEISHU_LANG
 *     4. fallback 'zh'
 *
 * If appId or appSecret cannot be resolved, logs a warning and returns
 * {skipped: true, reason: 'credentials_missing'} — does NOT throw.
 *
 * Secret is piped via stdin so it never appears in the process listing.
 */
export function syncCredentialsToLarkCli(opts = {}) {
  let { appId, appSecret, lang, envFile = DEFAULT_ENV_FILE } = opts;

  if (fs.existsSync(envFile)) {
    const parsed = parseDotenv(fs.readFileSync(envFile));
    appId = appId || parsed.FEISHU_APP_ID;
    appSecret = appSecret || parsed.FEISHU_APP_SECRET;
    lang = lang || parsed.FEISHU_LANG;
  }
  appId = appId || process.env.FEISHU_APP_ID;
  appSecret = appSecret || process.env.FEISHU_APP_SECRET;
  lang = lang || process.env.FEISHU_LANG || DEFAULT_LARK_LANG;

  if (!appId || !appSecret) {
    console.warn(
      `${LOG_PREFIX} FEISHU_APP_ID / FEISHU_APP_SECRET not found in ${envFile} ` +
      `or process.env; skipping lark-cli keychain sync. ` +
      `Add the variables to ${envFile} and re-run this hook (or 'zylos upgrade feishu') to sync.`
    );
    return { skipped: true, reason: 'credentials_missing' };
  }

  execFileSync('lark-cli', [
    'config', 'init',
    '--app-id', appId,
    '--app-secret-stdin',
    '--brand', LARK_BRAND,
    '--name', LARK_BRAND,
    '--lang', lang,
  ], {
    input: appSecret + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  console.log(`${LOG_PREFIX} synced App credentials to lark-cli (brand=${LARK_BRAND}, lang=${lang})`);

  return {
    appId,
    brand: LARK_BRAND,
    lang,
    configPath: path.join(process.env.HOME || '', '.lark-cli', 'config.json'),
    keychainID: `appsecret:${appId}`,
  };
}
