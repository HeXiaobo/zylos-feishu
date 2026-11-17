// 2026-11-17 生产 T11172125-6m6p 的第 3 号缺陷：`src/index.js` 里调了
// `executeC4Receive(...)`，而**那个函数从来没有定义过**。飞书回调一到就抛
// `ReferenceError`，被 runtime 的 catch 包成「这张单没接住这次点击，请直接在
// 聊天里回复」；`components/feishu/logs/error.log` 里 21:26:46 / 21:26:52 /
// 21:28:09 / 21:56:09 四条都是它。
//
// 为什么所有单元测试都没抓到：
//   - `module-load.test.js` 只加载 `src/lib/`，不加载 `index.js`（它 import 时
//     会启动组件）；
//   - `ask-card-runtime.test.js` 测的是 `handle()`，`receive` 是注入的桩，桩
//     当然存在；
//   - `node --check` 只查语法，不查标识符有没有定义。
//
// 这条测试补的正是这个空档：拿 `index.js` 的源码做一次轻量静态扫描，把每个
// 被当成函数调用的本地标识符，逐个对「它在本文件里有没有定义」。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

// 语言关键字、回调参数、以及运行时自带的全局：它们不是本文件的函数，
// 不该被要求定义。（`error` / `resolve` / `reject` / `onReject` 是回调形参名，
// 会以 `(error, stdout) =>` 这种形状出现，不是裸调用；列在这里是给正则留余量。）
const NOT_LOCAL_FUNCTIONS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
  'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw',
  'super', 'import', 'require', 'yield', 'async', 'static', 'get', 'set', 'class',
  'constructor',
  // 全局构造函数 / 全局函数
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Buffer',
  'Symbol', 'BigInt', 'JSON', 'Math', 'Intl', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'Headers', 'Request', 'Response',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
  'structuredClone', 'fetch', 'atob', 'btoa',
  // 回调形参（出现时不是本文件定义的函数）
  'error', 'err', 'resolve', 'reject', 'onReject', 'callback', 'onError', 'fn',
]);

/**
 * 本文件定义过的函数名：`function foo` / `async function foo` / `const foo =`
 * （含 `const foo = async (`、`const foo = (…)=>`）。
 */
function definedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]);
  }
  // `import { a, b as c } from …` 与 `import x from …` 也算定义。
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(match[1]);
  for (const match of source.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(':').pop()?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/**
 * 被当成函数调用的标识符：`foo(` 且不是 `.foo(`（成员调用）、不是 `new foo(`。
 *
 * 只认「像本地函数」的那种写法：`await foo(`、`foo(...)`、`= foo(`。成员调用
 * （`client.im.x(`、`obj.method(`）不属于本文件定义的函数，一律不看。
 */
function calledNames(source) {
  // 去掉注释与字符串，免得把注释里的 `foo(` 也当成调用。
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  const names = new Set();
  for (const match of stripped.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(match[1]);
  }
  return names;
}

test('index.js 里每个被调用的本地标识符都有定义（executeC4Receive 型缺陷）', () => {
  const defined = definedNames(SOURCE);
  const called = calledNames(SOURCE);
  const undefinedCalls = [...called]
    .filter(name => !defined.has(name) && !NOT_LOCAL_FUNCTIONS.has(name))
    // 形如 `x.y(` 的已经被前面的 lookbehind 排除；剩下的都是裸调用。
    .sort();

  assert.deepEqual(undefinedCalls, [],
    `index.js 调用了本文件里不存在的函数：${undefinedCalls.join(', ')}\n`
    + '这类错误 node --check 查不出、单测也不加载 index.js，只有飞书回调真的来了才会抛。');
});

test('扫描本身有效：故意混进一个不存在的调用必须被抓到', () => {
  // 反向锁：上面的断言不能永远为真。若扫描写坏了（比如正则不匹配了），
  // 这条会红，提醒「测试已经不再证明任何事」。
  const bogus = `${SOURCE}\nasync function probe() { await definitelyNotDefinedAnywhere(1); }\n`;
  const defined = definedNames(bogus);
  const called = calledNames(bogus);
  const undefinedCalls = [...called].filter(name => !defined.has(name) && !NOT_LOCAL_FUNCTIONS.has(name));
  assert.ok(undefinedCalls.includes('definitelyNotDefinedAnywhere'),
    'the scanner must catch a call to a function that is not defined');
  // 也别把成员调用误报成未定义。
  const withMember = `${SOURCE}\nfunction probe2() { listMessages(); client.im.message.create(); }\n`;
  const memberCalls = calledNames(withMember);
  assert.equal(memberCalls.has('create'), false, 'member calls are not local functions');
  assert.equal(memberCalls.has('listMessages'), true, 'bare calls are');
});

test('askCardRuntime().receive 走的是那份会等结果的投递实现，不是流水式发出去就完', () => {
  // 「投没投出去」必须能被 `handle()` 用到，否则卡片会改成「已选」而答复其实
  // 没进 C4 —— 那是另一种假话。
  const receive = SOURCE.slice(SOURCE.indexOf('function askCardRuntime()'), SOURCE.indexOf('function executeTicketCli'));
  // 只看代码行：注释里会提到旧名字「为什么曾经错」，那不算是调用。
  const code = receive
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.ok(code.includes('deliverToC4('), 'the tap must use the awaited delivery helper');
  assert.equal(code.includes('executeC4Receive'), false, 'the undefined call must be gone');
  assert.match(code, /if \(!delivery\.delivered\)\s*\{?\s*throw/s,
    'a delivery that did not land must throw, so the toast says it failed');
  // callback-ticket-id 要带进去，否则归不了单。
  assert.match(SOURCE, /metadata\.callbackTicketId/);
});
