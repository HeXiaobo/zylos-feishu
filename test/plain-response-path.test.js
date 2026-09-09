import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');

test('the streaming path honors message.useMarkdownCard like the c4-send path (issue #57)', () => {
  // The response stream factory must receive a preferPlainPlaceholder getter,
  // so useMarkdownCard=false covers the runtime streaming path too instead of
  // only scripts/send.js (c4-send). The getter form keeps the admin hot-reload
  // toggle effective without a process restart.
  assert.match(
    indexSource,
    /preferPlainPlaceholder: \(\) => config\.message\?\.useMarkdownCard === false,/,
  );
});

function jsSources(directory) {
  const sources = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...jsSources(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      sources.push({
        file: path.relative(REPO_ROOT, full),
        source: fs.readFileSync(full, 'utf8'),
      });
    }
  }
  return sources;
}

// Extract the argument text of every real factory call. The scan balances
// brackets while skipping strings and comments, so prose can neither fake a
// call site nor break the bracket count. The factory's own definition
// (`export function createConversationResponseStream({`) is not a call site.
function factoryCallArgumentTexts(source) {
  const marker = 'createConversationResponseStream(';
  const texts = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    if (!/function\s*$/.test(source.slice(Math.max(0, index - 9), index))) {
      const args = balancedSlice(source, index + marker.length - 1);
      if (args === null) throw new Error(`unbalanced factory call near offset ${index}`);
      texts.push(args);
    }
    index = source.indexOf(marker, index + marker.length);
  }
  return texts;
}

function balancedSlice(source, openParen) {
  let depth = 0;
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }
  return null;
}

test('every production response-stream construction passes a delivery mode (issue #61)', () => {
  const callSites = [];
  for (const directory of ['src', 'scripts']) {
    for (const { file, source } of jsSources(path.join(REPO_ROOT, directory))) {
      for (const args of factoryCallArgumentTexts(source)) {
        callSites.push({ file, args });
      }
    }
  }
  // Positive control: the known live construction points must all be found.
  // A rename or a removed entrypoint would otherwise empty this check into a
  // vacuous pass, so fewer than the expected call sites is a failure, not a
  // silent skip.
  assert.equal(callSites.length, 4);
  assert.deepEqual(
    [...new Set(callSites.map(site => site.file))].sort(),
    ['scripts/send.js', 'scripts/stream.js', 'src/index.js'],
  );
  for (const { file, args } of callSites) {
    assert.match(
      args,
      /preferPlainPlaceholder\s*:/,
      `${file}: a response stream construction ignores the delivery mode`,
    );
    assert.doesNotMatch(
      args,
      /preferPlainPlaceholder\s*:\s*false\b/,
      `${file}: the delivery mode is hard-wired to the inert default`,
    );
  }
});
