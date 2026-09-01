import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
      core: {
        repo: 'HeXiaobo/zylos-core',
        branch: 'main',
        version: '0.7.2-rc.22',
        sha: '2'.repeat(40),
      },
      feishu: {
        repo: 'HeXiaobo/zylos-feishu',
        branch: 'main',
        version,
        sha: headSha,
      },
      hxa: {
        repo: 'HeXiaobo/zylos-hxa-connect',
        branch: 'main',
        packageVersion: '1.7.8',
        sha: '3'.repeat(40),
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
        publicationAuthorized: true,
        deploymentAuthorized: true,
        scope: 'GLOBAL_BUNDLE',
        bundle: {
          coreSha: '2'.repeat(40),
          feishuSha: headSha,
          hxaSha: '3'.repeat(40),
        },
      },
    },
    holdReasons: [],
    ...overrides,
  };
}

function runGovernanceCli(root, mode, manifestPath) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/agent-governance-check.js',
      mode,
      '--branch',
      'release/0.3.7-rc.12',
      '--manifest',
      manifestPath,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`governance CLI did not return JSON: ${error.message}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, report };
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

test('global v2 CLI selects only candidate.feishu and never a legacy fallback', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-selector-');
  const candidate = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') }).candidate.feishu;
  try {
    for (const [index, fallback] of ['components', 'release', 'feishu', 'component', 'stable'].entries()) {
      const manifest = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') });
      delete manifest.candidate.feishu;
      if (fallback === 'components' || fallback === 'release' || fallback === 'stable') {
        manifest[fallback] = { feishu: candidate };
      } else {
        manifest[fallback] = candidate;
      }
      const manifestPath = path.join(manifestDir, `fallback-${index}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
      assert.equal(result.report.status, 'HOLD', `${fallback} unexpectedly supplied the v2 component`);
      assert.ok(
        result.report.failures.some(message => message.includes('no zylos-feishu component entry')),
        `${fallback} fallback was not rejected: ${result.report.failures.join('; ')}`,
      );
    }
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 CLI keeps root status and permissions authoritative', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-root-state-');
  const manifestPath = path.join(manifestDir, 'manifest.json');
  try {
    const manifest = globalV2Manifest({
      headSha: git(fixtureRoot, 'rev-parse', 'HEAD'),
      status: 'HOLD',
      deploymentAllowed: false,
    });
    manifest.candidate.feishu.status = 'READY';
    manifest.candidate.feishu.deploymentAllowed = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
    assert.equal(result.report.status, 'PASS', result.report.failures?.join('\n'));
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 CLI fails closed for incomplete owner authorization', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-owner-auth-');
  try {
    const cases = [
      {
        name: 'missing-authorization-flag',
        mutate: authorization => {
          delete authorization.publicationAuthorized;
          delete authorization.releaseAuthorized;
        },
        expected: 'publicationAuthorized (or releaseAuthorized) must be true',
      },
      {
        name: 'missing-scope',
        mutate: authorization => delete authorization.scope,
        expected: 'scope must authorize the global bundle',
      },
      {
        name: 'missing-core-sha',
        mutate: authorization => delete authorization.bundle.coreSha,
        expected: 'bundle.coreSha must be a complete 40-character SHA',
      },
      {
        name: 'mismatched-hxa-sha',
        mutate: authorization => {
          authorization.bundle.hxaSha = 'f'.repeat(40);
        },
        expected: 'bundle.hxaSha does not match candidate',
      },
    ];
    for (const item of cases) {
      const manifest = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') });
      item.mutate(manifest.evidence.ownerAuthorization);
      const manifestPath = path.join(manifestDir, `${item.name}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
      assert.equal(result.report.status, 'HOLD', item.name);
      assert.ok(
        result.report.failures.some(message => message.includes(item.expected)),
        `${item.name}: ${result.report.failures.join('; ')}`,
      );
    }
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 publication accepts release authorization as the explicit owner grant', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-release-auth-');
  const manifestPath = path.join(manifestDir, 'release-authorized.json');
  try {
    const manifest = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') });
    delete manifest.evidence.ownerAuthorization.publicationAuthorized;
    manifest.evidence.ownerAuthorization.releaseAuthorized = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
    assert.equal(result.report.status, 'PASS', result.report.failures?.join('\n'));
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 CLI requires an exact source policy, branch, and deployment contract', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-contract-');
  try {
    const cases = [
      {
        name: 'missing-source-policy',
        mutate: manifest => delete manifest.sourcePolicy,
        expected: 'sourcePolicy.deployableBranch is required',
      },
      {
        name: 'non-main-source-policy',
        mutate: manifest => {
          manifest.sourcePolicy.deployableBranch = 'refs/heads/main';
        },
        expected: 'sourcePolicy.deployableBranch must be main',
      },
      {
        name: 'missing-pair-components',
        mutate: manifest => delete manifest.deploymentContract.pairComponents,
        expected: 'pairComponents must be exactly',
      },
      {
        name: 'missing-hxa-required',
        mutate: manifest => delete manifest.deploymentContract.hxaRequired,
        expected: 'hxaRequired must be true',
      },
      {
        name: 'candidate-branch-mismatch',
        mutate: manifest => {
          manifest.candidate.feishu.branch = 'codex/unpublished-candidate';
        },
        expected: 'does not match deployable branch',
      },
    ];
    for (const item of cases) {
      const manifest = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') });
      item.mutate(manifest);
      const manifestPath = path.join(manifestDir, `${item.name}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
      assert.equal(result.report.status, 'HOLD', item.name);
      assert.ok(
        result.report.failures.some(message => message.includes(item.expected)),
        `${item.name}: ${result.report.failures.join('; ')}`,
      );
    }
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 CLI rejects an evil repository host despite a matching path suffix', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-repository-');
  const manifestPath = path.join(manifestDir, 'evil.json');
  try {
    const manifest = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') });
    manifest.candidate.feishu.repo = 'https://evil.example/HeXiaobo/zylos-feishu.git';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
    assert.equal(result.report.status, 'HOLD');
    assert.ok(result.report.failures.some(message => message.includes('GitHub repository')));
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 CLI rejects an evil origin even when the manifest path looks correct', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-origin-');
  const manifestPath = path.join(manifestDir, 'origin.json');
  try {
    git(fixtureRoot, 'remote', 'add', 'origin', 'https://evil.example/HeXiaobo/zylos-feishu.git');
    const manifest = globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runGovernanceCli(fixtureRoot, 'release', manifestPath);
    assert.equal(result.report.status, 'HOLD');
    assert.ok(result.report.failures.some(message => message.includes('repository origin')));
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 accepts legitimate GitHub repository URL forms', () => {
  const headSha = git(ROOT, 'rev-parse', 'HEAD');
  const fixture = tempDirectory();
  const forms = [
    'HeXiaobo/zylos-feishu',
    'https://github.com/HeXiaobo/zylos-feishu.git',
    'git+https://github.com/HeXiaobo/zylos-feishu.git',
    'ssh://git@github.com/HeXiaobo/zylos-feishu.git',
    'git@github.com:HeXiaobo/zylos-feishu.git',
  ];
  try {
    for (const [index, repo] of forms.entries()) {
      const manifestPath = path.join(fixture, `${index}.json`);
      const manifest = globalV2Manifest({ headSha });
      manifest.candidate.feishu.repo = repo;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = validateReleaseManifest({
        root: ROOT,
        manifestPath,
        headSha,
        packageName: 'zylos-feishu',
        packageVersion: '0.3.7-rc.12',
      });
      assert.deepEqual(result.failures, [], `${repo}: ${result.failures.join('; ')}`);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
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
    assert.ok(result.failures.some(message => message.includes('globalPreflight')));
  } finally {
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true });
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('global v2 component deploy consumes a global preflight receipt instead of a manifest target', () => {
  const releaseId = 'ZYL-TEST-V2-FEISHU';
  const manifest = {
    schema: 'zylos.release-manifest/v2',
    releaseId,
    evidence: {
      pairReport: { status: 'PASS' },
      canary: 'PASS',
      hxa: { status: 'PASS' },
      globalPreflight: {
        schema: 'zylos.agent-preflight/v1',
        mode: 'deploy',
        status: 'PASS',
        releaseId,
        runtimeTarget: {
          agent: 'yueran',
          profileId: 'profile-id',
          hostname: 'runtime-host',
        },
      },
    },
  };
  assert.deepEqual(validateDeploymentReadiness(manifest), []);
  delete manifest.evidence.globalPreflight;
  const blocked = validateDeploymentReadiness(manifest);
  assert.ok(blocked.some(message => message.includes('globalPreflight')));
  assert.ok(!blocked.some(message => message.includes('target.agent')));
});

test('global v2 component deploy passes with a release-bound global preflight receipt', () => {
  const fixtureRoot = governanceCliFixture();
  const manifestDir = tempDirectory('zylos-feishu-v2-deploy-receipt-');
  const manifestPath = path.join(manifestDir, 'manifest.json');
  try {
    const manifest = globalV2Manifest({
      headSha: git(fixtureRoot, 'rev-parse', 'HEAD'),
      evidence: {
        ...globalV2Manifest({ headSha: git(fixtureRoot, 'rev-parse', 'HEAD') }).evidence,
        pairReport: { status: 'PASS' },
        canary: 'PASS',
        hxa: { status: 'PASS' },
        globalPreflight: {
          schema: 'zylos.agent-preflight/v1',
          mode: 'deploy',
          status: 'PASS',
          releaseId: 'ZYL-TEST-V2-FEISHU',
          runtimeTarget: {
            agent: 'yueran',
            profileId: 'profile-id',
            hostname: 'runtime-host',
          },
        },
      },
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = runGovernanceCli(fixtureRoot, 'deploy', manifestPath);
    assert.equal(result.report.status, 'PASS', result.report.failures?.join('\n'));
  } finally {
    fs.rmSync(manifestDir, { recursive: true, force: true });
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
