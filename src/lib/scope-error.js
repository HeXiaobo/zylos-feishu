/**
 * Recognize Feishu permission denials in an API result or an SDK/Axios error.
 *
 * Feishu answers a missing scope in two shapes, both seen in the test instance
 * (`REPORT-E4.md` §7):
 *
 *   { code: 99991672, msg: 'Access denied. One of the following scopes is required: [tenant:tenant:readonly]' }
 *   { code: 230027,   msg: 'Lack of necessary permissions, ext=need scope: im:message.group_msg' }
 *
 * Only the shape and the named scopes are used here. The text is trimmed to a
 * short single line so it can be stored in config and printed in status without
 * carrying a request body.
 */

export const PERMISSION_DENIED_CODES = new Set([230027, 99991672]);

const MAX_TEXT = 200;

function clip(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/**
 * @param {unknown} value an SDK result (`{code,msg}`), an Axios error, or a
 *   result wrapper that already carries `code`/`msg`/`message`.
 * @returns {{code: number|null, msg: string, scopes: string[], permissionDenied: boolean}|null}
 */
export function parseScopeError(value) {
  if (!value || typeof value !== 'object') return null;
  const data = value.response?.data || value.data || value;
  const code = Number.isFinite(Number(data.code ?? value.code)) ? Number(data.code ?? value.code) : null;
  const msg = clip(data.msg || data.message || value.msg || value.message || '');
  if (code === null && !msg) return null;

  const scopes = new Set();
  for (const match of msg.matchAll(/need scope:\s*([A-Za-z0-9_.:-]+)/g)) scopes.add(match[1]);
  for (const match of msg.matchAll(/scopes? (?:is|are) required:\s*\[([^\]]+)\]/gi)) {
    for (const scope of match[1].split(/[,\s]+/)) if (scope) scopes.add(scope);
  }

  const permissionDenied = PERMISSION_DENIED_CODES.has(code)
    || /lack of necessary permissions/i.test(msg)
    || /access denied/i.test(msg)
    || scopes.size > 0;
  return { code, msg, scopes: [...scopes], permissionDenied };
}

/** One short line for logs / config: `code=99991672 scopes=tenant:tenant:readonly msg=…` */
export function describeScopeError(value) {
  const parsed = parseScopeError(value);
  if (!parsed) return null;
  const parts = [];
  if (parsed.code !== null) parts.push(`code=${parsed.code}`);
  if (parsed.scopes.length) parts.push(`scopes=${parsed.scopes.join(',')}`);
  if (parsed.msg) parts.push(`msg=${parsed.msg}`);
  return parts.join(' ');
}
