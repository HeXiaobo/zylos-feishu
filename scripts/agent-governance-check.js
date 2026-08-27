#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
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

function componentEntry(manifest, packageName) {
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

function componentVersion(component) {
  for (const key of ['version', 'packageVersion', 'release']) {
    if (typeof component?.[key] === 'string') return component[key];
  }
  return undefined;
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
  if (manifest.schema !== 'zylos.release-manifest/v1') {
    failures.push('release manifest schema must be zylos.release-manifest/v1');
  }
  if (!nonEmptyString(manifest.releaseId)) failures.push('release manifest releaseId is required');
  if (manifest.status !== 'READY') {
    failures.push(`release manifest status must be READY (found ${manifest.status ?? 'missing'})`);
  }
  if (manifest.deploymentAllowed !== true) {
    failures.push('release manifest deploymentAllowed must be true');
  }

  const component = componentEntry(manifest, packageName);
  if (!component) {
    failures.push(`release manifest has no ${packageName} component entry`);
    return { failures, manifestPath: resolvedPath, manifest, component: null, sha: null };
  }
  const repo = component.repo ?? component.repository;
  const repoPath = normalizeRepository(repo);
  const repoName = repoPath.split('/').at(-1);
  if (!nonEmptyString(repo) || repoName !== packageName) {
    failures.push(`release manifest repository must identify ${packageName}`);
  }
  const requiredRepo = normalizeRepository(expectedRepository)
    || normalizeRepository(git(root, ['remote', 'get-url', 'origin'], true))
    || normalizeRepository(parseJson(readText(path.join(root, 'package.json')))?.repository);
  if (requiredRepo && repoPath !== requiredRepo) {
    failures.push(`release manifest repository must equal ${requiredRepo} (found ${repoPath || 'missing'})`);
  }
  const version = componentVersion(component);
  if (!nonEmptyString(version)) {
    failures.push(`release manifest ${packageName} version is required`);
  } else if (packageVersion !== undefined && version !== packageVersion) {
    failures.push(`release manifest version ${version} does not match package.json ${packageVersion}`);
  }
  const sha = componentSha(component);
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

  return { failures, manifestPath: resolvedPath, manifest, component, sha: sha || null };
}

export function validateDeploymentReadiness(manifest) {
  const failures = [];
  if (!nonEmptyString(manifest?.evidence?.pairReport)) {
    failures.push('deploy mode requires evidence.pairReport');
  }
  if (manifest?.evidence?.canary !== 'PASS') {
    failures.push(`deploy mode requires evidence.canary=PASS (found ${manifest?.evidence?.canary ?? 'missing'})`);
  }
  if (manifest?.evidence?.hxaProvenance !== 'PASS') {
    failures.push(`deploy mode requires evidence.hxaProvenance=PASS (found ${manifest?.evidence?.hxaProvenance ?? 'missing'})`);
  }
  if (!nonEmptyString(manifest?.target?.agent)) failures.push('deploy mode requires target.agent');
  if (!nonEmptyString(manifest?.target?.profileId)) failures.push('deploy mode requires target.profileId');
  if (!nonEmptyString(manifest?.target?.hostname)) failures.push('deploy mode requires target.hostname');
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
