/**
 * Lab-safe Feishu SDK logger.
 *
 * The SDK's default logger prints Axios errors verbatim. Auth requests carry
 * `app_secret` in the body, so a network failure would copy the credential into
 * PM2's out/error log (review-v3 #2). This logger keeps only:
 *   - error name/code/message,
 *   - HTTP status / SDK response code / message,
 *   - request method and URL path (query string removed),
 * and never prints request bodies, headers, params or SDK config objects.
 *
 * It is copied into `<lab>/vendor/zylos-feishu/src/lib/safe-logger.js` by
 * `feishu-setup`; the vendor patch imports it for every SDK client.
 */

const MAX_TEXT = 300;

/** Redact the secret no matter which shape it appears in. */
export function redactSecrets(text) {
  return String(text)
    .replace(/(app_secret\s*=\s*)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/("?\bapp_secret\b"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^,}\]\s]+)/gi, '$1[REDACTED]');
}

function clip(text) {
  const value = redactSecrets(text);
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function urlPath(value) {
  if (typeof value !== 'string') return '';
  const query = value.indexOf('?');
  return clip(query === -1 ? value : value.slice(0, query));
}

function summarizeResponse(response) {
  if (!response || typeof response !== 'object') return '';
  const parts = [];
  if (response.status !== undefined) parts.push(`status=${response.status}`);
  if (response.statusText !== undefined) parts.push(`statusText=${clip(response.statusText)}`);
  const data = response.data;
  if (data && typeof data === 'object') {
    if (data.code !== undefined) parts.push(`code=${data.code}`);
    if (data.msg !== undefined) parts.push(`msg=${clip(data.msg)}`);
    else if (data.message !== undefined) parts.push(`msg=${clip(data.message)}`);
    if (data.error && typeof data.error === 'object' && data.error.code !== undefined) {
      parts.push(`errorCode=${data.error.code}`);
    }
  }
  return parts.join(' ');
}

/**
 * Reduce one value to a safe, single-line summary.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {string}
 */
export function summarizeForLog(value, depth = 0) {
  if (depth > 3) return '[depth]';
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((entry) => summarizeForLog(entry, depth + 1)).filter(Boolean).join(' ');
  }
  if (value instanceof Error) {
    const parts = [value.name, value.code, clip(value.message)].filter(Boolean);
    if (value.config) parts.push(`method=${clip(value.config.method ?? '')}`, `url=${urlPath(value.config.url)}`);
    if (value.response) parts.push(summarizeResponse(value.response));
    return parts.filter(Boolean).join(' ');
  }
  if (typeof value === 'object') {
    const parts = [];
    for (const key of ['name', 'code', 'status', 'statusText', 'message', 'msg', 'type']) {
      if (value[key] !== undefined) parts.push(`${key}=${clip(value[key])}`);
    }
    if (value.config && typeof value.config === 'object') {
      if (value.config.method !== undefined) parts.push(`method=${clip(value.config.method)}`);
      if (value.config.url !== undefined) parts.push(`url=${urlPath(value.config.url)}`);
    }
    if (value.request && typeof value.request === 'object') {
      if (value.request.path !== undefined) parts.push(`path=${urlPath(value.request.path)}`);
      else if (value.request.host !== undefined) parts.push(`host=${clip(value.request.host)}`);
    }
    if (value.response) parts.push(summarizeResponse(value.response));
    // Deliberately skipped: config.data, config.headers, config.params,
    // request.body, response.data (except code/msg), any other object values.
    return parts.filter(Boolean).join(' ') || 'error';
  }
  return '';
}

/**
 * Build a logger compatible with the Feishu SDK (`logger` option).
 *
 * @param {{write?: (line: string) => void}} [options]
 */
export function createSafeLogger({ write = (line) => process.stderr.write(line) } = {}) {
  const emit = (level, args) => {
    try {
      const text = args.map((arg) => summarizeForLog(arg)).filter(Boolean).join(' ');
      write(`[feishu:${level}] ${text}\n`);
    } catch {
      // A logger must never take the component down.
    }
  };
  return {
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),
    trace: (...args) => emit('trace', args),
  };
}

export const safeLogger = createSafeLogger();
