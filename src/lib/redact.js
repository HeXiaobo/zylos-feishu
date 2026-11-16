/**
 * Log redaction.
 *
 * Keeps credentials out of the service logs (PM2 out.log / error.log):
 * app_secret, tenant/user/app access tokens, Authorization headers,
 * encrypt_key, verification_token and similar values.
 *
 * Where secrets come from:
 * - The Feishu/Lark SDK (@larksuiteoapi/node-sdk) logs caught errors through
 *   its logger. With the SDK's default logger a failed tenant-token request
 *   dumps the whole AxiosError, whose `config.data` is the JSON body `{"app_id":..,"app_secret":..}` and
 *   whose `config.headers` may carry `Authorization: Bearer <token>`.
 *   `createRedactingLogger()` is passed as `logger` to every SDK client
 *   (Client, WSClient, EventDispatcher) so those arguments are sanitized
 *   before they are printed.
 * - Webhook mode: the request handler never logs raw request bodies,
 *   headers or signatures; the console wrapper is the safety net.
 * - The service's own console output. `installConsoleRedaction()` wraps the
 *   console methods of the service process as a safety net.
 *
 * `redact()` returns a sanitized copy and never mutates its input. Errors
 * keep their name, message, stack, code, cause, AggregateError `errors` and
 * (for axios errors) method, url, status and response data, so the log stays
 * useful. The walk is bounded: arrays, Maps and Sets keep their first
 * MAX_ITEMS entries (plus a "… N more items" marker), objects their first
 * MAX_ITEMS keys, nesting stops at MAX_DEPTH and the whole copy at
 * MAX_NODES values. Shared references are copied once (a copy that was cut
 * off by the depth limit is not reused at a shallower level). Copies keep the
 * class name (`Foo { ... }`, `TypeError: ...`, null prototype), enumerable
 * symbol keys and the `[cause]` / `[errors]` presentation of the original.
 * The original's constructor and custom inspect are never called; property
 * getters, `constructor` / `name` reads and Proxy traps on it still run.
 *
 * The bare key `token` stays masked on purpose. It does sometimes hold a
 * harmless Feishu drive file token, but it is also the field that carries the
 * verification token in v1 event callbacks (`{"token": "..."}`) and the
 * generic name SDKs use for credentials, so a false positive (a masked file
 * id) is the cheaper mistake. Specific keys such as `file_token` or
 * `page_token` are not masked.
 */

import util from 'node:util';

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 6;
const MAX_ITEMS = 100;
const MAX_NODES = 5000;
const MIN_KNOWN_SECRET_LENGTH = 8;

// Object keys whose values are always redacted. Compared after lowercasing
// and removing '-' / '_', so `app_secret`, `appSecret` and `App-Secret` match.
const SENSITIVE_KEYS = new Set([
  'appsecret',
  'clientsecret',
  'secret',
  'accesstoken',
  'tenantaccesstoken',
  'useraccesstoken',
  'appaccesstoken',
  'refreshtoken',
  'token',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'encryptkey',
  'verificationtoken',
  'appticket',
  'ticket',
  'accesskey',
  'password',
  'secretkey',
  'apikey',
  'privatekey',
  'xinternaltoken',
]);

/** True when values stored under `key` must not be logged. */
export function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const k = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.has(k)
    || k.endsWith('secret')
    || k.endsWith('accesstoken')
    || k.endsWith('refreshtoken')
    || k.endsWith('secretkey')
    || k.endsWith('apikey')
    || k.endsWith('privatekey')
    || k.endsWith('password');
}

// Key names recognised inside free text: JSON bodies ("app_secret":"..."),
// inspected objects (app_secret: '...'), query strings (ticket=...), also
// percent-encoded (app%5Fsecret%3D...). `_` stands for an optional '_' or %5F.
const TEXT_KEYS = [
  'app_secret', 'client_secret', 'secret_key', 'api_key', 'private_key',
  '(?:tenant|user|app)_access_token', 'access_token', 'refresh_token',
  'encrypt_key', 'verification_token',
  'app_ticket', 'ticket', 'access_key',
  'x-internal-token', 'password', 'secret', 'token',
].map(k => k.replace(/_/g, '(?:_|%5F)?')).join('|');

// prefix: optional (escaped) quote, key, optional quote, ':' / '=' / %3D.
// value: \"escaped\" | "double" | 'single' | bare word (not already redacted).
const KEY_VALUE_RE = new RegExp(
  `((?:\\\\?["'])?\\b(?:${TEXT_KEYS})(?:\\\\?["'])?\\s*(?:[:=]|%3D)\\s*)`
  + `(?!["']\\s*,)`
  + `(\\\\"[^"]*?\\\\"|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|(?!\\[REDACTED\\])[^\\s,&;}'"\\]]+)`,
  'gi',
);
// Key and value in adjacent elements of an inspected array, as the SDK logs
// them (`logger.info('ticket:', v)` prints `[ 'ticket:', 'v' ]`).
const ELEMENT_KEY_VALUE_RE = new RegExp(
  `(\\b(?:${TEXT_KEYS})\\s*(?:[:=]|%3D)\\s*["']\\s*,\\s*)`
  + `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
  'gi',
);
// Authorization / Proxy-Authorization with any scheme (Bearer, Basic, Token,
// ...) or none: `authorization=Token abc`, `"Authorization": "Bearer abc"`.
// The scheme is kept, the credential masked.
const AUTH_HEADER_RE = new RegExp(
  `(\\b(?:proxy-)?authorization(?:\\\\?["'])?\\s*(?:[:=]|%3D)\\s*(?:\\\\?["'])?)`
  + `(?:([A-Za-z][A-Za-z0-9-]*)(\\s+|%20|\\+))?(?![A-Za-z][A-Za-z0-9-]*(?:\\s+|%20|\\+)\\[REDACTED\\])(?!\\[REDACTED\\])[^\\s,;&"'}\\]\\\\]+`,
  'gi',
);
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi;
// Feishu/Lark token shapes (same on both platforms): t- (tenant), u- (user), a- (app), ur- (refresh), e.g.
// `t-g1044ghJRUIJJ5ELPPTE7XCBBM4MCHJ7ROSJKNQE` (prefix + ~40 characters).
// Must stand alone (not inside a path, file name or longer word), be at
// least 30 characters after the prefix and contain a digit, so names such as
// `/tmp/u-ploads_...` or `a-very-long-hyphenated-identifier-name` survive.
const LARK_TOKEN_RE = /(?<![\w./\\-])(?:t|u|a|ur)-(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9._-]{30,}(?![\w/\\-])/g;
// JWS-shaped tokens: current OAuth v2 user_access_token / refresh_token values
// (and any other JWT) have no t-/u- prefix. A JWS header is base64url JSON,
// so it starts with `eyJ` (`{"`). Header and payload must each have at least
// 10 characters, so dotted identifiers such as `eyJsonParser.load.parse`
// survive; the signature may be empty (unsigned JWT). The lookbehind keeps
// the match anchored at a token start, so the scan stays linear.
const JWS_TOKEN_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;

const knownSecrets = new Set();

/**
 * Register literal secret values (e.g. FEISHU_APP_SECRET) so they are removed
 * from any logged text even when they appear without a recognisable key.
 * Values shorter than 8 characters are ignored to avoid mangling logs.
 */
export function registerSecrets(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length >= MIN_KNOWN_SECRET_LENGTH) knownSecrets.add(v);
  }
}

/** Test helper: forget registered secrets. */
export function clearRegisteredSecrets() {
  knownSecrets.clear();
}

function redactQuotedValue(value) {
  if (value.startsWith('\\"')) return `\\"${REDACTED}\\"`;
  if (value.startsWith('"')) return `"${REDACTED}"`;
  if (value.startsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

/** Redact secrets from a string. */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  out = out.replace(AUTH_HEADER_RE, (_m, prefix, scheme, sep) => prefix + (scheme ? scheme + sep : '') + REDACTED);
  out = out.replace(AUTH_SCHEME_RE, (_m, scheme) => `${scheme} ${REDACTED}`);
  out = out.replace(ELEMENT_KEY_VALUE_RE, (_m, prefix, value) => prefix + redactQuotedValue(value));
  out = out.replace(KEY_VALUE_RE, (_m, prefix, value) => prefix + redactQuotedValue(value));
  out = out.replace(LARK_TOKEN_RE, REDACTED);
  out = out.replace(JWS_TOKEN_RE, REDACTED);
  return out;
}

function isBinary(v) {
  return Buffer.isBuffer(v) || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;
}

const BUILTIN_ERRORS = new Set([Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError]);
const MAX_NAMED_CLASSES = 256;
const namedClasses = new Map();

function constructorOf(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return null;
    const ctor = proto.constructor;
    return typeof ctor === 'function' ? ctor : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An empty class with the same name as `ctor` (extending `Base`), so that
 * util.inspect prints the copy as `Foo { ... }` / `FooError: ...` without
 * calling the original's constructor or custom inspect. Reading `ctor.name`
 * can still run a static `name` getter; if that throws, the class name is
 * dropped. Cached per name and base; past MAX_NAMED_CLASSES names, undefined.
 */
function namedClass(ctor, Base) {
  let name;
  try {
    name = ctor?.name;
  } catch {
    return undefined;
  }
  if (typeof name !== 'string' || name === '' || name === Base.name) return undefined;
  const key = `${Base.name}:${name}`;
  let cls = namedClasses.get(key);
  if (!cls) {
    if (namedClasses.size >= MAX_NAMED_CLASSES) return undefined;
    cls = Base === Object ? { [name]: class {} }[name] : { [name]: class extends Base {} }[name];
    namedClasses.set(key, cls);
  }
  return cls;
}

/** Empty copy target with the same class name / null prototype as `value`. */
function emptyLike(value) {
  const ctor = constructorOf(value);
  if (ctor === null) return Object.create(null);
  if (ctor === undefined || ctor === Object) return {};
  const cls = namedClass(ctor, Object);
  return cls ? new cls() : {};
}

function newErrorLike(err, message) {
  const ctor = constructorOf(err);
  if (ctor === AggregateError) return new AggregateError([], message);
  if (BUILTIN_ERRORS.has(ctor)) return new ctor(message);
  const cls = namedClass(ctor, Error);
  return cls ? new cls(message) : new Error(message);
}

// util.inspect prints non-enumerable own `cause` / `errors` as `[cause]` /
// `[errors]`, as on the original error.
function defineHidden(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: false });
}

function redactError(err, depth, ctx) {
  const out = newErrorLike(err, redactText(String(err.message ?? '')));
  if (out.name !== err.name) out.name = err.name;
  out.stack = typeof err.stack === 'string' ? redactText(err.stack) : out.stack;

  if (err.isAxiosError) {
    // Summarize instead of copying config/request/response: they hold the
    // request body, headers and socket internals.
    const cfg = err.config || {};
    if (err.code !== undefined) out.code = err.code;
    if (cfg.method) out.method = String(cfg.method).toUpperCase();
    const url = cfg.url ? (cfg.baseURL && !/^https?:/i.test(cfg.url) ? cfg.baseURL + cfg.url : cfg.url) : undefined;
    if (url) out.url = redactText(String(url));
    const status = err.response?.status ?? err.status;
    if (status !== undefined) out.status = status;
    if (err.response && err.response.data !== undefined) {
      out.responseData = redactValue(err.response.data, depth + 1, ctx);
    }
  } else {
    for (const key of Object.keys(err)) {
      if (key === 'message' || key === 'stack') continue;
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(err[key], depth + 1, ctx);
    }
  }
  // AggregateError keeps `errors` as a non-enumerable own property.
  if (Array.isArray(err.errors) && !Object.propertyIsEnumerable.call(err, 'errors')) {
    defineHidden(out, 'errors', redactValue(err.errors, depth + 1, ctx));
  }
  if (err.cause !== undefined && !Object.hasOwn(out, 'cause')) {
    const cause = redactValue(err.cause, depth + 1, ctx);
    if (Object.hasOwn(err, 'cause') && Object.propertyIsEnumerable.call(err, 'cause')) out.cause = cause;
    else defineHidden(out, 'cause', cause);
  }
  return out;
}

function moreMarker(n, what) {
  return `… ${n} more ${what}`;
}

function redactEntries(iterable, size, depth, ctx, each) {
  let i = 0;
  for (const entry of iterable) {
    if (i >= ctx.maxItems || ctx.nodes >= ctx.maxNodes) return size - i;
    each(entry);
    i++;
  }
  return 0;
}

function redactObject(value, depth, ctx) {
  if (value instanceof Error) return redactError(value, depth, ctx);
  if (Array.isArray(value)) {
    const out = [];
    const rest = redactEntries(value, value.length, depth, ctx, v => out.push(redactValue(v, depth + 1, ctx)));
    if (rest > 0) out.push(moreMarker(rest, 'items'));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    const rest = redactEntries(value, value.size, depth, ctx,
      ([k, v]) => out.set(k, isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1, ctx)));
    if (rest > 0) out.set('…', moreMarker(rest, 'entries'));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    const rest = redactEntries(value, value.size, depth, ctx, v => out.add(redactValue(v, depth + 1, ctx)));
    if (rest > 0) out.add(moreMarker(rest, 'items'));
    return out;
  }
  const out = emptyLike(value);
  // Own enumerable string keys, then enumerable symbol keys (as util.inspect
  // shows them). A symbol key is judged by its description.
  const keys = Object.keys(value);
  for (const sym of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, sym)) keys.push(sym);
  }
  const rest = redactEntries(keys, keys.length, depth, ctx, (key) => {
    let v;
    try { v = value[key]; } catch { v = '[unreadable]'; }
    const sensitive = isSensitiveKey(typeof key === 'symbol' ? key.description : key);
    out[key] = sensitive && v !== undefined && v !== null && v !== '' ? REDACTED : redactValue(v, depth + 1, ctx);
  });
  if (rest > 0) out['…'] = moreMarker(rest, 'keys');
  return out;
}

function redactValue(value, depth, ctx) {
  ctx.nodes++;
  if (typeof value === 'string') return ctx.nodes > ctx.maxNodes ? '[Truncated]' : redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (isBinary(value)) return `[binary ${value.byteLength ?? value.length} bytes]`;
  if (value instanceof Date || value instanceof RegExp) return value;
  if (value instanceof URL || value instanceof URLSearchParams) return redactText(String(value));
  if (ctx.active.has(value)) return '[Circular]';
  // A memoized copy made at depth d is cut off MAX_DEPTH - d levels below it,
  // so it is reused only at the same or a deeper level; met shallower, the
  // value is walked again and the fuller copy replaces the memo entry.
  const memo = ctx.done.get(value);
  if (memo && memo.depth <= depth) return memo.out;
  if (depth > ctx.maxDepth) return Array.isArray(value) ? '[Array]' : '[Object]';
  if (ctx.nodes > ctx.maxNodes) return '[Truncated]';
  ctx.active.add(value);
  try {
    const out = redactObject(value, depth, ctx);
    ctx.done.set(value, { out, depth });
    return out;
  } finally {
    ctx.active.delete(value);
  }
}

/**
 * Return a log-safe copy of `value` (string, Error, AxiosError, array or
 * nested object). The input is not modified. Never throws: a value that
 * cannot be walked becomes '[unloggable value]'.
 *
 * `options.maxDepth` / `maxItems` / `maxNodes` override the size bounds (e.g.
 * `Infinity` for a config dump that must stay complete).
 */
export function redact(value, { maxDepth = MAX_DEPTH, maxItems = MAX_ITEMS, maxNodes = MAX_NODES } = {}) {
  try {
    return redactValue(value, 0, { active: new Set(), done: new WeakMap(), nodes: 0, maxDepth, maxItems, maxNodes });
  } catch {
    return '[unloggable value]';
  }
}

/**
 * Redact a console-style argument list and format it into one string, so
 * a format string and its arguments are checked together
 * (`('token=%s', v)` or `('[x] token:', v)`). Objects are first redacted by
 * key, then everything is `util.format`ted and redactText() runs once over
 * the result.
 *
 * For plain objects, arrays, Maps, Sets, class instances, null-prototype
 * objects, symbol keys and errors (including `[cause]`, AggregateError
 * `[errors]` and Error subclasses) without secrets, the text equals
 * `util.format` (tested). Known remaining differences:
 * - arrays / Maps / Sets over 100 entries end with a `'… N more items'`
 *   element, objects over 100 keys with a `'…'` key, and values past the
 *   5000-value budget print as `'[Truncated]'`;
 * - Buffers / typed arrays print as `'[binary N bytes]'`, URL and
 *   URLSearchParams objects as their (quoted) string;
 * - axios errors print as a summary (code, method, url, status, cause,
 *   responseData) instead of config / request / response;
 * - accessor properties print their value instead of `[Getter]`;
 *   subclasses of Array / Map / Set lose their class name, as do classes
 *   past the first 256 distinct names;
 * - text that looks like a secret (`token=...`, a `t-`/`eyJ` token shape)
 *   is masked even when it is harmless.
 */
export function formatRedacted(args) {
  try {
    const safe = args.map(a => (a !== null && typeof a === 'object' ? redact(a) : a));
    return redactText(util.format(...safe));
  } catch {
    return '[unloggable value]';
  }
}

/**
 * Logger for the Feishu/Lark SDK (`logger` option of Client / WSClient /
 * EventDispatcher). Same output format and streams as the SDK's default
 * logger, with every argument passed through redact().
 */
export function createRedactingLogger(out = console) {
  const f = (level, msg) => formatRedacted([`[${level}]:`, ...msg]);
  return {
    error: (...msg) => out.log(f('error', msg)),
    warn: (...msg) => out.warn(f('warn', msg)),
    info: (...msg) => out.info(f('info', msg)),
    debug: (...msg) => out.debug(f('debug', msg)),
    trace: (...msg) => out.trace(f('trace', msg)),
  };
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
const INSTALLED = Symbol.for('zylos-feishu.consoleRedaction');

/**
 * Wrap console methods so their output is redacted before printing: the
 * arguments are formatted into one string by formatRedacted().
 * Idempotent. Returns a function that restores the original methods.
 */
export function installConsoleRedaction(target = console) {
  if (target[INSTALLED]) return target[INSTALLED];
  const originals = {};
  for (const name of CONSOLE_METHODS) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    originals[name] = orig;
    target[name] = function redactedConsole(...args) {
      return orig.call(this, formatRedacted(args));
    };
  }
  const restore = () => {
    for (const [name, orig] of Object.entries(originals)) target[name] = orig;
    delete target[INSTALLED];
  };
  target[INSTALLED] = restore;
  return restore;
}
