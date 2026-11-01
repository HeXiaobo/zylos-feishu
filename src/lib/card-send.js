/**
 * Send a prepared Feishu interactive card (card 2.0 JSON) from an
 * already-serialized `.json` file.
 *
 * C4 sends media as `[MEDIA:<type>]<path>`; cards are a third media type next
 * to image/file. Unlike those two, a card is not uploaded first: the file
 * content becomes the `content` field of an `interactive` message, so it must
 * be a complete card 2.0 document that is valid as-is.
 *
 * Everything here is read/validate/route only, with the send functions
 * injected, so `scripts/send.js` stays wiring and the rules stay testable.
 * This path NEVER falls back to text and never truncates the card: a card that
 * cannot be delivered is an error, because a silently degraded message is
 * worse than a visible failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chooseReplyTarget } from './reply-target.js';

// Feishu docs (send message API): the request body of a card or rich-text
// message must not exceed 30 KB. Count the body we actually send, in UTF-8
// bytes, not characters — CJK text costs 3 bytes per character.
export const CARD_MAX_REQUEST_BYTES = 30 * 1024;

function cardError(prefix, detail) {
  const err = new Error(`${prefix}: ${detail}`);
  err.code = prefix;
  return err;
}

/**
 * Build the request body for a base send (new message) and for a reply.
 * These are the exact payloads the byte limit applies to.
 */
export function sendRequestBody(chatId, content) {
  return { receive_id: chatId, msg_type: 'interactive', content };
}

export function replyRequestBody(content) {
  return { msg_type: 'interactive', content };
}

export function requestBodyBytes(body) {
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}

/**
 * Read and validate a card file.
 *
 * @param {string} filePath - absolute path to a card 2.0 JSON file
 * @param {object} [deps]
 * @param {typeof fs.statSync} [deps.statFile]
 * @param {typeof fs.readFileSync} [deps.readFile]
 * @returns {{ card: object, content: string }}
 * @throws Error with code ERR_CARD_PATH / ERR_CARD_JSON / ERR_CARD_SCHEMA
 */
export function readCardFile(filePath, { statFile = fs.statSync, readFile = fs.readFileSync } = {}) {
  const target = String(filePath ?? '').trim();
  if (!target) throw cardError('ERR_CARD_PATH', 'empty card path');
  if (!path.isAbsolute(target)) throw cardError('ERR_CARD_PATH', `not an absolute path: ${target}`);

  let stat;
  try {
    stat = statFile(target);
  } catch (err) {
    throw cardError('ERR_CARD_PATH', `cannot stat ${target}: ${err.code || err.message}`);
  }
  if (!stat.isFile()) throw cardError('ERR_CARD_PATH', `not a regular file: ${target}`);

  let raw;
  try {
    raw = readFile(target, 'utf8');
  } catch (err) {
    throw cardError('ERR_CARD_PATH', `cannot read ${target}: ${err.code || err.message}`);
  }

  let card;
  try {
    card = JSON.parse(raw);
  } catch (err) {
    throw cardError('ERR_CARD_JSON', `invalid JSON in ${target}: ${err.message}`);
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw cardError('ERR_CARD_JSON', `top-level value must be an object in ${target}`);
  }

  if (card.schema !== '2.0') {
    throw cardError('ERR_CARD_SCHEMA', `expected schema "2.0" in ${target}, got ${JSON.stringify(card.schema)}`);
  }
  if (!card.body || typeof card.body !== 'object' || Array.isArray(card.body)) {
    throw cardError('ERR_CARD_SCHEMA', `missing body object in ${target}`);
  }

  return { card, content: JSON.stringify(card) };
}

/**
 * Short human-readable description for the outgoing-message history.
 * Prefers the card's own summary, then its header title, then a constant.
 */
export function cardSummary(card) {
  const summary = card?.config?.summary?.content;
  if (typeof summary === 'string' && summary.trim()) return summary.trim();

  const title = card?.header?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (typeof title?.content === 'string' && title.content.trim()) return title.content.trim();

  return 'card';
}

/**
 * Read, validate, route and send one card file.
 *
 * Routing matches images/files: p2p always sends to the chat (a reply is not
 * surfaced in the 1:1 view); groups reply to the thread/message when the
 * endpoint carries one, fall back to the thread root when the reply target was
 * a nested parent, then to a plain send. Every attempt is still a card.
 *
 * @param {object} params
 * @param {string} params.chatId
 * @param {string} [params.type] - 'p2p' | 'group'
 * @param {string} [params.root]
 * @param {string} [params.parent]
 * @param {string} [params.msg]
 * @param {string} params.cardPath - absolute path to the card JSON file
 * @param {object} deps
 * @param {(messageId: string, content: string, msgType: string) => Promise<object>} deps.replyToMessage
 * @param {(chatId: string, content: string, receiveIdType: string, msgType: string) => Promise<object>} deps.sendMessage
 * @param {typeof readCardFile} [deps.readCard]
 * @returns {Promise<{ success: true, messageId?: string, via: 'reply'|'reply-root'|'send', summary: string, card: object }>}
 * @throws Error with code ERR_CARD_PATH / ERR_CARD_JSON / ERR_CARD_SCHEMA /
 *   ERR_CARD_TOO_LARGE / ERR_CARD_SEND
 */
export async function sendCard(
  { chatId, type, root, parent, msg, cardPath } = {},
  { replyToMessage, sendMessage, readCard = readCardFile } = {},
) {
  const { card, content } = readCard(cardPath);

  const replyTarget = chooseReplyTarget({ type, root, parent, msg });
  const attempts = [];
  if (replyTarget) {
    attempts.push({ via: 'reply', target: replyTarget });
    // A nested parent may be gone; the thread root usually still exists.
    if (root && parent && parent !== root) attempts.push({ via: 'reply-root', target: root });
  }
  attempts.push({ via: 'send', target: chatId });

  const failures = [];
  for (const attempt of attempts) {
    const body = attempt.via === 'send'
      ? sendRequestBody(chatId, content)
      : replyRequestBody(content);
    const bytes = requestBodyBytes(body);
    if (bytes > CARD_MAX_REQUEST_BYTES) {
      throw cardError('ERR_CARD_TOO_LARGE', `${bytes}/${CARD_MAX_REQUEST_BYTES}`);
    }

    let result;
    try {
      result = attempt.via === 'send'
        ? await sendMessage(chatId, content, 'chat_id', 'interactive')
        : await replyToMessage(attempt.target, content, 'interactive');
    } catch (err) {
      failures.push({ code: err?.code, message: err?.message });
      continue;
    }

    if (result && result.success) {
      return {
        success: true,
        messageId: result.messageId,
        via: attempt.via,
        summary: cardSummary(card),
        card,
      };
    }
    failures.push({ code: result?.code, message: result?.message });
  }

  const last = failures[failures.length - 1] || {};
  throw cardError('ERR_CARD_SEND', `${last.code ?? 'unknown'} ${last.message ?? 'no send attempt succeeded'}`);
}
