// R4（2026-11-17 部署时发现）：一个只在 import 阶段就炸的错误，所有单元测试
// 都没抓到——`ask-card-message.js` 从 `./message.js` import `MESSAGE_GET_PARAMS`，
// 而那个常量当时只定义在 `index.js` 里。测试只 import 了 `ask-card-runtime.js`
// （纯逻辑，不碰飞书 API），于是 `node --test` 全绿，进程一起来就
// `SyntaxError: The requested module './message.js' does not provide an export
// named 'MESSAGE_GET_PARAMS'`，飞书长连接直接断。
//
// 这条测试只做一件事：把组件里每个会 import 别人的模块都真加载一遍。ESM 的
// 导出检查发生在加载时，所以缺导出、拼错路径、循环依赖都会在这里炸出来，
// 而不是等到部署。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = new URL('../src/', import.meta.url);

/** 源码树里每个 .js，除了入口（import 时会有副作用）。 */
function modules(dir = SRC, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) modules(full, found);
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

test('every module under src/lib imports cleanly', async () => {
  const files = modules(new URL('lib/', SRC));
  assert.ok(files.length > 20, `expected the lib tree, found ${files.length} files`);
  const failed = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file.pathname).href);
    } catch (error) {
      failed.push(`${path.relative(new URL('../', import.meta.url).pathname, file.pathname)}: ${error.message}`);
    }
  }
  assert.deepEqual(failed, [], `these modules do not load:\n${failed.join('\n')}`);
});

test('index.js parses and its own imports resolve', async () => {
  // index.js starts the component on import, so it is read and its import
  // specifiers are resolved by hand rather than executed. What we are pinning is
  // exactly what broke: a named import that the target does not export.
  const source = fs.readFileSync(new URL('index.js', SRC), 'utf8');
  const named = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)];
  assert.ok(named.length > 10, `expected index.js to import from several modules, found ${named.length}`);
  const problems = [];
  for (const [, clause, spec] of named) {
    const target = pathToFileURL(path.resolve(SRC.pathname, spec)).href;
    let mod;
    try { mod = await import(target); } catch (error) { problems.push(`${spec}: ${error.message}`); continue; }
    for (const raw of clause.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!(name in mod)) problems.push(`${spec} does not export '${name}'`);
    }
  }
  assert.deepEqual(problems, [], `index.js has broken imports:\n${problems.join('\n')}`);
});
