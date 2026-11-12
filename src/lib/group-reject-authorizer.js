/**
 * Wrap an admission decision into the boolean authorizer the Feishu reply
 * refactor gateway expects, while delivering a configured visible rejection.
 *
 * The gateway only decides admission, so the denial reply is sent outside it.
 * Rejections are remembered per message id for the process lifetime, so a
 * redelivered WebSocket event or a retried webhook cannot produce a second
 * reply even before Feishu's uuid dedupe runs.
 *
 * `authorizeGroup` may resolve to:
 *   - `true`  → admitted
 *   - `false` → denied, nothing to send
 *   - `{ rejection: { messageId, text, ... } }` → denied, send `text` once
 *
 * Lives in lib/ so tests can import it without starting the service in
 * src/index.js (which connects to Feishu on import).
 */
export function createReplyRefactorAuthorizer({
  authorizeGroup,
  reply,
  remember = new Set(),
} = {}) {
  if (typeof authorizeGroup !== 'function') {
    throw new TypeError('createReplyRefactorAuthorizer requires authorizeGroup');
  }
  if (typeof reply !== 'function') {
    throw new TypeError('createReplyRefactorAuthorizer requires reply');
  }
  return async function authorize(rawEvent, options) {
    const authorization = await authorizeGroup(rawEvent, options);
    if (!authorization?.rejection) return authorization === true;
    if (!remember.has(authorization.rejection.messageId)) {
      remember.add(authorization.rejection.messageId);
      try {
        await reply(authorization.rejection);
      } catch {
        // A failed rejection must not turn into an admission.
      }
    }
    return false;
  };
}
