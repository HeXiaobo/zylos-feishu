#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-feishu
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *   ./send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"
 *   ./send.js <endpoint_id> "[MEDIA:file]/path/to/document.pdf"
 *   ./send.js <endpoint_id> "[MEDIA:card]/path/to/card.json"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, DATA_DIR } from '../src/lib/config.js';
import { chooseReplyTarget } from '../src/lib/reply-target.js';
import { sendCard } from '../src/lib/card-send.js';
import { convertAtMentionsForCard } from '../src/lib/at-mention.js';
import { sendToGroup as rawSendToGroup, sendMessage as rawSendMessage, uploadImage, sendImage as rawSendImage, uploadFile, sendFile as rawSendFile, replyToMessage as rawReplyToMessage, sendMarkdownCard as rawSendMarkdownCard, replyMarkdownCard as rawReplyMarkdownCard } from '../src/lib/message.js';
import { createDelivery } from '../src/lib/c4-delivery.js';
import { arch2Enabled } from '../src/lib/arch2.js';

// The delivery receipt (uuid reuse, C4_RESULT line, non-zero exit on an
// unconfirmed send) is an arch2 feature. With the master switch off the sender
// behaves exactly like baseline 8c0a3e2: no uuid, no receipt line, no extra
// failure modes, even if the caller passes C4_OUTBOUND_ID.
const ARCH2 = arch2Enabled();
const deliveryId = ARCH2 ? (process.env.C4_DELIVERY_ID || process.env.C4_OUTBOUND_ID) : undefined;
const delivery = createDelivery(deliveryId);
const sendToGroup = delivery.wrap(rawSendToGroup, 3);
const sendMessage = delivery.wrap(rawSendMessage, 4);
const sendImage = delivery.wrap(rawSendImage, 3);
const sendFile = delivery.wrap(rawSendFile, 3);
const replyToMessage = delivery.wrap(rawReplyToMessage, 3);
const sendMarkdownCard = delivery.wrap(rawSendMarkdownCard, 3);
const replyMarkdownCard = delivery.wrap(rawReplyMarkdownCard, 2);
// Synchronous exit hook also covers validation/disabled/usage failures.
if (ARCH2) {
  process.once('exit', code => {
    console.log(`C4_RESULT ${JSON.stringify(delivery.result(code))}`);
  });
}
import { shouldUseCard } from '../src/lib/card-decision.js';

const TYPING_DIR = path.join(DATA_DIR, 'typing');

const MAX_LENGTH = 2000;  // Feishu message max length

// Parse arguments
const args = process.argv.slice(2);

// A worker session (card F / review item 2) may not talk to people. Its own
// tools are `progress`/`report`/`ask`/`handback`; the front desk sends the
// result. This is the default guard for the channel, checked before any
// argument parsing so no argument combination can skip it.
//
// NOT a security boundary: the same system user can still call the Feishu API
// directly or unset the variable. Real isolation (separate OS identity, no
// channel credentials, read-only instance database) is next version.
if (process.env.ZYLOS_TICKET_ROLE === 'worker') {
  console.error('Error: worker sessions cannot send messages; report the result to the front desk instead');
  process.exit(1);
}

if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  console.error('       send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"');
  console.error('       send.js <endpoint_id> "[MEDIA:file]/path/to/file.pdf"');
  console.error('       send.js <endpoint_id> "[MEDIA:card]/path/to/card.json"');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

/**
 * Parse structured endpoint string.
 * Format: chatId|type:group|root:rootId|parent:parentId|msg:messageId
 * Backward compatible: plain chatId without | works as before.
 */
const ENDPOINT_KEYS = new Set(['type', 'root', 'parent', 'msg', 'thread']);

function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { chatId: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      if (!ENDPOINT_KEYS.has(key)) continue;
      const value = part.substring(colonIdx + 1);
      result[key] = value;
    }
  }
  return result;
}

const parsedEndpoint = parseEndpoint(rawEndpoint);
const endpointId = parsedEndpoint.chatId;

if (message.trim() === '[SKIP]') {
  markTypingDone(parsedEndpoint.msg);
  process.exit(deliveryId ? 1 : 0);
}

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: feishu is disabled in config');
  process.exit(1);
}

// Card directives are recognized on the full prefix BEFORE the generic media
// regex. The regex needs a non-empty `.+` and cannot match an embedded newline,
// so `[MEDIA:card]` with a missing path (or a path containing a newline) used to
// fall through to sendText() and go out as literal text. Every `[MEDIA:card]`
// input must reach card validation instead, including the empty path.
const CARD_MEDIA_PREFIX = '[MEDIA:card]';
const isCardMessage = message.startsWith(CARD_MEDIA_PREFIX);
const cardPath = isCardMessage ? message.slice(CARD_MEDIA_PREFIX.length) : '';
const mediaMatch = isCardMessage ? null : message.match(/^\[MEDIA:(\w+)\](.+)$/);

/**
 * Split long message into chunks (markdown-aware).
 * Ensures code blocks (```) are not split across chunks.
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      const finalChunk = remaining.trim();
      if (finalChunk.length > 0) {
        chunks.push(finalChunk);
      }
      break;
    }

    let breakAt = maxLength;

    // Check if we're inside a code block at the break point
    const segment = remaining.substring(0, breakAt);
    const fenceMatches = segment.match(/```/g);
    const insideCodeBlock = fenceMatches && fenceMatches.length % 2 !== 0;

    if (insideCodeBlock) {
      // Find the start of this unclosed code block and break before it
      const lastFenceStart = segment.lastIndexOf('```');
      // Look for a newline before the code fence to break cleanly
      const lineBeforeFence = remaining.lastIndexOf('\n', lastFenceStart - 1);
      if (lineBeforeFence > maxLength * 0.2) {
        breakAt = lineBeforeFence;
      } else {
        // Code block is too large; find its end and include the whole block
        const fenceEnd = remaining.indexOf('```', lastFenceStart + 3);
        if (fenceEnd !== -1) {
          const blockEnd = remaining.indexOf('\n', fenceEnd + 3);
          breakAt = blockEnd !== -1 ? blockEnd + 1 : fenceEnd + 3;
        }
        // If block end exceeds maxLength, fall back to hard break
        if (breakAt > maxLength) {
          breakAt = maxLength;
        }
      }
    } else {
      // Not inside code block: try to break at a clean boundary
      const chunk = remaining.substring(0, breakAt);

      // Prefer breaking at double newline (paragraph boundary)
      const lastParaBreak = chunk.lastIndexOf('\n\n');
      if (lastParaBreak > maxLength * 0.3) {
        breakAt = lastParaBreak + 1;
      } else {
        // Try to break at last newline
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline > maxLength * 0.3) {
          breakAt = lastNewline;
        } else {
          // Try to break at last space
          const lastSpace = chunk.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.3) {
            breakAt = lastSpace;
          }
        }
      }
    }

    const nextChunk = remaining.substring(0, breakAt).trim();
    if (nextChunk.length > 0) {
      chunks.push(nextChunk);
    }
    remaining = remaining.substring(breakAt).trim();
  }

  return chunks;
}


// Card max content length (Feishu card body limit ~28KB JSON; keep text under 4000 for safety)
const CARD_MAX_LENGTH = 4000;

/**
 * Send a single chunk as a markdown card, with routing logic.
 * Falls back to plain text on card failure.
 */
async function sendCardChunk(chunk, isFirstChunk) {
  const { chatId } = parsedEndpoint;
  // The card API speaks a different @-mention syntax than text messages do
  // (<at id=x></at> vs <at user_id="x">Name</at>). Callers write the text form —
  // it is the only one documented for c4-send and the one that works on the
  // text path — so convert here, or every mention in a markdown-bearing message
  // renders as literal text and notifies nobody. See src/lib/at-mention.js.
  const cardChunk = convertAtMentionsForCard(chunk);
  // p2p DMs never reply-to (invisible in the 1:1 view); only groups reply.
  const replyTarget = chooseReplyTarget(parsedEndpoint, { isFirstChunk });
  let result;

  if (replyTarget) {
    try {
      result = await replyMarkdownCard(replyTarget, cardChunk);
    } catch (err) {
      if (deliveryId) throw err;
      console.log('[feishu] Card reply threw, falling back:', err.message);
      result = { success: false };
    }
    if (!result.success) {
      result = await sendMarkdownCard(chatId, cardChunk);
    }
  } else {
    result = await sendMarkdownCard(chatId, cardChunk);
  }

  return result;
}

/**
 * Send text message with auto-chunking.
 * When useMarkdownCard is enabled and text contains markdown, sends as interactive card.
 * When message.alwaysCard is also true, every message is sent as a card even without markdown.
 * Routing logic (unified for DM and group):
 *   - Topic/reply (root exists): ALL chunks reply to parent||root (stay in thread)
 *   - Group @mention (no root): first chunk replies to msg, rest use sendToGroup
 *   - DM (no root): sendMessage directly
 *   - Fallback: sendToGroup
 * Reply failures fall back to sendMessage (DM) or sendToGroup (group).
 */
async function sendText(endpoint, text) {
  const useCard = shouldUseCard(config.message, text, ARCH2);
  const maxLen = useCard ? CARD_MAX_LENGTH : MAX_LENGTH;
  const chunks = splitMessage(text, maxLen);
  const { chatId, root, parent, msg, type } = parsedEndpoint;
  const isDM = type === 'p2p';
  const isGroup = type === 'group';

  for (let i = 0; i < chunks.length; i++) {
    let result;
    const isFirstChunk = i === 0;

    if (useCard) {
      result = await sendCardChunk(chunks[i], isFirstChunk);
      // Fall back to plain text if card sending fails
      if (!result.success) {
        console.log('[feishu] Card send failed, falling back to text:', result.message);
        // Re-split: card chunks (up to 4000) may exceed plain text limit (2000)
        const subChunks = splitMessage(chunks[i], MAX_LENGTH);
        for (let j = 0; j < subChunks.length; j++) {
          result = await sendPlainTextChunk(endpoint, subChunks[j], isFirstChunk && j === 0);
          if (!result.success) break;
        }
      }
    } else {
      result = await sendPlainTextChunk(endpoint, chunks[i], isFirstChunk);
    }

    if (!result.success) {
      throw new Error(result.message);
    }
    // Small delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (chunks.length > 1) {
    console.log(`Sent ${chunks.length} chunks`);
  }
}

/**
 * Send a single chunk as plain text with routing logic.
 */
async function sendPlainTextChunk(endpoint, chunk, isFirstChunk) {
  const { chatId, type } = parsedEndpoint;
  const isDM = type === 'p2p';
  // p2p DMs never reply-to (invisible in the 1:1 view); only groups reply.
  const replyTarget = chooseReplyTarget(parsedEndpoint, { isFirstChunk });
  let result;

  if (replyTarget) {
    try {
      result = await replyToMessage(replyTarget, chunk);
    } catch (err) {
      if (deliveryId) throw err;
      console.log('[feishu] Reply threw, falling back:', err.message);
      result = { success: false };
    }
    if (!result.success) {
      console.log('[feishu] Reply failed, falling back:', result.message);
      result = isDM
        ? await sendMessage(chatId, chunk, 'chat_id', 'text')
        : await sendToGroup(endpoint, chunk);
    }
  } else if (isDM) {
    result = await sendMessage(chatId, chunk, 'chat_id', 'text');
  } else {
    result = await sendToGroup(endpoint, chunk);
  }

  return result;
}

/**
 * Send media (image or file).
 * Thread-aware: in topic threads, reply to parent||root to stay in topic.
 */
async function sendMedia(type, filePath) {
  const trimmedPath = filePath.trim();
  const { chatId, root, parent } = parsedEndpoint;
  // p2p DMs never reply-to (invisible in the 1:1 view); only groups reply.
  const replyTarget = chooseReplyTarget(parsedEndpoint);

  if (type === 'image') {
    const uploadResult = await uploadImage(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload image: ${uploadResult.message}`);
    }
    if (replyTarget) {
      try {
        const result = await replyToMessage(replyTarget, JSON.stringify({ image_key: uploadResult.imageKey }), 'image');
        if (result.success) return;
        console.log('[feishu] Image reply failed, falling back to sendImage:', result.message);
        if (parent && root && parent !== root) {
          const rootReply = await replyToMessage(root, JSON.stringify({ image_key: uploadResult.imageKey }), 'image');
          if (rootReply.success) return;
          console.log('[feishu] Image root reply fallback failed, falling back to sendImage:', rootReply.message);
        }
      } catch (err) {
        if (deliveryId) throw err;
        console.log('[feishu] Image reply threw, falling back:', err.message);
        if (parent && root && parent !== root) {
          try {
            const rootReply = await replyToMessage(root, JSON.stringify({ image_key: uploadResult.imageKey }), 'image');
            if (rootReply.success) return;
          } catch (error) { if (deliveryId) throw error; }
        }
      }
    }
    const sendResult = await sendImage(chatId, uploadResult.imageKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send image: ${sendResult.message}`);
    }
  } else if (type === 'file') {
    const uploadResult = await uploadFile(trimmedPath);
    if (!uploadResult.success) {
      throw new Error(`Failed to upload file: ${uploadResult.message}`);
    }
    if (replyTarget) {
      try {
        const result = await replyToMessage(replyTarget, JSON.stringify({ file_key: uploadResult.fileKey }), 'file');
        if (result.success) return;
        console.log('[feishu] File reply failed, falling back to sendFile:', result.message);
        if (parent && root && parent !== root) {
          const rootReply = await replyToMessage(root, JSON.stringify({ file_key: uploadResult.fileKey }), 'file');
          if (rootReply.success) return;
          console.log('[feishu] File root reply fallback failed, falling back to sendFile:', rootReply.message);
        }
      } catch (err) {
        if (deliveryId) throw err;
        console.log('[feishu] File reply threw, falling back:', err.message);
        if (parent && root && parent !== root) {
          try {
            const rootReply = await replyToMessage(root, JSON.stringify({ file_key: uploadResult.fileKey }), 'file');
            if (rootReply.success) return;
          } catch (error) { if (deliveryId) throw error; }
        }
      }
    }
    const sendResult = await sendFile(chatId, uploadResult.fileKey);
    if (!sendResult.success) {
      throw new Error(`Failed to send file: ${sendResult.message}`);
    }
  } else {
    throw new Error(`Unsupported media type: ${type}`);
  }
}

/**
 * Write a typing-done marker file so index.js can remove the typing indicator.
 * The marker file name is the original trigger message ID.
 */
function markTypingDone(msgId) {
  if (!msgId) return;
  try {
    const safeMsgId = String(msgId).replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    const donePath = path.resolve(TYPING_DIR, `${safeMsgId}.done`);
    if (!donePath.startsWith(path.resolve(TYPING_DIR) + path.sep)) return;
    fs.writeFileSync(donePath, String(Date.now()));
  } catch {
    // Non-critical
  }
}

/**
 * Notify index.js to record the bot's outgoing message into in-memory history.
 */
async function recordOutgoing(text) {
  let internalSecret = process.env.FEISHU_INTERNAL_SECRET;
  if (!internalSecret) {
    // Fallback: read token from file (written by index.js at startup)
    try {
      internalSecret = fs.readFileSync(path.join(DATA_DIR, '.internal-token'), 'utf8').trim();
    } catch {}
  }
  if (!internalSecret) {
    console.warn('[feishu] Warning: FEISHU_INTERNAL_SECRET not set — record-outgoing will be rejected (403)');
    return;
  }
  const port = config.webhook_port || 3458;
  const safeText = String(text || '').slice(0, 4000);
  const body = JSON.stringify({
    chatId: parsedEndpoint.chatId,
    threadId: parsedEndpoint.thread || null,
    text: safeText
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': internalSecret,
      },
      body,
      signal: controller.signal
    });
  } catch { /* non-critical */ }
  finally {
    clearTimeout(timer);
  }
}

async function send() {
  try {
    if (isCardMessage) {
      // A card file is sent as-is: interactive, never degraded to text and
      // never truncated. Validation failures (including an empty path) throw
      // before anything is sent.
      const result = await sendCard(
        { ...parsedEndpoint, cardPath },
        { replyToMessage, sendMessage, noFallbackOnThrow: Boolean(deliveryId) },
      );
      console.log(`[feishu] card sent message_id=${result.messageId} via=${result.via}`);
      await recordOutgoing(`[sent card] ${result.summary}`);
    } else if (mediaMatch) {
      const [, mediaType, mediaPath] = mediaMatch;
      await sendMedia(mediaType, mediaPath);
      await recordOutgoing(mediaType === 'image' ? '[sent image]' : '[sent file]');
    } else {
      await sendText(endpointId, message);
      await recordOutgoing(message);
    }
    // Mark the trigger message as replied (for typing indicator removal)
    markTypingDone(parsedEndpoint.msg);
    if (deliveryId && delivery.result(0).status !== 'sent') throw new Error('No confirmed platform receipt');
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    // 每一次 attempt 怎么被拒的，逐条写一行到 stderr（PM2 的 error.log）。
    // 只打最后一条（err.message）等于把前几次飞书说的话丢掉：生产上 661/663
    // 两张卡失败后，日志里只剩 `ERR_CARD_SEND: 2300xx …`，看不出是结构问题。
    // 只记 via/code/message——不记卡片内容，也不记任何 token。
    if (isCardMessage && Array.isArray(err?.failures) && err.failures.length > 0) {
      err.failures.forEach((failure, index) => {
        console.error(`[feishu] card attempt ${index + 1}/${err.failures.length} via=${failure.via ?? '-'} `
          + `code=${failure.code ?? '-'} message=${String(failure.message ?? '').slice(0, 300)}`);
      });
    }
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
