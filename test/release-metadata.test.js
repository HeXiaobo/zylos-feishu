import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('3AI release metadata', () => {
  it('keeps the package, skill manifest, and fork upgrade route aligned', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const capabilities = JSON.parse(fs.readFileSync(path.join(ROOT, 'capabilities.json'), 'utf8'));
    const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');

    assert.equal(pkg.version, '0.3.7-3ai.2');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(capabilities.release, pkg.version);
    assert.equal(pkg.repository.url, 'git+https://github.com/HeXiaobo/zylos-feishu.git');
    assert.equal(pkg.engines.node, '>=20.20.0');
    assert.match(skill, /^version: 0\.3\.7-3ai\.2$/m);
    assert.match(skill, /^  repo: HeXiaobo\/zylos-feishu$/m);
    assert.match(skill, /^  branch: codex\/mylos-capability-bundle-rc$/m);
  });
});
