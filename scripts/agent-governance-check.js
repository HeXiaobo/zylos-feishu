#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_MANIFEST_V1 = 'zylos.release-manifest/v1';
const RELEASE_MANIFEST_V2 = 'zylos.release-manifest/v2';
const V2_REPOSITORY = 'HeXiaobo/zylos-feishu';
const MODES = new Set(['check', 'inspect', 'release', 'deploy']);
const VERSION_KEYS = Object.freeze([
  'package',
  'lock',
  'lockRoot',
  'capabilities',
  'skill',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRepository(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  if (!nonEmptyString(raw)) return '';
  const normalized = raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : normalized;
}

/**
 * Parse a repository identity without trusting path suffixes from arbitrary
 * hosts.  The v2 release contract names the GitHub fork explicitly, while
 * v1 keeps the historical permissive normalizer for compatibility.
 */
function githubRepository(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  if (!nonEmptyString(raw)) return '';
  let text = raw.trim().replace(/^git\+/, '').replace(/\/+$/, '');

  if (/^[^/\\\s:]+\/[^/\\\s:]+(?:\.git)?$/i.test(text)) {
    return text.replace(/\.git$/i, '');
  }

  const scp = /^git@github\.com:([^/\\\s]+\/[^/\\\s]+)$/i.exec(text);
  if (scp) return scp[1].replace(/\.git$/i, '');

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'github.com') {
    return '';
  }
  if (parsed.search || parsed.hash) return '';
  if (parsed.protocol === 'https:' && (parsed.username || parsed.password)) return '';
  if (parsed.protocol === 'ssh:' && parsed.username && parsed.username !== 'git') return '';
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return '';
  return `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
}

function readText(filename) {
  try {
    return fs.readFileSync(filename, 'utf8');
  } catch {
    return undefined;
  }
}

function parseJson(text) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function skillVersion(text) {
  if (typeof text !== 'string') return undefined;
  const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text)?.[1];
  if (!frontmatter) return undefined;
  return /^version:\s*([^\s#]+)\s*$/m.exec(frontmatter)?.[1];
}

function extractVersionValues(files) {
  const pkg = parseJson(files.packageText);
  const lock = parseJson(files.lockText);
  const capabilities = parseJson(files.capabilitiesText);
  const values = {
    package: pkg?.version,
    lock: lock?.version,
    lockRoot: lock?.packages?.['']?.version,
    capabilities: capabilities?.release ?? capabilities?.version,
    skill: skillVersion(files.skillText),
  };
  return { pkg, lock, capabilities, values };
}

/**
 * Read and validate the release metadata that travels with a Feishu package.
 * The function is deliberately independent of git so it can be used by tests
 * and by other repository tooling.
 */
export function validateReleaseMetadata(root = ROOT) {
  const files = {
    packageText: readText(path.join(root, 'package.json')),
    lockText: readText(path.join(root, 'package-lock.json')),
    capabilitiesText: readText(path.join(root, 'capabilities.json')),
    skillText: readText(path.join(root, 'SKILL.md')),
  };
  const { pkg, lock, capabilities, values } = extractVersionValues(files);
  const failures = [];

  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    failures.push('package.json is missing or invalid JSON');
  }
  if (!nonEmptyString(pkg?.name)) failures.push('package.json name is required');
  if (!nonEmptyString(pkg?.version) || !VERSION.test(pkg.version)) {
    failures.push('package.json version must be a valid semantic version');
  }

  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    failures.push('package-lock.json is missing or invalid JSON');
  }
  if (lock?.name !== pkg?.name) {
    failures.push(
      `package-lock.json name (${lock?.name ?? 'missing'}) does not match package.json (${pkg?.name ?? 'missing'})`,
    );
  }
  if (lock?.packages?.['']?.name !== pkg?.name) {
    failures.push(
      `package-lock.json root package name (${lock?.packages?.['']?.name ?? 'missing'}) does not match package.json (${pkg?.name ?? 'missing'})`,
    );
  }
  if (lock?.version !== pkg?.version) {
    failures.push(
      `package-lock.json version (${lock?.version ?? 'missing'}) does not match package.json (${pkg?.version ?? 'missing'})`,
    );
  }
  if (lock?.packages?.['']?.version !== pkg?.version) {
    failures.push(
      `package-lock.json root package version (${lock?.packages?.['']?.version ?? 'missing'}) does not match package.json (${pkg?.version ?? 'missing'})`,
    );
  }

  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    failures.push('capabilities.json is missing or invalid JSON');
  }
  const capabilityVersion = capabilities?.release ?? capabilities?.version;
  if (!nonEmptyString(capabilityVersion)) {
    failures.push('capabilities.json release (or version) is required');
  }
  if (
    capabilities?.release !== undefined &&
    capabilities?.version !== undefined &&
    capabilities.release !== capabilities.version
  ) {
    failures.push('capabilities.json release and version disagree');
  }
  if (capabilities?.product !== undefined && capabilities.product !== pkg?.name) {
    failures.push(
      `capabilities.json product (${capabilities.product}) does not match package.json name (${pkg?.name ?? 'missing'})`,
    );
  }
  if (capabilityVersion !== pkg?.version) {
    failures.push(
      `capabilities.json release (${capabilityVersion ?? 'missing'}) does not match package.json (${pkg?.version ?? 'missing'})`,
    );
  }

  if (values.skill === undefined) {
    failures.push('SKILL.md frontmatter version is missing');
  } else if (values.skill !== pkg?.version) {
    failures.push(`SKILL.md version (${values.skill}) does not match package.json (${pkg?.version ?? 'missing'})`);
  }

  return {
    failures,
    packageName: pkg?.name ?? null,
    packageVersion: pkg?.version ?? null,
    values,
    package: pkg,
    repository: normalizeRepository(pkg?.repository),
    lock,
    capabilities,
  };
}

export function classifyBranch(branch) {
  const normalized = String(branch ?? '').replace(/^refs\/heads\//, '').trim();
  if (/^(main|master)$/.test(normalized)) return 'protected';
  if (/^(release|hotfix)\/[^/]+$/.test(normalized)) return 'release';
  if (
    /^(feat|feature|fix|bugfix|chore|docs|refactor|test|tests|codex|agent|issue|experiment|wip)\/.+$/i.test(
      normalized,
    )
  ) {
    return 'functional';
  }
  if (!normalized) return 'detached';
  return 'unknown';
}

function git(root, args, allowFailure = false) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return undefined;
    throw error;
  }
}

function currentHead(root) {
  return git(root, ['rev-parse', 'HEAD'], true);
}

function currentBranch(root, env = process.env) {
  const supplied = env.ZYLOS_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (nonEmptyString(supplied)) return supplied.replace(/^refs\/heads\//, '').trim();
  return git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true) || '';
}

function baseRef(root, supplied, env = process.env) {
  const requested = supplied || env.ZYLOS_GOVERNANCE_BASE || env.GITHUB_BASE_REF;
  if (nonEmptyString(requested)) {
    const candidate = requested.replace(/^refs\/heads\//, '');
    if (git(root, ['rev-parse', '--verify', `${candidate}^{commit}`], true)) return candidate;
    if (git(root, ['rev-parse', '--verify', `origin/${candidate}^{commit}`], true)) {
      return `origin/${candidate}`;
    }
    return candidate;
  }
  if (git(root, ['rev-parse', '--verify', 'origin/main^{commit}'], true)) return 'origin/main';
  if (git(root, ['rev-parse', '--verify', 'main^{commit}'], true)) return 'main';
  return undefined;
}

function gitFile(root, ref, filename) {
  return git(root, ['show', `${ref}:${filename}`], true);
}

function compareWithBase(root, ref, current, failures) {
  if (!ref) {
    failures.push('functional branch requires a resolvable base ref (use --base or ZYLOS_GOVERNANCE_BASE)');
    return;
  }
  const baseFiles = {
    packageText: gitFile(root, ref, 'package.json'),
    lockText: gitFile(root, ref, 'package-lock.json'),
    capabilitiesText: gitFile(root, ref, 'capabilities.json'),
    skillText: gitFile(root, ref, 'SKILL.md'),
  };
  const { values: baseValues } = extractVersionValues(baseFiles);
  if (!nonEmptyString(baseValues.package)) {
    failures.push(`base ref ${ref} has no valid package.json version`);
    return;
  }

  if (current.values.package !== baseValues.package) {
    failures.push(
      `functional branch changed package version relative to ${ref}: ${baseValues.package} -> ${current.values.package ?? 'missing'}`,
    );
  }
  for (const key of VERSION_KEYS.slice(1)) {
    const currentValue = current.values[key];
    if (currentValue === undefined) continue;
    const expected = baseValues[key] ?? baseValues.package;
    if (currentValue !== expected) {
      failures.push(
        `functional branch changed ${key} release metadata relative to ${ref}: ${expected ?? 'missing'} -> ${currentValue}`,
      );
    }
  }
}

function resolveManifestPath(manifestPath, env = process.env) {
  const requested = manifestPath || env.ZYLOS_RELEASE_MANIFEST;
  if (!nonEmptyString(requested)) return undefined;
  return path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(process.cwd(), requested);
}

function pathInside(root, candidate) {
  const rootReal = fs.realpathSync.native(root);
  let candidateReal = path.resolve(candidate);
  try {
    candidateReal = fs.realpathSync.native(candidateReal);
  } catch {
    // The caller reports the more useful missing-file error below.
  }
  const relative = path.relative(rootReal, candidateReal);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function componentEntry(manifest, packageName, schema) {
  if (schema === RELEASE_MANIFEST_V2) {
    // Global v2 has one canonical component location.  Do not fall back to
    // stable, target, or legacy top-level shapes: those can silently select a
    // different immutable source than the owner authorized.
    return manifest?.candidate?.feishu && isObject(manifest.candidate.feishu)
      ? manifest.candidate.feishu
      : undefined;
  }
  const candidates = [
    manifest?.candidate?.[packageName],
    manifest?.candidate?.feishu,
    manifest?.components?.[packageName],
    manifest?.components?.feishu,
    manifest?.release?.[packageName],
    manifest?.release?.feishu,
    manifest?.release,
    manifest?.[packageName],
    manifest?.feishu,
    manifest?.component,
    manifest?.target?.[packageName],
    manifest?.target?.feishu,
    manifest?.target,
  ];
  const found = candidates.find(value => value && typeof value === 'object' && !Array.isArray(value));
  if (found) return found;
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    if (manifest.sha || manifest.fullSha || manifest.commitSha || manifest.targetSha) return manifest;
  }
  return undefined;
}

function componentSha(component) {
  for (const key of ['sha', 'fullSha', 'commitSha', 'targetSha', 'headSha']) {
    if (typeof component?.[key] === 'string') return component[key];
  }
  for (const key of ['commit', 'source', 'target']) {
    if (component?.[key] && typeof component[key] === 'object') {
      const nested = componentSha(component[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function candidateSha(component, schema) {
  if (schema === RELEASE_MANIFEST_V2) {
    return typeof component?.sha === 'string' ? component.sha : undefined;
  }
  return componentSha(component);
}

function componentVersion(component) {
  for (const key of ['version', 'packageVersion', 'release']) {
    if (typeof component?.[key] === 'string') return component[key];
  }
  return undefined;
}

function validateGlobalPreflightEvidence(manifest, failures) {
  const label = 'deploy mode requires evidence.globalPreflight';
  const receipt = manifest?.evidence?.globalPreflight;
  if (!isObject(receipt)) {
    failures.push(`${label}.status=PASS (global identity is owned by workspace preflight)`);
    return;
  }
  if (receipt.schema !== 'zylos.agent-preflight/v1') {
    failures.push(`${label}.schema must be zylos.agent-preflight/v1`);
  }
  if (receipt.mode !== 'deploy') {
    failures.push(`${label}.mode must be deploy`);
  }
  if (receipt.status !== 'PASS') {
    failures.push(`${label}.status=PASS (found ${receipt.status ?? 'missing'})`);
  }
  if (receipt.releaseId !== manifest?.releaseId) {
    failures.push(`${label}.releaseId must match releaseId`);
  }
  const runtimeTarget = receipt.runtimeTarget;
  if (!isObject(runtimeTarget)) {
    failures.push(`${label}.runtimeTarget is required`);
    return;
  }
  for (const field of ['agent', 'profileId', 'hostname']) {
    if (!nonEmptyString(runtimeTarget[field])) {
      failures.push(`${label}.runtimeTarget.${field} is required`);
    }
  }
}

/**
 * Validate an immutable external release manifest for this component.
 * A manifest is accepted only when it names this package and the exact HEAD.
 */
export function validateReleaseManifest({
  root = ROOT,
  manifestPath,
  env = process.env,
  headSha = currentHead(root),
  packageName = 'zylos-feishu',
  packageVersion,
  expectedRepository,
  mode = 'release',
} = {}) {
  const failures = [];
  const resolvedPath = resolveManifestPath(manifestPath, env);
  if (!resolvedPath) {
    failures.push('release/deploy mode requires --manifest PATH or ZYLOS_RELEASE_MANIFEST');
    return { failures, manifestPath: null, manifest: null, component: null, sha: null };
  }
  if (pathInside(root, resolvedPath)) {
    failures.push('release manifest must be external to the repository');
  }

  const text = readText(resolvedPath);
  if (text === undefined) {
    failures.push(`release manifest is not readable: ${resolvedPath}`);
    return { failures, manifestPath: resolvedPath, manifest: null, component: null, sha: null };
  }
  const manifest = parseJson(text);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    failures.push('release manifest must be a JSON object');
    return { failures, manifestPath: resolvedPath, manifest: null, component: null, sha: null };
  }
  const isV1 = manifest.schema === RELEASE_MANIFEST_V1;
  const isV2 = manifest.schema === RELEASE_MANIFEST_V2;
  if (!isV1 && !isV2) {
    failures.push(
      `release manifest schema must be ${RELEASE_MANIFEST_V1} or ${RELEASE_MANIFEST_V2}`,
    );
  }
  if (!nonEmptyString(manifest.releaseId)) failures.push('release manifest releaseId is required');
  if (isV2) {
    if (typeof manifest.deploymentAllowed !== 'boolean') {
      failures.push('v2 release manifest deploymentAllowed must be boolean');
    }
    if (manifest.publicationAllowed !== undefined && typeof manifest.publicationAllowed !== 'boolean') {
      failures.push('v2 release manifest publicationAllowed must be boolean');
    }
    if (!Array.isArray(manifest.holdReasons)) {
      failures.push('v2 release manifest holdReasons must be an array');
    } else if (manifest.status === 'READY' && manifest.holdReasons.length > 0) {
      failures.push('v2 release manifest READY must not contain holdReasons');
    }
    if (mode === 'release') {
      if (manifest.publicationAllowed !== true) {
        failures.push('v2 release manifest publicationAllowed must be true');
      }
      if (!['HOLD', 'READY'].includes(manifest.status)) {
        failures.push(`v2 release manifest status must be HOLD or READY (found ${manifest.status ?? 'missing'})`);
      }
      if (manifest.deploymentAllowed === true && manifest.status !== 'READY') {
        failures.push('v2 release manifest deploymentAllowed=true requires status=READY');
      }
    } else {
      if (manifest.status !== 'READY') {
        failures.push(`release manifest status must be READY (found ${manifest.status ?? 'missing'})`);
      }
      if (manifest.deploymentAllowed !== true) {
        failures.push('release manifest deploymentAllowed must be true');
      }
    }
  } else {
    if (manifest.status !== 'READY') {
      failures.push(`release manifest status must be READY (found ${manifest.status ?? 'missing'})`);
    }
    if (manifest.deploymentAllowed !== true) {
      failures.push('release manifest deploymentAllowed must be true');
    }
  }

  if (isV2) {
    const contract = manifest.deploymentContract;
    if (!isObject(contract)) {
      failures.push('v2 release manifest deploymentContract is required');
    } else {
      if (contract.targetMode !== 'global') {
        failures.push('v2 release manifest deploymentContract.targetMode must be global');
      }
      if (
        !Array.isArray(contract.pairComponents) ||
        contract.pairComponents.length !== 2 ||
        contract.pairComponents[0] !== 'core' ||
        contract.pairComponents[1] !== 'feishu'
      ) {
        failures.push("v2 release manifest deploymentContract.pairComponents must be exactly ['core','feishu']");
      }
      if (contract.hxaRequired !== true) {
        failures.push('v2 release manifest deploymentContract.hxaRequired must be true');
      }
    }
    if (manifest.target !== undefined) {
      failures.push('v2 global release manifest must not contain a per-agent target');
    }
  }

  const component = componentEntry(manifest, packageName, manifest.schema);
  if (!component) {
    failures.push(`release manifest has no ${packageName} component entry`);
    return { failures, manifestPath: resolvedPath, manifest, component: null, sha: null };
  }

  if (isV2 && (mode === 'release' || mode === 'deploy')) {
    const authorization = manifest.evidence?.ownerAuthorization;
    if (!isObject(authorization)) {
      failures.push('v2 release manifest evidence.ownerAuthorization is required');
    } else {
      if (authorization.status !== 'PASS') {
        failures.push(`v2 release manifest evidence.ownerAuthorization.status must be PASS (found ${authorization.status ?? 'missing'})`);
      }
      if (authorization.identity !== 'user') {
        failures.push('v2 release manifest evidence.ownerAuthorization.identity must be user');
      }
      if (authorization.publicationAuthorized !== true && authorization.releaseAuthorized !== true) {
        failures.push('v2 release manifest evidence.ownerAuthorization.publicationAuthorized (or releaseAuthorized) must be true');
      }
      if (!nonEmptyString(authorization.scope) || !authorization.scope.includes('GLOBAL_BUNDLE')) {
        failures.push('v2 release manifest evidence.ownerAuthorization.scope must authorize the global bundle');
      }
      if (mode === 'deploy' && authorization.deploymentAuthorized !== true) {
        failures.push('v2 deploy manifest evidence.ownerAuthorization.deploymentAuthorized must be true');
      }
      if (!isObject(authorization.bundle)) {
        failures.push('v2 release manifest evidence.ownerAuthorization.bundle is required');
      } else {
        const expectedBundle = {
          coreSha: candidateSha(manifest.candidate?.core, manifest.schema),
          feishuSha: candidateSha(manifest.candidate?.feishu, manifest.schema),
          hxaSha: candidateSha(manifest.candidate?.hxa, manifest.schema),
        };
        for (const [field, candidateSha] of Object.entries(expectedBundle)) {
          const authorizedSha = authorization.bundle[field];
          if (!FULL_SHA.test(authorizedSha || '')) {
            failures.push(`v2 release manifest evidence.ownerAuthorization.bundle.${field} must be a complete 40-character SHA`);
          } else if (authorizedSha !== candidateSha) {
            failures.push(`v2 release manifest evidence.ownerAuthorization.bundle.${field} does not match candidate`);
          }
        }
      }
    }
  }
  if (isV2) {
    const componentBranch = component.branch;
    if (!nonEmptyString(componentBranch)) {
      failures.push(`release manifest ${packageName} branch is required`);
    }
    if (!isObject(manifest.sourcePolicy) || !nonEmptyString(manifest.sourcePolicy.deployableBranch)) {
      failures.push('v2 release manifest sourcePolicy.deployableBranch is required');
    } else if (manifest.sourcePolicy.deployableBranch !== 'main') {
      failures.push('v2 release manifest sourcePolicy.deployableBranch must be main');
    } else if (componentBranch !== manifest.sourcePolicy.deployableBranch) {
      failures.push(`release manifest branch ${componentBranch} does not match deployable branch ${manifest.sourcePolicy.deployableBranch}`);
    }
  }
  const repo = component.repo ?? component.repository;
  const repoPath = isV2 ? githubRepository(repo) : normalizeRepository(repo);
  const repoName = repoPath.split('/').at(-1);
  if (isV2) {
    if (repoPath !== V2_REPOSITORY) {
      failures.push(`release manifest repository must identify GitHub repository ${V2_REPOSITORY}`);
    }
  } else if (!nonEmptyString(repo) || repoName !== packageName) {
    failures.push(`release manifest repository must identify ${packageName}`);
  }
  const originRepository = git(root, ['remote', 'get-url', 'origin'], true);
  const packageRepository = parseJson(readText(path.join(root, 'package.json')))?.repository;
  const configuredRepository = expectedRepository || originRepository || packageRepository;
  const requiredRepo = isV2 ? githubRepository(configuredRepository) : normalizeRepository(configuredRepository);
  if (isV2) {
    if (originRepository && githubRepository(originRepository) !== V2_REPOSITORY) {
      failures.push(`repository origin must identify GitHub repository ${V2_REPOSITORY} (found ${githubRepository(originRepository) || 'invalid'})`);
    }
    if (!configuredRepository) {
      failures.push(`repository origin must identify GitHub repository ${V2_REPOSITORY}`);
    } else if (requiredRepo !== V2_REPOSITORY) {
      failures.push(`repository origin must identify GitHub repository ${V2_REPOSITORY} (found ${requiredRepo || 'invalid'})`);
    }
    if (requiredRepo && repoPath !== requiredRepo) {
      failures.push(`release manifest repository must equal ${requiredRepo} (found ${repoPath || 'missing'})`);
    }
  } else if (requiredRepo && repoPath !== requiredRepo) {
    failures.push(`release manifest repository must equal ${requiredRepo} (found ${repoPath || 'missing'})`);
  }
  const version = componentVersion(component);
  if (!nonEmptyString(version)) {
    failures.push(`release manifest ${packageName} version is required`);
  } else if (packageVersion !== undefined && version !== packageVersion) {
    failures.push(`release manifest version ${version} does not match package.json ${packageVersion}`);
  }
  const sha = candidateSha(component, manifest.schema);
  if (!FULL_SHA.test(sha || '')) {
    failures.push(`release manifest ${packageName} SHA must be a complete 40-character SHA`);
  } else {
    if (!FULL_SHA.test(headSha || '')) {
      failures.push('current HEAD is not a complete 40-character SHA');
    } else if (sha !== headSha) {
      failures.push(`release manifest SHA ${sha} does not match current HEAD ${headSha}`);
    }
    if (pathInside(root, resolvedPath) && sha === headSha) {
      failures.push('in-repository release manifest must not self-reference current HEAD');
    }
  }

  return {
    failures,
    manifestPath: resolvedPath,
    manifest,
    component,
    sha: sha || null,
    schema: manifest.schema,
    global: isV2,
  };
}

export function validateDeploymentReadiness(manifest, { requireTarget = true } = {}) {
  const failures = [];
  const isV2 = manifest?.schema === RELEASE_MANIFEST_V2;
  const pairReport = manifest?.evidence?.pairReport;
  if (isV2) {
    if (!isObject(pairReport) || pairReport.status !== 'PASS') {
      failures.push(`deploy mode requires evidence.pairReport.status=PASS (found ${pairReport?.status ?? 'missing'})`);
    }
  } else if (!nonEmptyString(pairReport)) {
    failures.push('deploy mode requires evidence.pairReport');
  }
  if (manifest?.evidence?.canary !== 'PASS') {
    failures.push(`deploy mode requires evidence.canary=PASS (found ${manifest?.evidence?.canary ?? 'missing'})`);
  }
  if (isV2) {
    if (!isObject(manifest?.evidence?.hxa) || manifest.evidence.hxa.status !== 'PASS') {
      failures.push(`deploy mode requires evidence.hxa.status=PASS (found ${manifest?.evidence?.hxa?.status ?? 'missing'})`);
    }
  } else if (manifest?.evidence?.hxaProvenance !== 'PASS') {
    failures.push(`deploy mode requires evidence.hxaProvenance=PASS (found ${manifest?.evidence?.hxaProvenance ?? 'missing'})`);
  }
  if (isV2) {
    // A global manifest intentionally has no target.  The workspace preflight
    // owns the fresh host/profile probe; this component gate only accepts its
    // release-bound receipt and never invents a per-agent target.
    if (requireTarget) validateGlobalPreflightEvidence(manifest, failures);
  } else {
    if (requireTarget && !nonEmptyString(manifest?.target?.agent)) {
      failures.push('deploy mode requires target.agent');
    }
    if (requireTarget && !nonEmptyString(manifest?.target?.profileId)) {
      failures.push('deploy mode requires target.profileId');
    }
    if (requireTarget && !nonEmptyString(manifest?.target?.hostname)) {
      failures.push('deploy mode requires target.hostname');
    }
  }
  return failures;
}

function worktreeDirty(root) {
  return git(root, ['status', '--porcelain=v1', '--untracked-files=all'], true) || '';
}

/**
 * Run the repository governance gate. `check`/`inspect` is safe for feature
 * work; `release` and `deploy` are fail-closed immutable-source gates.
 */
export function runGovernance({
  root = ROOT,
  mode = 'check',
  branch,
  base,
  baseRef: explicitBase,
  manifest,
  manifestPath,
  env = process.env,
} = {}) {
  const normalizedMode = mode === 'inspect' ? 'check' : mode;
  const failures = [];
  const warnings = [];
  if (!MODES.has(mode)) failures.push(`unsupported governance mode: ${mode}`);
  if (!['check', 'release', 'deploy'].includes(normalizedMode)) {
    failures.push(`unsupported governance mode: ${mode}`);
  }

  const metadata = validateReleaseMetadata(root);
  failures.push(...metadata.failures);
  const resolvedBranch = branch ?? currentBranch(root, env);
  const branchClass = classifyBranch(resolvedBranch);
  const headSha = currentHead(root) || null;
  const selectedBase = explicitBase ?? baseRef(root, base, env);

  if (branchClass === 'unknown' || branchClass === 'detached') {
    failures.push(`branch cannot be classified for governance: ${resolvedBranch || '(detached HEAD)'}`);
  }
  if (!FULL_SHA.test(headSha || '')) failures.push('current HEAD must be a complete 40-character SHA');

  if (normalizedMode === 'check') {
    if (branchClass === 'functional') compareWithBase(root, selectedBase, metadata, failures);
  } else {
    if (!['protected', 'release'].includes(branchClass)) {
      failures.push(`${normalizedMode} mode is not allowed from ${branchClass} branch ${resolvedBranch || '(detached HEAD)'}`);
    }
    if (worktreeDirty(root)) failures.push(`${normalizedMode} mode requires a clean worktree`);
    const manifestResult = validateReleaseManifest({
      root,
      manifestPath: manifestPath ?? manifest,
      env,
      headSha,
      packageName: metadata.packageName || 'zylos-feishu',
      packageVersion: metadata.packageVersion,
      expectedRepository: git(root, ['remote', 'get-url', 'origin'], true) || metadata.repository,
      mode: normalizedMode,
    });
    failures.push(...manifestResult.failures);
    if (normalizedMode === 'deploy' && manifestResult.manifest) {
      failures.push(...validateDeploymentReadiness(manifestResult.manifest));
    }
    if (manifestResult.manifest?.releaseId) warnings.push(`releaseId=${manifestResult.manifest.releaseId}`);
  }

  return {
    schema: 'zylos.agent-governance/v1',
    mode: normalizedMode,
    repo: metadata.packageName || path.basename(root),
    root,
    branch: resolvedBranch || null,
    branchClass,
    base: selectedBase || null,
    headSha,
    version: metadata.packageVersion,
    manifest: normalizedMode === 'check' ? null : resolveManifestPath(manifestPath ?? manifest, env) || null,
    status: failures.length === 0 ? 'PASS' : 'HOLD',
    failures,
    warnings,
  };
}

function optionValue(args, index, option) {
  const value = args[index + 1];
  if (!nonEmptyString(value) || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

export function parseArgs(args) {
  let mode = 'check';
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--mode') {
      mode = optionValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    } else if (arg === '--manifest' || arg === '--manifest-path') {
      options.manifestPath = optionValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--manifest=')) {
      options.manifestPath = arg.slice('--manifest='.length);
    } else if (arg.startsWith('--manifest-path=')) {
      options.manifestPath = arg.slice('--manifest-path='.length);
    } else if (arg === '--base') {
      options.baseRef = optionValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--base=')) {
      options.baseRef = arg.slice('--base='.length);
    } else if (arg === '--branch') {
      options.branch = optionValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith('--branch=')) {
      options.branch = arg.slice('--branch='.length);
    } else if (!arg.startsWith('--') && mode === 'check') {
      mode = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!MODES.has(mode)) throw new Error(`unsupported governance mode: ${mode}`);
  return { mode, ...options };
}

function printUsage() {
  console.log('Usage: node scripts/agent-governance-check.js [check|release|deploy] [--base REF] [--manifest PATH]');
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
      return;
    }
    const report = runGovernance(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'PASS' ? 0 : 2;
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exitCode = 64;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
