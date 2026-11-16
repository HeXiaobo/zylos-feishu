/**
 * Structured endpoint strings passed to c4-receive.
 *
 * Format: chatId|type:<p2p|group>|root:rootId|parent:parentId|msg:messageId|thread:threadId
 *
 * buildEndpoint is the inbound builder used by src/index.js; its output format
 * must not change (scripts/send.js parses it for outbound routing).
 * parseEndpoint follows the same rules as the parser in scripts/send.js:
 * only the known keys are read, unknown keys are ignored, and a plain chat id
 * without `|` yields just `{ chatId }`.
 */

const ENDPOINT_KEYS = new Set(['type', 'root', 'parent', 'msg', 'thread']);

/**
 * Build structured endpoint string for C4.
 * Format: chatId|type:group|root:rootId|parent:parentId|msg:messageId|thread:threadId
 */
export function buildEndpoint(chatId, { chatType, rootId, parentId, messageId, threadId } = {}) {
  let endpoint = chatId;
  if (chatType) {
    endpoint += `|type:${chatType}`;
  }
  if (rootId) {
    endpoint += `|root:${rootId}`;
  }
  if (parentId) {
    endpoint += `|parent:${parentId}`;
  }
  if (messageId) {
    endpoint += `|msg:${messageId}`;
  }
  if (threadId) {
    endpoint += `|thread:${threadId}`;
  }
  return endpoint;
}

/**
 * Parse a structured endpoint string.
 * @param {string} endpoint
 * @returns {{chatId: string, type?: string, root?: string, parent?: string, msg?: string, thread?: string}}
 */
export function parseEndpoint(endpoint) {
  const parts = String(endpoint ?? '').split('|');
  const result = { chatId: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      if (!ENDPOINT_KEYS.has(key)) continue;
      result[key] = part.substring(colonIdx + 1);
    }
  }
  return result;
}
