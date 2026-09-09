/**
 * Regression tests for the issue #44 fix: the upgrade deletion prediction must
 * match the real reify behavior (same baseline, same preserve/delete
 * semantics), and any worst-case-only enumeration must be explicitly labeled
 * `predicted (worst-case)` instead of masquerading as a deterministic result.
 *
 * Incident recap (rc.9 -> rc.10): an ad-hoc worst-case tree diff predicted
 * DELETE for 459 files under references/, while the real reify deleted 0 files
 * and left the tree byte-identical. references/ content is hook-installed and
 * untracked by the baseline manifest, so the real smart-merge semantics never
 * delete it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  applyDeletionPlan,
  planUpgradeDeletions,
  WORST_CASE_LABEL,
  ApplyRefusedError,
} from '../scripts/upgrade-delete-prediction.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/upgrade-delete-prediction.mjs', import.meta.url));

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeTree(rootDir, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function writeBaselineManifest(liveDir, tracked) {
  fs.mkdirSync(path.join(liveDir, '.zylos'), { recursive: true });
  fs.writeFileSync(
    path.join(liveDir, '.zylos', 'manifest.json'),
    `${JSON.stringify({ files: tracked, generated_at: 'test' }, null, 2)}\n`,
  );
}

function referenceFiles() {
  const files = {};
  for (let index = 0; index < 12; index++) {
    files[`references/lark-${String(index % 3).padStart(2, '0')}/ref-${index}.md`] = `ref ${index}\n`;
  }
  files['references/.lark-cli-version'] = '1.0.41\n';
  return files;
}

/**
 * Build the incident scenario:
 *   live tree:  tracked src/keep.js + src/gone.js + src/modified.js, plus
 *               references/ content with a .lark-cli-version pin installed by
 *               the post-upgrade hook and untracked by the baseline manifest.
 *   target:     the "new version" that no longer ships src/gone.js and
 *               src/modified.js and never shipped references/.
 * With modifyTracked, src/modified.js carries a local patch on top of the
 * baseline (the preserve path).
 */
function buildIncidentFixture({ modifyTracked = false } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-issue44-'));
  const fixture = {
    rootDir,
    liveDir: path.join(rootDir, 'live'),
    targetDir: path.join(rootDir, 'target'),
    backupDir: path.join(rootDir, 'backup'),
    referencesFiles: referenceFiles(),
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };

  const keepContent = 'console.log("keep v9");\n';
  const baselineContents = {
    'src/keep.js': keepContent,
    'src/gone.js': 'console.log("gone v9");\n',
    'src/modified.js': 'console.log("modified v9");\n',
    ...fixture.referencesFiles,
  };
  writeTree(fixture.liveDir, baselineContents);
  // The baseline records the pristine installed content; a local patch applied
  // afterwards is exactly what the preserve path must detect.
  const tracked = {};
  for (const relativePath of ['src/keep.js', 'src/gone.js', 'src/modified.js']) {
    tracked[relativePath] = sha256(baselineContents[relativePath]);
  }
  if (modifyTracked) {
    fs.writeFileSync(path.join(fixture.liveDir, 'src/modified.js'), 'console.log("locally patched");\n');
  }
  writeTree(fixture.targetDir, { 'src/keep.js': keepContent });
  writeBaselineManifest(fixture.liveDir, tracked);

  // Hashes of every file that must survive an upgrade untouched: the
  // hook-managed references/ content plus the upstream-unchanged keep.js.
  fixture.survivalSnapshot = () => Object.fromEntries(
    Object.keys(fixture.referencesFiles).concat('src/keep.js').map((relativePath) => [
      relativePath,
      sha256(fs.readFileSync(path.join(fixture.liveDir, relativePath))),
    ]),
  );
  return fixture;
}

test('deterministic delete prediction equals the actually deleted set', () => {
  const fixture = buildIncidentFixture();
  try {
    const plan = planUpgradeDeletions({ liveDir: fixture.liveDir, targetDir: fixture.targetDir });

    assert.equal(plan.plan.certainty, 'exact');
    assert.deepEqual(plan.plan.delete.map((entry) => entry.file), ['src/gone.js', 'src/modified.js']);
    for (const entry of plan.plan.delete) {
      assert.equal(entry.reason, 'tracked_upstream_removed_local_unmodified');
    }

    const applied = applyDeletionPlan(plan);
    assert.deepEqual(applied.deleted, plan.plan.delete.map((entry) => entry.file));
    assert.ok(!fs.existsSync(path.join(fixture.liveDir, 'src/gone.js')));
    // Upstream-unchanged and hook-managed files are untouched.
    const after = fixture.survivalSnapshot();
    assert.equal(after['src/keep.js'], sha256('console.log("keep v9");\n'));
    assert.ok(fs.existsSync(path.join(fixture.liveDir, 'references/.lark-cli-version')));
  } finally {
    fixture.cleanup();
  }
});

test('locally modified tracked file is predicted and actually preserved, never deleted', () => {
  const fixture = buildIncidentFixture({ modifyTracked: true });
  try {
    const plan = planUpgradeDeletions({
      liveDir: fixture.liveDir,
      targetDir: fixture.targetDir,
      backupDir: fixture.backupDir,
    });

    assert.deepEqual(plan.plan.delete.map((entry) => entry.file), ['src/gone.js']);
    assert.deepEqual(plan.plan.preserve.map((entry) => entry.file), ['src/modified.js']);
    assert.equal(plan.plan.preserve[0].reason, 'upstream_removed_local_modified');
    assert.ok(plan.plan.preserve[0].backupPath);

    const applied = applyDeletionPlan(plan, { backupDir: fixture.backupDir });
    assert.deepEqual(applied.deleted, plan.plan.delete.map((entry) => entry.file));
    assert.deepEqual(applied.preserved, ['src/modified.js']);
    assert.equal(
      fs.readFileSync(path.join(fixture.liveDir, 'src/modified.js'), 'utf8'),
      'console.log("locally patched");\n',
      'preserved file must survive byte-identical',
    );
    assert.equal(
      fs.readFileSync(path.join(fixture.backupDir, 'src/modified.js'), 'utf8'),
      'console.log("locally patched");\n',
      'preserved file must be backed up',
    );
  } finally {
    fixture.cleanup();
  }
});

test('incident scenario: untracked references/ content is predicted as zero deletions and survives byte-identical', () => {
  const fixture = buildIncidentFixture();
  try {
    const before = fixture.survivalSnapshot();

    const plan = planUpgradeDeletions({ liveDir: fixture.liveDir, targetDir: fixture.targetDir });

    // Empty-for-empty: the predicted delete set contains no references/ file
    // and the actually deleted set contains none either.
    assert.deepEqual(plan.plan.delete.filter((entry) => entry.file.startsWith('references/')), []);
    const applied = applyDeletionPlan(plan);
    assert.deepEqual(applied.deleted.filter((file) => file.startsWith('references/')), []);

    const after = fixture.survivalSnapshot();
    assert.deepEqual(after, before, 'live tree must stay byte-identical outside the deterministic delete set');
    assert.ok(fs.existsSync(path.join(fixture.liveDir, 'references/.lark-cli-version')));
  } finally {
    fixture.cleanup();
  }
});

test('worst-case enumeration is labeled and never counted as deletions', () => {
  const fixture = buildIncidentFixture();
  try {
    const plan = planUpgradeDeletions({ liveDir: fixture.liveDir, targetDir: fixture.targetDir });

    assert.ok(plan.worstCase, 'the incident file class must be enumerated for transparency');
    assert.equal(plan.worstCase.certainty, WORST_CASE_LABEL);
    assert.equal(plan.worstCase.label, WORST_CASE_LABEL);
    assert.equal(plan.worstCase.deletedByReify, 0);
    assert.deepEqual(
      plan.worstCase.files,
      Object.keys(fixture.referencesFiles).sort((a, b) => a.localeCompare(b)),
    );

    const serialized = JSON.stringify(plan);
    assert.ok(serialized.includes('predicted (worst-case)'));
    // The deterministic section must not carry the worst-case label.
    assert.equal(plan.plan.certainty, 'exact');
    assert.ok(!JSON.stringify(plan.plan).includes('predicted (worst-case)'));
  } finally {
    fixture.cleanup();
  }
});

test('apply refuses a plan that is not exact (symlink safety failure)', () => {
  const fixture = buildIncidentFixture();
  try {
    fs.symlinkSync(
      path.join(fixture.liveDir, 'src/keep.js'),
      path.join(fixture.liveDir, 'src/link.js'),
    );

    const plan = planUpgradeDeletions({ liveDir: fixture.liveDir, targetDir: fixture.targetDir });
    assert.equal(plan.plan.certainty, 'unavailable');
    assert.deepEqual(plan.plan.delete, [], 'an unavailable plan must predict zero deletions');
    assert.equal(plan.worstCase, null);
    assert.ok(plan.plan.errors.some((error) => error.includes('symlink')));

    assert.throws(() => applyDeletionPlan(plan), ApplyRefusedError);
    assert.ok(fs.existsSync(path.join(fixture.liveDir, 'src/gone.js')), 'nothing may be deleted when the plan is not exact');
  } finally {
    fixture.cleanup();
  }
});

test('missing baseline manifest predicts zero deletions like the real reify', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-feishu-issue44-'));
  try {
    const liveDir = path.join(rootDir, 'live');
    const targetDir = path.join(rootDir, 'target');
    writeTree(liveDir, { 'src/only-live.js': 'live\n' });
    fs.mkdirSync(targetDir, { recursive: true });

    const plan = planUpgradeDeletions({ liveDir, targetDir });
    assert.equal(plan.baseline, null);
    assert.deepEqual(plan.plan.delete, []);
    assert.deepEqual(applyDeletionPlan(plan).deleted, []);
    assert.ok(fs.existsSync(path.join(liveDir, 'src/only-live.js')));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('CLI: json output keeps the prediction/apply contract and the worst-case label', () => {
  const fixture = buildIncidentFixture();
  try {
    const stdout = execFileSync(process.execPath, [
      SCRIPT_PATH,
      '--live', fixture.liveDir,
      '--target', fixture.targetDir,
      '--json',
    ], { encoding: 'utf8' });
    const report = JSON.parse(stdout);

    assert.equal(report.schema, 'zylos-feishu.upgrade-delete-prediction/v1');
    assert.equal(report.plan.certainty, 'exact');
    assert.deepEqual(report.plan.delete.map((entry) => entry.file), ['src/gone.js', 'src/modified.js']);
    assert.equal(report.worstCase.certainty, 'predicted (worst-case)');
    assert.equal(report.worstCase.count, Object.keys(fixture.referencesFiles).length);
    assert.equal(report.worstCase.deletedByReify, 0);
    assert.equal(report.applied, undefined, 'prediction-only runs must not report an applied section');

    // --apply executes the same shared plan: predicted delete set == applied delete set.
    const applyStdout = execFileSync(process.execPath, [
      SCRIPT_PATH,
      '--live', fixture.liveDir,
      '--target', fixture.targetDir,
      '--apply',
      '--json',
    ], { encoding: 'utf8' });
    const appliedReport = JSON.parse(applyStdout);
    assert.deepEqual(
      appliedReport.applied.deleted,
      appliedReport.plan.delete.map((entry) => entry.file),
    );
    assert.ok(!fs.existsSync(path.join(fixture.liveDir, 'src/gone.js')));
    assert.ok(fs.existsSync(path.join(fixture.liveDir, 'references/.lark-cli-version')));
  } finally {
    fixture.cleanup();
  }
});

test('CLI: human output marks the worst-case section with the required label', () => {
  const fixture = buildIncidentFixture();
  try {
    const stdout = execFileSync(process.execPath, [
      SCRIPT_PATH,
      '--live', fixture.liveDir,
      '--target', fixture.targetDir,
    ], { encoding: 'utf8' });

    assert.ok(stdout.includes('predicted (worst-case)'));
    assert.ok(stdout.includes('src/gone.js'));
  } finally {
    fixture.cleanup();
  }
});
