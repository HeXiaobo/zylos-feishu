/** One C4 outbox row may contain several chunks. Keep each accepted chunk's
 * UUID stable on replay; do not fall back or retry after an ambiguous send.
 */
export function createDelivery(id) {
  let chunk = 0;
  let lastId = null;
  let uncertain = false;
  const uuid = () => id ? `${id}${chunk ? `:${chunk}` : ''}` : undefined;
  return {
    wrap(fn, optionIndex) {
      return async (...args) => {
        if (id) {
          while (args.length < optionIndex) args.push(undefined);
          args[optionIndex] = { ...args[optionIndex], uuid: uuid() };
        }
        let result;
        try { result = await fn(...args); }
        catch (error) { uncertain = true; throw error; }
        if (id && result?.success && !result.messageId) {
          uncertain = true;
          throw new Error('Send accepted without a platform message id; verify before retry');
        }
        if (id && (result?.uncertain || (result?.success === false && result.code === undefined))) {
          uncertain = true;
          throw new Error('Send outcome unknown; verify before retry');
        }
        if (result?.success) { lastId = result.messageId || lastId; chunk++; }
        return result;
      };
    },
    result(exitCode) {
      return { status: exitCode === 0 && lastId ? 'sent' : 'failed', platform_msg_id: lastId,
        ...(uncertain ? { uncertain: true } : {}) };
    },
  };
}
