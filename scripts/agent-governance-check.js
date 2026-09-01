#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const PREFLIGHT_SCHEMA = 'zylos.agent-preflight/v1';
const PUBLICATION_AUTHORIZATION_SCHEMA = 'zylos.release-publication-authorization/v1';
const PUBLICATION_SCOPE = 'RELEASE_GLOBAL_BUNDLE';
const SHA256 = /^[0-9a-f]{64}$/;
const PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;
const PREFLIGHT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256File(filename) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  } catch {
    return undefined;
  }
}

function canonicalIsoTimestamp(value) {
  if (!nonEmptyString(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function freshIsoTimestamp(value, now = Date.now()) {
  if (!canonicalIsoTimestamp(value)) return false;
  const timestamp = Date.parse(value);
  return timestamp >= now - PREFLIGHT_MAX_AGE_MS && timestamp <= now + PREFLIGHT_MAX_FUTURE_SKEW_MS;
}

function readJsonFile(filename) {
  const text = readText(filename);
  if (text === undefined) return { value: undefined, error: new Error('file is not readable') };
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: undefined, error };
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

function actualBranch(root) {
  return git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true) || '';
}

function normalizeBranch(branch) {
  return String(branch ?? '').replace(/^refs\/heads\//, '').trim();
}

function currentBranch(root, env = process.env) {
  const supplied = env.ZYLOS_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (nonEmptyString(supplied)) return normalizeBranch(supplied);
  return actualBranch(root);
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

function validateEvidencePath(label, reportPath, failures) {
  if (!nonEmptyString(reportPath) || !path.isAbsolute(reportPath)) {
    failures.push(`${label}.report must be an absolute path`);
    return undefined;
  }
  if (!fs.existsSync(reportPath)) {
    failures.push(`${label}.report does not exist: ${reportPath}`);
    return undefined;
  }
  return path.normalize(reportPath);
}

function candidateBundle(manifest) {
  return {
    coreSha: candidateSha(manifest?.candidate?.core, manifest?.schema),
    feishuSha: candidateSha(manifest?.candidate?.feishu, manifest?.schema),
    hxaSha: candidateSha(manifest?.candidate?.hxa, manifest?.schema),
  };
}

function validateExactCandidateBundle(label, bundle, expected, failures) {
  if (!isObject(bundle)) {
    failures.push(`${label} must be an object`);
    return;
  }
  const expectedKeys = Object.keys(expected).sort();
  if (stableJson(Object.keys(bundle).sort()) !== stableJson(expectedKeys)) {
    failures.push(`${label} must contain exactly coreSha, feishuSha, and hxaSha`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (!FULL_SHA.test(bundle[field] || '')) {
      failures.push(`${label}.${field} must be a complete 40-character SHA`);
    } else if (bundle[field] !== value) {
      failures.push(`${label}.${field} does not match candidate`);
    }
  }
}

function withoutReportBinding(authorization) {
  if (!isObject(authorization)) return authorization;
  const { report: _report, reportSha256: _reportSha256, ...body } = authorization;
  return body;
}

function validateV2OwnerAuthorization(manifest, failures, { mode }) {
  const label = 'evidence.ownerAuthorization';
  const authorization = manifest?.evidence?.ownerAuthorization;
  if (!isObject(authorization)) {
    failures.push(`v2 ${mode} manifest ${label} is required`);
    return;
  }

  if (authorization.schema !== PUBLICATION_AUTHORIZATION_SCHEMA) {
    failures.push(`v2 ${mode} manifest ${label}.schema must be ${PUBLICATION_AUTHORIZATION_SCHEMA}`);
  }
  if (authorization.status !== 'PASS') {
    failures.push(`v2 ${mode} manifest ${label}.status must be PASS (found ${authorization.status ?? 'missing'})`);
  }
  if (authorization.releaseId !== manifest.releaseId) {
    failures.push(`v2 ${mode} manifest ${label}.releaseId does not match releaseId`);
  }
  if (authorization.identity !== 'user') {
    failures.push(`v2 ${mode} manifest ${label}.identity must be user`);
  }
  if (!nonEmptyString(authorization.authorizedBy)) {
    failures.push(`v2 ${mode} manifest ${label}.authorizedBy is required`);
  }
  if (!nonEmptyString(authorization.authorizationRef)) {
    failures.push(`v2 ${mode} manifest ${label}.authorizationRef is required`);
  }
  if (!canonicalIsoTimestamp(authorization.authorizedAt)) {
    failures.push(`v2 ${mode} manifest ${label}.authorizedAt must be a canonical ISO timestamp`);
  }
  if (authorization.publicationAuthorized !== true) {
    failures.push(`v2 ${mode} manifest ${label}.publicationAuthorized must be true`);
  }
  if (authorization.scope !== PUBLICATION_SCOPE) {
    failures.push(`v2 ${mode} manifest ${label}.scope must be exactly ${PUBLICATION_SCOPE}`);
  }
  if (mode === 'deploy' && authorization.deploymentAuthorized !== true) {
    failures.push(`v2 deploy manifest ${label}.deploymentAuthorized must be true`);
  }

  validateExactCandidateBundle(`${mode} manifest ${label}.bundle`, authorization.bundle, candidateBundle(manifest), failures);

  const reportPath = validateEvidencePath(`v2 ${mode} manifest ${label}`, authorization.report, failures);
  if (!SHA256.test(authorization.reportSha256 || '')) {
    failures.push(`v2 ${mode} manifest ${label}.reportSha256 must be a 64-character lowercase SHA-256`);
  }
  if (!reportPath || !SHA256.test(authorization.reportSha256 || '')) return;
  const actualHash = sha256File(reportPath);
  if (actualHash !== authorization.reportSha256) {
    failures.push(`v2 ${mode} manifest ${label}.reportSha256 mismatch`);
    return;
  }
  const parsed = readJsonFile(reportPath);
  if (parsed.error) {
    failures.push(`v2 ${mode} manifest ${label}.report is not valid JSON: ${parsed.error.message}`);
    return;
  }
  if (!isObject(parsed.value)) {
    failures.push(`v2 ${mode} manifest ${label}.report must be an object`);
    return;
  }
  if (stableJson(parsed.value) !== stableJson(withoutReportBinding(authorization))) {
    failures.push(`v2 ${mode} manifest ${label}.report body does not match authorization`);
  }
}

function validatePreflightReceipt(manifest, failures, { mode }) {
  const key = mode === 'deploy' ? 'globalPreflight' : 'workspacePublish';
  const receiptType = mode === 'deploy' ? 'workspace-deploy' : 'workspace-publish';
  const label = `${mode} mode requires evidence.${key}`;
  const envelope = manifest?.evidence?.[key];
  if (!isObject(envelope)) {
    failures.push(`${label} receipt with an absolute report and SHA-256`);
    return;
  }
  if (envelope.receiptType !== receiptType) {
    failures.push(`${label}.receiptType must be ${receiptType}`);
  }
  const reportPath = validateEvidencePath(label, envelope.report, failures);
  if (!SHA256.test(envelope.reportSha256 || '')) {
    failures.push(`${label}.reportSha256 must be a 64-character lowercase SHA-256`);
  }
  if (!reportPath || !SHA256.test(envelope.reportSha256 || '')) return;
  if (sha256File(reportPath) !== envelope.reportSha256) {
    failures.push(`${label}.reportSha256 mismatch`);
    return;
  }
  const parsed = readJsonFile(reportPath);
  if (parsed.error) {
    failures.push(`${label}.report is not valid JSON: ${parsed.error.message}`);
    return;
  }
  const receipt = parsed.value;
  if (!isObject(receipt)) {
    failures.push(`${label}.report must be an object`);
    return;
  }
  if (receipt.schema !== PREFLIGHT_SCHEMA) failures.push(`${label}.report.schema must be ${PREFLIGHT_SCHEMA}`);
  if (receipt.receiptType !== receiptType) failures.push(`${label}.report.receiptType must be ${receiptType}`);
  if (receipt.mode !== mode) failures.push(`${label}.report.mode must be ${mode}`);
  if (receipt.status !== 'PASS') failures.push(`${label}.report.status must be PASS (found ${receipt.status ?? 'missing'})`);
  if (receipt.releaseId !== manifest.releaseId) failures.push(`${label}.report.releaseId must match releaseId`);
  if (receipt.targetMode !== 'global') failures.push(`${label}.report.targetMode must be global`);
  const expectedBundle = candidateBundle(manifest);
  validateExactCandidateBundle(`${label}.report.candidateBundle`, receipt.candidateBundle, expectedBundle, failures);

  const expectedGate = mode === 'deploy' ? 'FINALIZE' : 'PUBLICATION';
  if (receipt.gate !== expectedGate) failures.push(`${label}.report.gate must be ${expectedGate}`);
  if (mode === 'deploy') {
    if (receipt.deploymentStage !== 'final') failures.push(`${label}.report.deploymentStage must be final`);
    if (receipt.deploymentAllowed !== true) failures.push(`${label}.report.deploymentAllowed must be true`);
    if (receipt.publicationAllowed !== true) failures.push(`${label}.report.publicationAllowed must be true`);
  } else {
    if (receipt.deploymentStage !== null && receipt.deploymentStage !== undefined) {
      failures.push(`${label}.report.deploymentStage must be null for publication`);
    }
    if (receipt.publicationAllowed !== true) failures.push(`${label}.report.publicationAllowed must be true`);
    if (typeof receipt.deploymentAllowed !== 'boolean') failures.push(`${label}.report.deploymentAllowed must be boolean`);
  }
  if (!freshIsoTimestamp(receipt.generatedAt)) {
    failures.push(`${label}.report.generatedAt must be a fresh canonical ISO timestamp`);
  }

  if (mode !== 'deploy') return;
  const runtimeTarget = receipt.runtimeTarget;
  if (!isObject(runtimeTarget)) {
    failures.push(`${label}.report.runtimeTarget is required`);
    return;
  }
  for (const field of ['agent', 'profileId', 'hostname', 'deploymentOrgLabel', 'deploymentProfileId']) {
    if (!nonEmptyString(runtimeTarget[field])) failures.push(`${label}.report.runtimeTarget.${field} is required`);
  }
  if (!canonicalIsoTimestamp(runtimeTarget.identityObservedAt) || !freshIsoTimestamp(runtimeTarget.identityObservedAt)) {
    failures.push(`${label}.report.runtimeTarget.identityObservedAt must be a fresh canonical ISO timestamp`);
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
    validateV2OwnerAuthorization(manifest, failures, { mode });
    if (mode === 'release') validatePreflightReceipt(manifest, failures, { mode: 'publish' });
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
  const configuredRepository = isV2
    ? originRepository
    : (expectedRepository || originRepository || packageRepository);
  const requiredRepo = isV2 ? githubRepository(configuredRepository) : normalizeRepository(configuredRepository);
  if (isV2) {
    if (!originRepository) {
      failures.push(`repository origin must identify GitHub repository ${V2_REPOSITORY}`);
    } else if (githubRepository(originRepository) !== V2_REPOSITORY) {
      failures.push(`repository origin must identify GitHub repository ${V2_REPOSITORY} (found ${githubRepository(originRepository) || 'invalid'})`);
    }
    if (requiredRepo && requiredRepo !== V2_REPOSITORY) {
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
    if (isV2) {
      const originMain = git(root, ['rev-parse', '--verify', 'origin/main^{commit}'], true);
      if (!originMain) {
        failures.push('v2 release manifest requires a resolvable origin/main for ancestry validation');
      } else {
        try {
          execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', sha, 'origin/main'], {
            stdio: 'ignore',
          });
        } catch {
          failures.push(`release manifest SHA ${sha} must be an ancestor of origin/main`);
        }
      }
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
    if (requireTarget) validatePreflightReceipt(manifest, failures, { mode: 'deploy' });
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
  const immutableMode = normalizedMode === 'release' || normalizedMode === 'deploy';
  const observedBranch = actualBranch(root);
  const suppliedCiBranches = [
    branch,
    env.ZYLOS_BRANCH,
    env.GITHUB_HEAD_REF,
    env.GITHUB_REF_NAME,
    env.GITHUB_REF,
  ]
    .filter(nonEmptyString)
    .map(normalizeBranch);
  const resolvedBranch = immutableMode ? observedBranch : (branch ?? currentBranch(root, env));
  if (immutableMode) {
    for (const suppliedBranch of suppliedCiBranches) {
      if (suppliedBranch !== observedBranch) {
        failures.push(`CI branch ref ${suppliedBranch} does not match actual symbolic-ref/HEAD ${observedBranch || '(detached HEAD)'}`);
      }
    }
  }
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
      expectedRepository: git(root, ['remote', 'get-url', 'origin'], true),
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
