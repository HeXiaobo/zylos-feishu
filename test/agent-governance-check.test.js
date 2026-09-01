import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  classifyBranch,
  parseArgs,
  runGovernance,
  validateDeploymentReadiness,
  validateReleaseManifest,
  validateReleaseMetadata,
} from '../scripts/agent-governance-check.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function tempDirectory(prefix = 'zylos-feishu-governance-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureMetadata(root, version) {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'zylos-feishu', version }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ name: 'zylos-feishu', version, packages: { '': { name: 'zylos-feishu', version } } }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(root, 'capabilities.json'),
    JSON.stringify({ schemaVersion: 1, product: 'zylos-feishu', release: version }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: feishu\nversion: ${version}\n---\n`);
}

function globalV2Manifest({ headSha = git(ROOT, 'rev-parse', 'HEAD'), version = '0.3.7-rc.12', ...overrides } = {}) {
  return {
    schema: 'zylos.release-manifest/v2',
    releaseId: 'ZYL-TEST-V2-FEISHU',
    status: 'READY',
    deploymentAllowed: true,
    publicationAllowed: true,
    stable: {
      feishu: {
        repo: 'HeXiaobo/zylos-feishu',
        branch: 'main',
        version: '0.3.7-rc.11',
        sha: '1'.repeat(40),
      },
    },
    candidate: {
      feishu: {
        repo: 'HeXiaobo/zylos-feishu',
        branch: 'main',
        version,
        sha: headSha,
      },
    },
    localValidationRepos: { feishu: '/tmp/zylos-feishu-validation' },
    sourcePolicy: { deployableBranch: 'main' },
    deploymentContract: {
      targetMode: 'global',
      pairComponents: ['core', 'feishu'],
      hxaRequired: true,
    },
    evidence: {
      ownerAuthorization: {
        status: 'PASS',
        identity: 'user',
        bundle: { feishuSha: headSha },
      },
    },
    holdReasons: [],
    ...overrides,
  };
}

function governanceCliFixture() {
  const root = tempDirectory('zylos-feishu-governance-cli-');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const filename of ['package.json', 'package-lock.json', 'capabilities.json', 'SKILL.md']) {
    fs.copyFileSync(path.join(ROOT, filename), path.join(root, filename));
  }
  fs.copyFileSync(
    path.join(ROOT, 'scripts/agent-governance-check.js'),
    path.join(root, 'scripts/agent-governance-check.js'),
  );
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'governance-tests@example.invalid');
  git(root, 'config', 'user.name', 'Governance Tests');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

test('repository release metadata is aligned at the release 0.3.7-rc.12 baseline', () => {
  const result = validateReleaseMetadata(ROOT);
  assert.deepEqual(result.failures, []);
  assert.equal(result.packageVersion, '0.3.7-rc.12');
});

test('classifies protected, release, and feature branches', () => {
  assert.equal(classifyBranch('main'), 'protected');
  assert.equal(classifyBranch('release/0.3.6'), 'release');
  assert.equal(classifyBranch('codex/agent-governance-gates'), 'functional');
  assert.equal(classifyBranch('refs/heads/fix/metadata-gate'), 'functional');
  assert.equal(classifyBranch('detached'), 'unknown');
});

test('feature checks compare release versions with their base', () => {
  const fixture = tempDirectory();
  try {
    writeFixtureMetadata(fixture, '0.3.6');
    git(fixture, 'init', '-q');
    git(fixture, 'config', 'user.email', 'governance-tests@example.invalid');
    git(fixture, 'config', 'user.name', 'Governance Tests');
    git(fixture, 'add', '.');
    git(fixture, 'commit', '-qm', 'baseline');
    git(fixture, 'branch', '-M', 'feat/version-change');

    writeFixtureMetadata(fixture, '0.3.7');
    git(fixture, 'add', '.');
    git(fixture, 'commit', '-qm', 'version change');

    const result = runGovernance({ root: fixture, branch: 'feat/version-change', baseRef: 'HEAD~1' });
    assert.equal(result.status, 'HOLD');
    assert.ok(result.failures.some(message => message.includes('changed package version')));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('release manifest must be external, READY, allowed, and pinned to HEAD', () => {
  const headSha = git(ROOT, 'rev-parse', 'HEAD');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const fixture = tempDirectory();
  try {
    const manifestPath = path.join(fixture, 'release-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'zylos.release-manifest/v1',
        releaseId: 'ZYL-TEST-01',
        status: 'READY',
        deploymentAllowed: true,
        candidate: {
          feishu: {
            repo: 'HeXiaobo/zylos-feishu',
            version,
            sha: headSha,
          },
        },
      }),
    );
    const result = validateReleaseManifest({
      root: ROOT,
      manifestPath,
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.deepEqual(result.failures, []);

    const resultFromEnvironment = validateReleaseManifest({
      root: ROOT,
      env: { ZYLOS_RELEASE_MANIFEST: manifestPath },
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.deepEqual(resultFromEnvironment.failures, []);

    const blocked = validateReleaseManifest({
      root: ROOT,
      manifestPath,
      headSha: '0'.repeat(40),
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.ok(blocked.failures.some(message => message.includes('does not match current HEAD')));

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'zylos.release-manifest/v1',
        releaseId: 'ZYL-TEST-WRONG-REPO',
        status: 'READY',
        deploymentAllowed: true,
        feishu: { repo: 'HeXiaobo/not-zylos-feishu', version, sha: headSha },
      }),
    );
    const wrongRepo = validateReleaseManifest({
      root: ROOT,
      manifestPath,
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.ok(wrongRepo.failures.some(message => message.includes('repository must identify')));

    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'zylos.release-manifest/v1',
        releaseId: 'ZYL-TEST-WRONG-OWNER',
        status: 'READY',
        deploymentAllowed: true,
        feishu: { repo: 'OtherOwner/zylos-feishu', version, sha: headSha },
      }),
    );
    const wrongOwner = validateReleaseManifest({
      root: ROOT,
      manifestPath,
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.ok(wrongOwner.failures.some(message => message.includes('must equal HeXiaobo/zylos-feishu')));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('release CLI accepts a global v2 manifest without a per-agent target', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestPath = path.join(tempDirectory(), 'release-manifest-v2.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(globalV2Manifest({
      headSha: git(fixtureRoot, 'rev-parse', 'HEAD'),
      status: 'HOLD',
      deploymentAllowed: false,
    })));
    const output = execFileSync(
      process.execPath,
      [
        'scripts/agent-governance-check.js',
        'release',
        '--branch',
        'release/0.3.7-rc.12',
        '--manifest',
        manifestPath,
      ],
      { cwd: fixtureRoot, encoding: 'utf8' },
    );
    const report = JSON.parse(output);
    assert.equal(report.status, 'PASS', report.failures?.join('\n'));
    assert.equal(report.manifest, manifestPath);
  } finally {
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 deploy keeps status, evidence, and identity gates', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestPath = path.join(tempDirectory(), 'deploy-manifest-v2.json');
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(globalV2Manifest({
      headSha: git(fixtureRoot, 'rev-parse', 'HEAD'),
      evidence: {
        pairReport: { status: 'PASS' },
        canary: 'PASS',
        hxa: { status: 'PASS' },
      },
    })));
    const result = runGovernance({
      root: fixtureRoot,
      mode: 'deploy',
      branch: 'release/0.3.7-rc.12',
      manifestPath,
    });
    assert.equal(result.status, 'HOLD');
    assert.ok(result.failures.some(message => message.includes('target.agent')));
  } finally {
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 still rejects an unpinned or mismatched candidate component', () => {
  const headSha = git(ROOT, 'rev-parse', 'HEAD');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const fixture = tempDirectory();
  try {
    const manifestPath = path.join(fixture, 'release-manifest-v2.json');
    fs.writeFileSync(manifestPath, JSON.stringify(globalV2Manifest({
      headSha: '0'.repeat(40),
      version: `${version}-tampered`,
    })));
    const result = validateReleaseManifest({
      root: ROOT,
      manifestPath,
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.ok(result.failures.some(message => message.includes('does not match package.json')));
    assert.ok(result.failures.some(message => message.includes('does not match current HEAD')));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('global v2 requires the candidate branch to match the deployable source policy', () => {
  const headSha = git(ROOT, 'rev-parse', 'HEAD');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const fixture = tempDirectory();
  try {
    const manifestPath = path.join(fixture, 'release-manifest-v2.json');
    const manifest = globalV2Manifest({ headSha, version });
    manifest.candidate.feishu.branch = 'codex/unpublished-candidate';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = validateReleaseManifest({
      root: ROOT,
      manifestPath,
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: version,
    });
    assert.ok(result.failures.some(message => message.includes('does not match deployable branch')));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('deploy readiness requires pair evidence, provenance, canary, and exact target identity fields', () => {
  const blocked = validateDeploymentReadiness({ evidence: {}, target: {} });
  assert.ok(blocked.some(message => message.includes('pairReport')));
  assert.ok(blocked.some(message => message.includes('canary=PASS')));
  assert.ok(blocked.some(message => message.includes('hxaProvenance=PASS')));
  assert.ok(blocked.some(message => message.includes('target.agent')));
  assert.ok(blocked.some(message => message.includes('target.profileId')));
  assert.ok(blocked.some(message => message.includes('target.hostname')));

  assert.deepEqual(validateDeploymentReadiness({
    evidence: { pairReport: '/reports/pair.json', canary: 'PASS', hxaProvenance: 'PASS' },
    target: { agent: 'yueran', profileId: 'profile-id', hostname: 'runtime-host' },
  }), []);
});

test('in-repository manifests are rejected instead of self-referencing a commit', () => {
  const fixture = tempDirectory();
  try {
    const headSha = 'a'.repeat(40);
    const manifestPath = path.join(fixture, 'release-manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'zylos.release-manifest/v1',
        releaseId: 'ZYL-TEST-IN-REPO',
        status: 'READY',
        deploymentAllowed: true,
        feishu: { repo: 'HeXiaobo/zylos-feishu', version: '0.3.6', sha: headSha },
      }),
    );
    const result = validateReleaseManifest({
      root: fixture,
      manifestPath,
      headSha,
      packageName: 'zylos-feishu',
      packageVersion: '0.3.6',
    });
    assert.ok(result.failures.some(message => message.includes('external to the repository')));
    assert.ok(result.failures.some(message => message.includes('self-reference')));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('CLI argument parsing supports mode, base, manifest, and environment handoff', () => {
  assert.deepEqual(parseArgs(['release', '--base', 'origin/main', '--manifest', '/tmp/release.json']), {
    mode: 'release',
    baseRef: 'origin/main',
    manifestPath: '/tmp/release.json',
  });
  assert.deepEqual(parseArgs(['--mode=deploy', '--manifest-path=/tmp/release.json']), {
    mode: 'deploy',
    manifestPath: '/tmp/release.json',
  });
});
