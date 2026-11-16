/**
 * Inbound bridge to zylos-core: calls comm-bridge c4-receive.
 *
 * - The session group is derived from the endpoint (src/lib/session-group.js)
 *   and passed as `--session-group` only when the installed Core lists that
 *   option in c4-receive-options.json (re-read on every call, never inferred
 *   from a version). On an older Core the argv is exactly what it was before.
 * - Core's error text is written for the agent, never for the Feishu user: users
 *   only ever see TRY_LATER or MAYBE_LOST; the raw text stays in the logs.
 * - On an older Core (option not listed) no session group is derived at all:
 *   the endpoint is never rejected for lacking one, exactly as before.
 * - c4-receive is killed after C4_RECEIVE_TIMEOUT_MS (35s, as on main). A
 *   timeout is an unknown outcome: the user gets MAYBE_LOST and nothing is
 *   resent. Only a call that never started (spawn failure) is retried, once;
 *   a stored or unknown outcome is never resent, and a rejected group is never
 *   resent without the group.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { sessionGroupFromEndpoint } from './session-group.js';

export const TRY_LATER = "Sorry, I couldn't take this message right now. Please try again later.";
export const C4_RECEIVE_TIMEOUT_MS = 35000;
export const MAYBE_LOST = "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";

/**
 * c4-receive.js of the deployment this component runs in.
 * @returns {string}
 */
export function getC4ReceivePath() {
  return path.join(process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos'),
    '.claude/skills/comm-bridge/scripts/c4-receive.js');
}

/**
 * Whether the installed c4-receive declares an option. Re-reads
 * c4-receive-options.json next to c4-receive.js on every call; a missing,
 * unreadable or malformed file means "not supported".
 * @param {string} name - e.g. '--session-group'
 * @returns {boolean}
 */
export function c4ReceiveSupportsOption(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(getC4ReceivePath()), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

/**
 * Arguments after the c4-receive.js path.
 * @returns {string[]}
 */
export function buildC4ReceiveArgs({ source, endpoint, content, sessionGroup,
  supportsSessionGroup = c4ReceiveSupportsOption('--session-group') }) {
  const args = ['--channel', source, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && supportsSessionGroup) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

/**
 * Classify a structured c4-receive rejection by `error.persisted`:
 * - non-empty array: the inbound row was stored ('stored') - send nothing, never resend
 * - empty array: nothing was stored ('not_stored') - ask the user to try later
 * - null / absent (older Cores): Core cannot tell ('uncertain')
 * @param {object} response - parsed `{ ok: false, error }` JSON
 * @returns {'stored'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'stored' : 'not_stored';
}

/**
 * Parse c4-receive JSON response from stdout.
 * @returns {object|null}
 */
export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    return null;
  }
}

function isStructuredRejection(response) {
  return response !== null && typeof response === 'object' && response.ok === false
    && response.error !== null && typeof response.error === 'object';
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result
 * (non-zero exit, signal, maxBuffer) has an unknown outcome.
 */
function neverStarted(error) {
  return typeof error?.syscall === 'string' && error.syscall.startsWith('spawn');
}

/**
 * Send a message to the agent via C4.
 * @param {string} source - Channel name ('feishu')
 * @param {string} endpoint - Structured endpoint (src/lib/endpoint.js)
 * @param {string} content - Message content
 * @param {function} [onReject] - Called at most once when the agent will not
 *   answer: with TRY_LATER / MAYBE_LOST to show the user, or with null when
 *   Core already stored the message (clean up only, send nothing)
 * @param {function} [onSuccess] - Called when c4-receive accepted the message
 * @param {object} [opts]
 * @param {number} [opts.retryDelayMs=2000] - Delay before the single spawn-failure retry
 * @param {object} [opts.env] - Environment for c4-receive (e.g. carrying
 *   FEISHU_INTERNAL_SECRET); defaults to this process's environment
 * @param {function} [opts.onDone] - Test hook: called with the final outcome
 * @param {function} [opts.execFileImpl] - Test hook: replaces child_process.execFile
 */
export function sendToC4(source, endpoint, content, onReject, onSuccess,
  { retryDelayMs = 2000, timeoutMs = C4_RECEIVE_TIMEOUT_MS, env, onDone, execFileImpl = execFile } = {}) {
  const done = outcome => { if (onDone) onDone(outcome); };
  if (!content) {
    console.error('[feishu] sendToC4 called with empty content');
    return done('empty');
  }

  // The options file is re-read on every attempt (including the retry). The
  // session group is derived only when the installed Core supports it, and
  // once derived it stays the same for the retry.
  let sessionGroup;
  const run = cb => {
    const supportsSessionGroup = c4ReceiveSupportsOption('--session-group');
    if (supportsSessionGroup && sessionGroup === undefined) {
      try {
        sessionGroup = sessionGroupFromEndpoint(endpoint);
      } catch (err) {
        // Never fall back to the overall group: that would mix this conversation into it.
        console.error(`[feishu] No session group for endpoint, not sending to C4: ${err.message}`);
        if (onReject) onReject(TRY_LATER);
        done('no_group');
        return false;
      }
    }
    execFileImpl(process.execPath,
      [getC4ReceivePath(), ...buildC4ReceiveArgs({ source, endpoint, content, sessionGroup, supportsSessionGroup })],
      { encoding: 'utf8', timeout: timeoutMs, ...(env && { env }) }, cb);
    return true;
  };

  const handleRejection = (response, label) => {
    const { code, message } = response.error;
    const kind = classifyC4Rejection(response);
    if (kind === 'stored') {
      console.warn(`[feishu] C4 ${label} after storing (${code}) [group=${sessionGroup ?? 'none'}], not resending: ${message}`);
      if (onReject) onReject(null);
      return done('stored');
    }
    console.warn(`[feishu] C4 ${label} (${code}, ${kind}) [group=${sessionGroup ?? 'none'}]: ${message}`);
    if (onReject) onReject(kind === 'not_stored' ? TRY_LATER : MAYBE_LOST);
    return done(kind);
  };

  const handleResult = (error, stdout, label) => {
    if (!error) {
      console.log(`[feishu] Sent to C4${label}: ${content.substring(0, 50)}...`);
      if (onSuccess) onSuccess();
      done('sent');
      return true;
    }
    const response = parseC4Response(stdout ?? error.stdout);
    if (isStructuredRejection(response)) {
      handleRejection(response, `rejected${label}`);
      return true;
    }
    return false;
  };

  run((error, stdout) => {
    if (handleResult(error, stdout, '')) return;
    if (!neverStarted(error)) {
      console.error(`[feishu] C4 send failed, outcome unknown, not resending: ${error.message}`);
      if (onReject) onReject(MAYBE_LOST);
      return done('unknown');
    }
    // c4-receive never started, so nothing was stored - retry once.
    console.warn(`[feishu] C4 receive did not start, retrying in ${retryDelayMs}ms: ${error.message}`);
    setTimeout(() => {
      run((retryError, retryStdout) => {
        if (handleResult(retryError, retryStdout, ' (retry)')) return;
        console.error(`[feishu] C4 send failed after retry, not resending: ${retryError.message}`);
        if (onReject) onReject(MAYBE_LOST);
        return done('failed');
      });
    }, retryDelayMs);
  });
}

/**
 * Build the onReject callback used by the DM and group handlers.
 * - null (Core already stored the message): remove typing, call onStored, send nothing
 * - notice text: remove typing, deliver the notice into the conversation
 * Smart-mode messages without an @mention behave the same as mentioned ones.
 * @param {object} handlers
 * @param {function} handlers.removeTyping
 * @param {function} [handlers.onStored] - e.g. advance the group context cursor
 * @param {function} handlers.deliver - sends the notice text
 * @returns {(notice: string|null) => void}
 */
export function createRejectReply({ removeTyping, onStored, deliver }) {
  return notice => {
    if (removeTyping) removeTyping();
    if (notice == null) {
      if (onStored) onStored();
      return;
    }
    deliver(notice);
  };
}
