#!/usr/bin/env node
/**
 * Upgrade deletion prediction for zylos-feishu (issue #44).
 *
 * The rc.9 -> rc.10 upgrade incident: an ad-hoc worst-case tree diff ("present
 * in the live tree, absent from the target tree") predicted DELETE for 459
 * files under references/, while the real reify deleted 0 files and left the
 * tree byte-identical. The prediction and the behavior were exact opposites
 * because the ad-hoc analysis did not apply the real smart-merge deletion
 * semantics and was not labeled as a worst-case estimate.
 *
 * Real reify semantics (zylos-core smart-merge, merge mode):
 *   - Only files tracked by the installed baseline manifest
 *     (<skillDir>/.zylos/manifest.json) can ever be deleted.
 *   - A tracked file that the new version removes is deleted only when it is
 *     locally unmodified; a locally modified one is preserved (backed up when
 *     a backup directory is provided) and reported as preserved.
 *   - Files untracked by the baseline (for example the hook-installed
 *     references/ lark skills and their .lark-cli-version pin) are never
 *     deleted by the upgrade sync; the owning post-install/post-upgrade hook
 *     manages that content idempotently.
 *
 * This tool computes the deletion prediction and the applied deletion from ONE
 * shared plan function, so the predicted delete set and the actually deleted
 * file set cannot drift apart. Anything that is only a worst-case estimate is
 * explicitly labeled `predicted (worst-case)` and is never applied.
 *
 * Usage:
 *   node scripts/upgrade-delete-prediction.mjs --live <installedDir> --target <newSourceDir> \
 *     [--backup-dir <dir>] [--apply] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MANIFEST_DIR = '.zylos';
const MANIFEST_FILE = 'manifest.json';
const SOURCE_MARKER_FILE = '.zylos-source.json';
const TREE_EXCLUDES = new Set(['.git', MANIFEST_DIR, SOURCE_MARKER_FILE, 'node_modules', '.backup']);
export const WORST_CASE_LABEL = 'predicted (worst-case)';
const SCHEMA = 'zylos-feishu.upgrade-delete-prediction/v1';
const DELETE_SEMANTICS =
  'delete = baseline-tracked + upstream-removed + locally-unmodified; '
  + 'locally modified tracked files are preserved; untracked live files are never deleted';

export class ApplyRefusedError extends Error {}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Mirror zylos-core's safe relative-path rule for manifest entries. */
function isSafeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  return normalized !== '..'
    && !normalized.startsWith(`..${path.sep}`)
    && normalized === relPath;
}

/** Mirror zylos-core's manifest exclusion rules when walking a tree. */
function collectFiles(rootDir) {
  const files = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (TREE_EXCLUDES.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        files.push({ relativePath: path.relative(rootDir, fullPath), symlink: true });
      } else if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        files.push({ relativePath: path.relative(rootDir, fullPath), symlink: false });
      }
    }
  }

  visit(rootDir);
  return files;
}

/**
 * Mirror zylos-core's tree safety scan: any symlink anywhere in a synced tree
 * fails the whole sync, so a prediction must surface the same hard failure
 * instead of silently promising a normal run.
 */
function treeSymlinkErrors(rootDir, role) {
  const errors = [];
  if (lstatIfPresent(rootDir) === null) return errors;
  for (const entry of collectFiles(rootDir)) {
    if (entry.symlink) errors.push(`${entry.relativePath}: ${role} path is a symlink`);
  }
  return errors;
}

/** Build a { relativePath: sha256 } map using zylos-core's manifest semantics. */
function generateManifest(rootDir) {
  const files = {};
  for (const entry of collectFiles(rootDir)) {
    if (entry.symlink) continue;
    files[entry.relativePath] = sha256File(path.join(rootDir, entry.relativePath));
  }
  return files;
}

function loadBaselineManifest(liveDir) {
  const manifestPath = path.join(liveDir, MANIFEST_DIR, MANIFEST_FILE);
  const stat = lstatIfPresent(manifestPath);
  if (stat === null || !stat.isFile()) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || !manifest.files) return null;
    const files = { ...manifest.files };
    delete files[SOURCE_MARKER_FILE];
    return { manifestPath, files };
  } catch {
    return null;
  }
}

/**
 * The ONE shared deletion planner. `--apply` reifies exactly this plan, so the
 * predicted delete set and the actually deleted set are equal by construction.
 */
export function planUpgradeDeletions({ liveDir, targetDir, backupDir = null } = {}) {
  if (!liveDir || !targetDir) throw new Error('liveDir and targetDir are required');
  liveDir = path.resolve(liveDir);
  targetDir = path.resolve(targetDir);
  backupDir = backupDir ? path.resolve(backupDir) : null;

  if (lstatIfPresent(liveDir) === null) throw new Error(`live directory does not exist: ${liveDir}`);
  if (lstatIfPresent(targetDir) === null) throw new Error(`target directory does not exist: ${targetDir}`);

  const errors = [
    ...treeSymlinkErrors(liveDir, 'live'),
    ...treeSymlinkErrors(targetDir, 'target'),
  ];

  const baseline = loadBaselineManifest(liveDir);
  const targetFiles = errors.length > 0 ? {} : generateManifest(targetDir);
  const targetFileSet = new Set(Object.keys(targetFiles));
  const trackedFiles = baseline ? Object.keys(baseline.files) : [];

  const plan = {
    schema: SCHEMA,
    liveDir,
    targetDir,
    mode: 'merge',
    baseline: baseline
      ? { manifestPath: baseline.manifestPath, trackedFiles: trackedFiles.length }
      : null,
    plan: {
      certainty: errors.length === 0 ? 'exact' : 'unavailable',
      semantics: DELETE_SEMANTICS,
      delete: [],
      preserve: [],
      alreadyAbsent: [],
      errors,
    },
    worstCase: null,
  };

  if (errors.length === 0) {
    for (const file of trackedFiles) {
      if (!isSafeRelativePath(file)) {
        plan.plan.errors.push(`${file}: unsafe path in baseline manifest`);
        continue;
      }
      if (targetFileSet.has(file)) continue;

      const destFile = path.join(liveDir, file);
      const relative = path.relative(liveDir, destFile);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        plan.plan.errors.push(`${file}: tracked path escapes the live root`);
        continue;
      }
      const destStat = lstatIfPresent(destFile);
      if (destStat === null) {
        plan.plan.alreadyAbsent.push(file);
        continue;
      }
      if (!destStat.isFile() || destStat.isSymbolicLink()) {
        plan.plan.errors.push(`${file}: tracked destination is not a regular non-symlink file`);
        continue;
      }
      if (sha256File(destFile) !== baseline.files[file]) {
        const entry = {
          file,
          reason: 'upstream_removed_local_modified',
          certainty: 'exact',
          outcome: 'preserved',
        };
        if (backupDir) entry.backupPath = path.join(backupDir, file);
        plan.plan.preserve.push(entry);
        continue;
      }
      plan.plan.delete.push({
        file,
        reason: 'tracked_upstream_removed_local_unmodified',
        certainty: 'exact',
        outcome: 'deleted',
      });
    }
  }

  // Worst-case view: everything present in the live tree, absent from the
  // target tree and NOT tracked by the baseline. The incident's ad-hoc
  // analysis listed exactly this class as DELETE; the real reify deletes none
  // of it. Enumerated for transparency only, always labeled, never applied.
  if (errors.length === 0) {
    const trackedSet = new Set(trackedFiles);
    const worstCaseFiles = collectFiles(liveDir)
      .filter((entry) => !entry.symlink)
      .map((entry) => entry.relativePath)
      .filter((relativePath) => !trackedSet.has(relativePath) && !targetFileSet.has(relativePath))
      .sort((a, b) => a.localeCompare(b));
    plan.worstCase = {
      label: WORST_CASE_LABEL,
      certainty: WORST_CASE_LABEL,
      note: 'present in the live tree, absent from the target tree and untracked by the '
        + 'baseline manifest (for example hook-installed references/ content). The real '
        + 'reify deletes none of these; the owning post-upgrade hook manages this content.',
      files: worstCaseFiles,
      count: worstCaseFiles.length,
      deletedByReify: 0,
    };
  }

  return plan;
}

/**
 * Reify the shared plan. Only the deterministic delete set is applied; the
 * worst-case enumeration is never applied. Preserved files are backed up when
 * a backup directory is provided (zylos-core's preserve-with-backup behavior).
 */
export function applyDeletionPlan(plan, { backupDir = null } = {}) {
  if (!plan || plan.schema !== SCHEMA) throw new Error('invalid deletion plan');
  if (plan.plan.certainty !== 'exact') {
    throw new ApplyRefusedError(
      `refusing to apply a plan that is not exact: ${plan.plan.certainty}`
        + `${plan.plan.errors.length > 0 ? ` (${plan.plan.errors.join('; ')})` : ''}`,
    );
  }
  backupDir = backupDir ? path.resolve(backupDir) : null;
  const liveDir = plan.liveDir;
  const applied = { deleted: [], preserved: [], errors: [] };

  for (const entry of plan.plan.preserve) {
    try {
      if (entry.backupPath) {
        fs.mkdirSync(path.dirname(entry.backupPath), { recursive: true });
        fs.copyFileSync(path.join(liveDir, entry.file), entry.backupPath);
      }
      applied.preserved.push(entry.file);
    } catch (error) {
      applied.errors.push(`${entry.file}: preserve failed: ${error.message}`);
    }
  }

  for (const entry of plan.plan.delete) {
    const destFile = path.join(liveDir, entry.file);
    try {
      fs.unlinkSync(destFile);
      applied.deleted.push(entry.file);
      let dir = path.dirname(destFile);
      while (dir !== liveDir) {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      }
    } catch (error) {
      applied.errors.push(`${entry.file}: delete failed: ${error.message}`);
    }
  }

  return applied;
}

function formatHuman(report) {
  const lines = [];
  lines.push(`upgrade deletion prediction (schema ${SCHEMA})`);
  lines.push(`  live:    ${report.liveDir}`);
  lines.push(`  target:  ${report.targetDir}`);
  lines.push(`  mode:    ${report.mode}`);
  lines.push(`  baseline manifest: ${report.baseline ? `${report.baseline.manifestPath} (${report.baseline.trackedFiles} tracked files)` : 'missing (no baseline: nothing can be deleted)'}`);
  lines.push(`  deterministic plan: certainty=${report.plan.certainty}`);
  lines.push(`    semantics: ${report.plan.semantics}`);
  lines.push(`    delete (${report.plan.delete.length}): ${report.plan.delete.map((entry) => entry.file).join(', ') || '(none)'}`);
  lines.push(`    preserve (${report.plan.preserve.length}): ${report.plan.preserve.map((entry) => entry.file).join(', ') || '(none)'}`);
  lines.push(`    already absent (${report.plan.alreadyAbsent.length})`);
  if (report.plan.errors.length > 0) {
    lines.push(`    errors (${report.plan.errors.length}): ${report.plan.errors.join('; ')}`);
  }
  if (report.worstCase) {
    lines.push(`  ${report.worstCase.label}: ${report.worstCase.count} file(s) present in live, absent from target, untracked by baseline`);
    lines.push(`    note: ${report.worstCase.note}`);
    lines.push(`    deleted by the real reify: ${report.worstCase.deletedByReify}`);
    for (const file of report.worstCase.files) lines.push(`    ${WORST_CASE_LABEL} ${file}`);
  }
  if (report.applied) {
    lines.push(`  applied: deleted ${report.applied.deleted.length}, preserved ${report.applied.preserved.length}`);
    if (report.applied.errors.length > 0) {
      lines.push(`    apply errors (${report.applied.errors.length}): ${report.applied.errors.join('; ')}`);
    }
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    live: null,
    target: null,
    backupDir: null,
    apply: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = (flag) => {
      if (argv[index + 1] === undefined) throw new Error(`${flag} requires a value`);
      index += 1;
      return argv[index];
    };
    if (arg === '--live') args.live = value('--live');
    else if (arg === '--target') args.target = value('--target');
    else if (arg === '--backup-dir') args.backupDir = value('--backup-dir');
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.live || !args.target) {
    throw new Error('usage: node scripts/upgrade-delete-prediction.mjs --live <installedDir> --target <newSourceDir> [--backup-dir <dir>] [--apply] [--json]');
  }
  return args;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }

  let report;
  try {
    report = planUpgradeDeletions({ liveDir: args.live, targetDir: args.target, backupDir: args.backupDir });
    if (args.apply) report.applied = applyDeletionPlan(report, { backupDir: args.backupDir });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 1;
  }

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatHuman(report));
  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
