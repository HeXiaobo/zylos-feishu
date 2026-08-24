import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveZylosCli } from '../src/lib/zylos-cli-resolver.js';

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-zylos-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function executableFixture(root, relativePath) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return target;
}

test('uses an executable explicit ZYLOS_CLI_PATH as the execFile program', (t) => {
  const root = fixtureRoot(t);
  const configured = executableFixture(root, 'custom/zylos');

  assert.equal(resolveZylosCli({
    env: {
      HOME: root,
      PATH: '',
      ZYLOS_CLI_PATH: configured,
    },
  }), configured);
});

test('fails closed when an explicit ZYLOS_CLI_PATH is not executable', (t) => {
  const root = fixtureRoot(t);
  const configured = path.join(root, 'custom/zylos');
  fs.mkdirSync(path.dirname(configured), { recursive: true });
  fs.writeFileSync(configured, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
  executableFixture(root, 'zylos/bin/zylos');

  assert.throws(
    () => resolveZylosCli({
      env: {
        HOME: root,
        PATH: '',
        ZYLOS_CLI_PATH: configured,
      },
    }),
    error => error?.code === 'ZYLOS_CLI_UNAVAILABLE'
      && error.message === 'ZYLOS_CLI_PATH is not executable',
  );
});

test('rejects a relative explicit path instead of resolving it from process cwd', () => {
  assert.throws(
    () => resolveZylosCli({
      env: {
        HOME: '/tmp/unused-home',
        PATH: '',
        ZYLOS_CLI_PATH: 'relative/bin/zylos',
      },
    }),
    error => error?.code === 'ZYLOS_CLI_UNAVAILABLE'
      && error.message === 'ZYLOS_CLI_PATH must be an absolute path',
  );
});

test('prefers the deployed ~/zylos/bin/zylos over npm-global when no override is set', (t) => {
  const root = fixtureRoot(t);
  const deployed = executableFixture(root, 'zylos/bin/zylos');
  executableFixture(root, '.npm-global/bin/zylos');

  assert.equal(resolveZylosCli({
    env: {
      HOME: root,
      PATH: '',
    },
  }), deployed);
});

test('uses an executable ~/.npm-global/bin/zylos when the deployed path is absent', (t) => {
  const root = fixtureRoot(t);
  const npmGlobal = executableFixture(root, '.npm-global/bin/zylos');

  assert.equal(resolveZylosCli({
    env: {
      HOME: root,
      PATH: '',
    },
  }), npmGlobal);
});

test('ignores an executable directory and continues to the next CLI candidate', (t) => {
  const root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, 'zylos/bin/zylos'), { recursive: true, mode: 0o700 });
  const npmGlobal = executableFixture(root, '.npm-global/bin/zylos');

  assert.equal(resolveZylosCli({
    env: {
      HOME: root,
      PATH: '',
    },
  }), npmGlobal);
});

test('resolves an executable zylos from PATH to an absolute execFile program', (t) => {
  const root = fixtureRoot(t);
  const fromPath = executableFixture(root, 'path-bin/zylos');

  assert.equal(resolveZylosCli({
    env: {
      HOME: path.join(root, 'empty-home'),
      PATH: path.dirname(fromPath),
    },
  }), fromPath);
});

test('fails closed when no executable CLI candidate exists', (t) => {
  const root = fixtureRoot(t);

  assert.throws(
    () => resolveZylosCli({
      env: {
        HOME: root,
        PATH: '.:relative-bin:',
      },
    }),
    error => error?.code === 'ZYLOS_CLI_UNAVAILABLE'
      && error.message === 'Zylos CLI executable was not found',
  );
});
