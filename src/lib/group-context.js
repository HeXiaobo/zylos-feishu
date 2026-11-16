/**
 * Group context window and the delivery-gated group context cursor.
 *
 * The cursor of a group chat is the id of the last group message that Core
 * confirmed (c4-receive accepted it, or rejected it after storing it). The
 * context of the next handled group message only covers what came after the
 * cursor, so the agent is not shown the same context twice.
 *
 * The cursor only moves after Core confirms delivery (markCursorDelivered,
 * same as zylos-lark). If Core answers TRY_LATER / MAYBE_LOST, the handler
 * throws, or the process dies before Core answers, the cursor stays where it
 * was, and the next handled message in that chat still carries the context of
 * the message that did not get through.
 *
 * Pure helpers only: src/index.js owns the history map and the cursor file.
 */

/**
 * Milliseconds for a history entry timestamp. Feishu gives epoch-millisecond
 * strings (webhook `header.create_time`); lazy-loaded and locally recorded
 * entries use ISO strings. Anything unparsable sorts as 0.
 * @param {string|number|null|undefined} ts
 * @returns {number}
 */
export function timestampMillis(ts) {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : 0;
  if (typeof ts !== 'string' || ts === '') return 0;
  if (/^\d+$/.test(ts)) return Number(ts);
  return Date.parse(ts) || 0;
}

/**
 * Chronological copy of history entries. Ties keep their arrival order
 * (Array.prototype.sort is stable).
 * @param {Array<{timestamp?: string}>} messages
 * @returns {Array}
 */
export function sortContextChronologically(messages) {
  return [...messages].sort((a, b) => timestampMillis(a.timestamp) - timestampMillis(b.timestamp));
}

/**
 * Context window for a message: the last `limit` entries before it, excluding
 * the message itself, and, when `afterMessageId` (the cursor) is present in the
 * history, only entries after the cursor. An unknown cursor (trimmed from
 * memory, or not in the lazy-loaded page) means no lower bound.
 * @param {Array} history
 * @param {string} currentMessageId
 * @param {number} limit
 * @param {{afterMessageId?: string|null}} [options]
 * @returns {Array}
 */
export function selectContextWindow(history, currentMessageId, limit, { afterMessageId = null } = {}) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const filtered = sortContextChronologically(history.filter(m => m.message_id !== currentMessageId));

  let window = filtered;
  if (afterMessageId) {
    const cursorIndex = filtered.findIndex(m => m.message_id === afterMessageId);
    if (cursorIndex !== -1) {
      window = filtered.slice(cursorIndex + 1);
    }
  }

  const count = Math.min(limit, window.length);
  return count > 0 ? window.slice(-count) : [];
}

/**
 * True when `messageId` is known to be older than the current cursor, so
 * moving the cursor to it would move it backwards (two @mentions in one chat
 * whose c4-receive calls finish out of order). When either id is not in the
 * history the order is unknown and the cursor may move.
 * @param {Array} history
 * @param {string|null|undefined} cursorId
 * @param {string} messageId
 * @returns {boolean}
 */
export function isBehindCursor(history, cursorId, messageId) {
  if (!cursorId || !messageId || cursorId === messageId || !Array.isArray(history)) return false;
  const sorted = sortContextChronologically(history);
  const cursorIndex = sorted.findIndex(m => m.message_id === cursorId);
  const messageIndex = sorted.findIndex(m => m.message_id === messageId);
  return cursorIndex !== -1 && messageIndex !== -1 && messageIndex < cursorIndex;
}

/**
 * markCursorDelivered for one handled group message: calls `advance` at most
 * once, however many confirmations arrive. Pass it to sendToC4 as onSuccess
 * and to createRejectReply as onStored. Never call it before Core answers.
 * @param {function} advance - e.g. () => updateCursor(chatId, messageId)
 * @returns {function}
 */
export function createCursorMarker(advance) {
  let cursorUpdated = false;
  return () => {
    if (cursorUpdated) return;
    cursorUpdated = true;
    advance();
  };
}
