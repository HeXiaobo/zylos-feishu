/**
 * Display text for one `im.message.get` item.
 *
 * Resource markers (`[image, image_key: …, msg_id: …]` and the file / audio /
 * media equivalents) carry the message id an agent must hand to
 * `scripts/download.js`, so that id has to be one Feishu accepts for the key —
 * which is not always the item's own id.
 *
 * Measured on a live tenant (2026-11): for an image inside a 合并转发,
 * `im.message.get` of the child's resource answers HTTP 400 with
 * 「图片与消息不匹配」 when given the child's message id. The same image_key
 * downloads successfully (an ~42 KB file) when the id of the outer forward
 * message the bot received is used. Standalone images are unaffected: there
 * the message's own id is the id Feishu accepts.
 *
 * Nested forwards therefore cite the OUTERMOST id at every depth. That part is
 * 〔按实测外推〕: only a single-level forward was measured, and nothing in the
 * API contract distinguishes deeper levels — but a child of a child is not a
 * message the bot ever received, so its id cannot be the accepted one.
 *
 * Only an image was measured. The same rule is applied to file / audio / media
 * because the rejection is a message↔resource binding error, not an
 * image-specific one — 〔未验证〕 for those three types.
 *
 * Quoted (replied-to) messages pass no `resourceMessageId` and keep using the
 * quoted message's own id, unchanged by this rule. Whether a quoted message
 * can hit the same problem is unmeasured; this module does not guess.
 */

import { extractInteractiveText } from './card-text.js';
import { extractPostText, resolveMentions } from './message-text.js';

/**
 * @param {object} msg item from `im.message.get` (has msg_type + body.content)
 * @param {string} fallbackMessageId id to use when `msg.message_id` is absent
 * @param {{resourceMessageId?: string}} [options]
 *   `resourceMessageId` — message id that resource markers must cite instead of
 *   the item's own id (the outer forward, when rendering 合并转发 children).
 * @returns {string} display text, mentions resolved when present
 */
export function parseMessageItemText(msg, fallbackMessageId, { resourceMessageId } = {}) {
  const messageId = msg.message_id || fallbackMessageId;
  // The id written into image/file/audio/media markers. Defaults to the item's
  // own id (standalone and quoted messages); a forward's outer id overrides it.
  const mediaMessageId = resourceMessageId || messageId;
  // body.content is not guaranteed to be JSON for every msg_type — a nested
  // forward-of-a-forward can come back as a bare "Merged and Forwarded
  // Message" string rather than a JSON payload.
  let content;
  try {
    content = JSON.parse(msg.body?.content || '{}');
  } catch {
    content = {};
  }
  let text;
  if (msg.msg_type === 'text') {
    text = content.text || '';
  } else if (msg.msg_type === 'post') {
    // Post images and media are resources too: inside a forward they need the
    // outer id for the same reason a bare image message does.
    ({ text } = extractPostText(content.content || [], mediaMessageId));
    if (content.title) text = `[${content.title}] ${text}`;
  } else if (msg.msg_type === 'interactive') {
    text = extractInteractiveText(content);
  } else if (msg.msg_type === 'file') {
    text = `[file: ${content.file_name || 'unknown'}, file_key: ${content.file_key}, msg_id: ${mediaMessageId}]`;
  } else if (msg.msg_type === 'image') {
    text = `[image, image_key: ${content.image_key}, msg_id: ${mediaMessageId}]`;
  } else if (msg.msg_type === 'audio') {
    text = `[audio, file_key: ${content.file_key}, msg_id: ${mediaMessageId}]`;
  } else if (msg.msg_type === 'media') {
    text = `[media: ${content.file_name || 'video'}, file_key: ${content.file_key}, msg_id: ${mediaMessageId}]`;
  } else if (msg.msg_type === 'sticker') {
    text = `[sticker, file_key: ${content.file_key || 'unknown'}]`;
  } else if (msg.msg_type === 'merge_forward') {
    text = '[nested merge_forward message]';
  } else {
    text = `[${msg.msg_type} message]`;
  }
  if (msg.mentions && msg.mentions.length > 0) {
    text = resolveMentions(text, msg.mentions);
  }
  return text;
}
