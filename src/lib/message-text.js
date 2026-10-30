/**
 * Body parsing shared by the WebSocket path (index.js) and the feishu-recovery
 * poller. The poller replays a message the long connection never saw, so its
 * text has to carry the same executable information: a rich-text link keeps its
 * URL, an @ keeps its recipient, a title keeps its place.
 *
 * Keeping the parsers here (instead of a second copy in docker/3ai/skills/
 * feishu-recovery) is what stops the two paths from drifting; the poller
 * imports this file from the installed component.
 */

/**
 * Replace Feishu's `@_user_1` placeholders with real names.
 * `stripBot` removes a mention of the bot itself (group use).
 */
export function resolveMentions(text, mentions, { stripBot = false, botOpenId: botId } = {}) {
  if (!text || !mentions || !Array.isArray(mentions) || mentions.length === 0) return text;

  let resolved = text;
  for (const m of mentions) {
    if (!m.key) continue;
    const isBotMention = botId && (m.id?.open_id === botId || m.id?.app_id === botId);
    if (stripBot && isBotMention) {
      resolved = resolved.replace(new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'g'), '');
    } else if (m.name) {
      resolved = resolved.replace(m.key, `@${m.name}`);
    }
  }
  return resolved.trim();
}

/**
 * Extract text from a Feishu post (rich text) message.
 * Post messages have nested arrays: paragraphs > elements.
 * Each element has a tag (text, at, a, img, media, emotion).
 *
 * @param {Array} paragraphs - content.content array from post message
 * @param {string} messageId - message ID for lazy media references
 * @returns {{ text: string, imageKeys: string[] }} Extracted text and image keys
 */
export function extractPostText(paragraphs, messageId) {
  const imageKeys = [];
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];

    for (const el of paragraph) {
      switch (el.tag) {
        case 'text':
          parts.push(el.text || '');
          break;
        case 'at':
          parts.push(`@${el.user_name || el.user_id || 'unknown'}`);
          break;
        case 'a':
          if (el.href) {
            parts.push(`${el.text || ''}(${el.href})`);
          } else {
            parts.push(el.text || '');
          }
          break;
        case 'img':
          if (el.image_key) {
            imageKeys.push(el.image_key);
            parts.push(`[image, image_key: ${el.image_key}, msg_id: ${messageId}]`);
          }
          break;
        case 'media':
          parts.push(`[media, file_key: ${el.file_key || 'unknown'}, msg_id: ${messageId}]`);
          break;
        case 'emotion':
          parts.push(el.emoji_type ? `[${el.emoji_type}]` : '');
          break;
        default:
          if (el.text) parts.push(el.text);
          break;
      }
    }

    lines.push(parts.join(''));
  }

  return { text: lines.join('\n'), imageKeys };
}

/**
 * Text of a message as returned by `GET /open-apis/im/v1/messages` (body.content
 * is a JSON string) or by the event payload (message.content). Only text and
 * post are replayed by the poller; the caller decides what to do with the rest.
 *
 * The post title keeps the component's `[title] body` shape.
 */
export function textFromContent(msgType, content, messageId, mentions) {
  let body = content;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== 'object') return null;
  if (msgType === 'text') {
    const text = typeof body.text === 'string' ? body.text : '';
    const resolved = resolveMentions(text, mentions);
    return resolved && resolved.trim() ? resolved : null;
  }
  if (msgType === 'post') {
    const { text } = extractPostText(Array.isArray(body.content) ? body.content : [], messageId);
    const full = body.title ? `[${body.title}] ${text}` : text;
    const resolved = resolveMentions(full, mentions);
    return resolved && resolved.trim() ? resolved : null;
  }
  return null;
}
