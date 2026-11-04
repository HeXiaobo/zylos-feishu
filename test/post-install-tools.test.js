/**
 * The Feishu business tools are a separate install decision from the Feishu
 * messaging channel (zylos-core issue #132).
 *
 * Contract under test:
 *   - ZYLOS_FEISHU_TOOLS=off/0/false/no/none/disabled skips lark-cli, its
 *     skills and the credential sync;
 *   - unset keeps the pre-split behaviour (legacy entry points);
 *   - the old import path (`post-install-shared.js`) still exports the steps;
 *   - `hooks/post-install.js` itself exits 0 and installs nothing when off.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  installLarkCliTools,
  toolsEnabled,
} from '../hooks/post-install-tools.js';
import * as shared from '../hooks/post-install-shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.resolve(HERE, '..', 'hooks');

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('toolsEnabled: only an explicit off value disables the toolset', () => {
  for (const value of ['off', 'OFF', ' 0 ', 'false', 'No', 'none', 'disabled']) {
    assert.equal(toolsEnabled({ ZYLOS_FEISHU_TOOLS: value }), false, value);
  }
  for (const value of ['on', '1', 'true', 'yes', '']) {
    assert.equal(toolsEnabled({ ZYLOS_FEISHU_TOOLS: value }), true, value);
  }
  // Unset is the legacy entry point: keep installing the tools.
  assert.equal(toolsEnabled({}), true);
});

test('the old import path keeps exporting the lark-cli steps', () => {
  for (const name of ['installLarkCliBinary', 'installLarkCliSkills',
    'syncCredentialsToLarkCli', 'installLarkCliTools', 'toolsEnabled']) {
    assert.equal(typeof shared[name], 'function', name);
  }
});

test('installLarkCliTools runs nothing when the tools are off', () => {
  const home = tempDir('feishu-tools-off-');
  const lines = [];
  const log = { log: (message) => lines.push(message) };
  const previousPath = process.env.PATH;
  process.env.PATH = home; // no npm / lark-cli: any exec attempt would throw
  try {
    const result = installLarkCliTools({
      skillDir: path.join(home, 'skills'),
      env: { ZYLOS_FEISHU_TOOLS: 'off' },
      log,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'tools_disabled');
  } finally {
    process.env.PATH = previousPath;
  }
  assert.match(lines.join('\n'), /business tools not selected/);
});

test('installLarkCliTools installs the three steps when enabled', () => {
  const home = tempDir('feishu-tools-on-');
  const bin = path.join(home, 'bin');
  const calls = path.join(home, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  // Stub lark-cli at the version package.json pins, so no npm install happens.
  fs.writeFileSync(path.join(bin, 'lark-cli'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "lark-cli 1.0.81"; exit 0; fi',
    `printf 'argv=%s\\n' "$*" >> '${calls}'`,
    `cat >> '${calls}'`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  // All bundled sub-skills present at the same version: the skills step is a no-op.
  const skillDir = path.join(home, 'zylos-feishu');
  const references = path.join(skillDir, 'references');
  fs.mkdirSync(references, { recursive: true });
  for (const name of [
    'lark-apps', 'lark-approval', 'lark-attendance', 'lark-base', 'lark-calendar',
    'lark-contact', 'lark-doc', 'lark-drive', 'lark-event', 'lark-im', 'lark-mail',
    'lark-markdown', 'lark-minutes', 'lark-note', 'lark-okr', 'lark-openapi-explorer',
    'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task',
    'lark-vc', 'lark-vc-agent', 'lark-whiteboard', 'lark-wiki',
    'lark-workflow-meeting-summary', 'lark-workflow-standup-report',
  ]) {
    fs.mkdirSync(path.join(references, name), { recursive: true });
    fs.writeFileSync(path.join(references, name, 'SKILL.md'), '---\nname: x\n---\n');
  }
  fs.writeFileSync(path.join(references, '.lark-cli-version'), '1.0.81\n');

  const envFile = path.join(home, 'zylos', '.env');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, 'FEISHU_APP_ID=cli_fixture\nFEISHU_APP_SECRET=fixture-secret\n');

  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const result = installLarkCliTools({
      skillDir,
      env: { HOME: home, ZYLOS_FEISHU_TOOLS: 'on' },
      envFile,
      log: { log: () => {} },
    });
    assert.equal(result.skipped, false);
  } finally {
    process.env.PATH = previousPath;
  }
  const text = fs.readFileSync(calls, 'utf8');
  assert.match(text, /argv=config init --app-id cli_fixture --app-secret-stdin/);
  assert.match(text, /fixture-secret/); // piped through stdin, never argv
  assert.doesNotMatch(text, /--app-secret fixture-secret/);
});

test('post-install.js honours the switch and needs no zylos-core when off', () => {
  const home = tempDir('feishu-hook-off-');
  fs.mkdirSync(path.join(home, 'zylos'), { recursive: true });
  const result = spawnSync(process.execPath, [path.join(HOOKS, 'post-install.js')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ZYLOS_FEISHU_TOOLS: 'off', PATH: '/usr/bin:/bin' },
    input: '',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /business tools not selected/);
  assert.doesNotMatch(result.stdout, /lark-cli not found/);
  const config = path.join(home, 'zylos', 'components', 'feishu', 'config.json');
  assert.ok(fs.existsSync(config), 'the messaging component is still set up');
});

test('post-install.js keeps the legacy behaviour when the switch is unset', () => {
  const home = tempDir('feishu-hook-legacy-');
  fs.mkdirSync(path.join(home, 'zylos'), { recursive: true });
  // No `zylos` on PATH: the pre-split guard aborts, proving the tool path ran.
  const result = spawnSync(process.execPath, [path.join(HOOKS, 'post-install.js')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' },
    input: '',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /requires zylos-core/);
});
