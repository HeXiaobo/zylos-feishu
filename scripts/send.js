#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-feishu
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *   ./send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"
 *   ./send.js <endpoint_id> "[MEDIA:file]/path/to/document.pdf"
 *
 * Exit codes:
 *   0 - Success
 *   1 - Error
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, DATA_DIR, getCredentials } from '../src/lib/config.js';
import { chooseReplyTarget } from '../src/lib/reply-target.js';
import { convertAtMentionsForCard } from '../src/lib/at-mention.js';
import { sendToGroup, sendMessage, uploadImage, sendImage, uploadFile, sendFile, replyToMessage } from '../src/lib/message.js';
import { initMention, buildMentionContent, buildMentionMarkdown } from '../src/lib/mention.js';
import { getClient } from '../src/lib/client.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';
import {
  completedCardFailureAction,
  requestIdForC4Delivery,
} from '../src/lib/c4-delivery-policy.js';
import {
  parseTaskCommentReplyEndpoint,
} from '../src/lib/task-comment-production.js';
import { createTaskCommentReplyProduction } from '../src/lib/task-comment-reply-production.js';
import { isTaskCommentsEnabled } from '../src/lib/task-comment-runtime-policy.js';
import { isSilentResponse } from '../src/lib/silent-response.js';

const TYPING_DIR = path.join(DATA_DIR, 'typing');

const MAX_LENGTH = 2000;  // Feishu message max length

// Parse arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  console.error('       send.js <endpoint_id> "[MEDIA:image]/path/to/image.png"');
  console.error('       send.js <endpoint_id> "[MEDIA:file]/path/to/file.pdf"');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');
const taskCommentReplyEndpoint = parseTaskCommentReplyEndpoint(rawEndpoint);

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

if (isSilentResponse(message)) {
  markTypingDone(parsedEndpoint.msg);
  process.exit(0);
}

// Check if component is enabled
const config = getConfig();
if (!config.enabled) {
  console.error('Error: feishu is disabled in config');
  process.exit(1);
}

// Parse media prefix
const mediaMatch = message.match(/^\[MEDIA:(\w+)\](.+)$/);

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

/**
 * Send text message with auto-chunking.
 * When useMarkdownCard is enabled, all ordinary assistant text uses the same
 * completed response card as the direct streaming conversation path.
 * Routing logic (unified for DM and group):
 *   - Topic/reply (root exists): ALL chunks reply to parent||root (stay in thread)
 *   - Group @mention (no root): first chunk replies to msg, rest use sendToGroup
 *   - DM (no root): sendMessage directly
 *   - Fallback: sendToGroup
 * Reply failures fall back to sendMessage (DM) or sendToGroup (group).
 */
async function sendText(endpoint, text) {
  const useCard = config.message?.useMarkdownCard === true;
  const { chatId, type } = parsedEndpoint;
  const isDM = type === 'p2p';

  if (useCard) {
    const requestId = requestIdForC4Delivery(process.env);
    if (!requestId) {
      console.warn('[feishu] Unified card skipped: Core did not provide a stable C4 delivery identity');
    } else {
      const replyToMessageId = chooseReplyTarget(parsedEndpoint, { isFirstChunk: true }) || null;
      const cardText = convertAtMentionsForCard(buildMentionMarkdown(text));
      try {
        const responseStream = createConversationResponseStream({ client: getClient() });
        await responseStream.sendCompleted({
          requestId,
          target: {
            chatId,
            chatType: isDM ? 'p2p' : 'group',
            replyToMessageId,
          },
          output: cardText,
        });
        return;
      } catch (error) {
        if (completedCardFailureAction(error) !== 'fallback_text') throw error;
        console.log('[feishu] Completed card send failed, falling back to text:', error.message);
      }
    }
  }

  const chunks = splitMessage(text, MAX_LENGTH);

  for (let i = 0; i < chunks.length; i++) {
    const isFirstChunk = i === 0;
    const result = await sendPlainTextChunk(endpoint, chunks[i], isFirstChunk);

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

// Initialize mention system (loads cache + override_map, starts periodic sync)
initMention();

/**
 * Send a single chunk as plain text with routing logic.
 */
async function sendPlainTextChunk(endpoint, chunk, isFirstChunk) {
  const { chatId, type } = parsedEndpoint;
  const isDM = type === 'p2p';
  // p2p DMs never reply-to (invisible in the 1:1 view); only groups reply.
  const replyTarget = chooseReplyTarget(parsedEndpoint, { isFirstChunk });
  // Resolve configured @names before choosing the transport. Plain text stays
  // `text`; resolved mentions use Feishu's rich-text `post` representation.
  const { msgType, content } = buildMentionContent(chunk);
  let result;

  if (replyTarget) {
    try {
      result = await replyToMessage(replyTarget, content, msgType);
    } catch (err) {
      console.log('[feishu] Reply threw, falling back:', err.message);
      result = { success: false };
    }
    if (!result.success) {
      console.log('[feishu] Reply failed, falling back:', result.message);
      result = isDM
        ? await sendMessage(chatId, content, 'chat_id', msgType)
        : await sendToGroup(endpoint, content, msgType);
    }
  } else if (isDM) {
    result = await sendMessage(chatId, content, 'chat_id', msgType);
  } else {
    result = await sendToGroup(endpoint, content, msgType);
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
        console.log('[feishu] Image reply threw, falling back:', err.message);
        if (parent && root && parent !== root) {
          try {
            const rootReply = await replyToMessage(root, JSON.stringify({ image_key: uploadResult.imageKey }), 'image');
            if (rootReply.success) return;
          } catch {}
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
        console.log('[feishu] File reply threw, falling back:', err.message);
        if (parent && root && parent !== root) {
          try {
            const rootReply = await replyToMessage(root, JSON.stringify({ file_key: uploadResult.fileKey }), 'file');
            if (rootReply.success) return;
          } catch {}
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
    if (taskCommentReplyEndpoint) {
      if (!isTaskCommentsEnabled(process.env)) {
        throw new Error('Task comment replies are disabled');
      }
      if (mediaMatch) throw new Error('Task comment replies currently support text only');
      const [
        { getClient },
        { openTaskCommentStore },
        { loadTaskCommentReplyCoreDependencies },
      ] = await Promise.all([
        import('../src/lib/client.js'),
        import('../src/lib/task-comment-store.js'),
        import('../src/lib/task-comment-core-dependencies.js'),
      ]);
      const appId = getCredentials().app_id;
      if (!appId) throw new Error('FEISHU_APP_ID is required for Task comment replies');
      const scopedTaskCommentReplyEndpoint = parseTaskCommentReplyEndpoint(rawEndpoint, { appId });
      const { openCore, createCoordinator } = await loadTaskCommentReplyCoreDependencies({
        env: process.env,
      });
      const core = openCore();
      let store;
      try {
        store = openTaskCommentStore({ dbPath: path.join(DATA_DIR, 'task-comments.db') });
        const outbound = createTaskCommentReplyProduction({
          appId,
          core,
          store,
          client: getClient(),
          createCoordinator,
        });
        await outbound.reply({
          ...scopedTaskCommentReplyEndpoint,
          content: message,
        });
      } finally {
        try {
          store?.close();
        } finally {
          core.close();
        }
      }
    } else {
      const assistantRequestId = process.env.C4_ASSISTANT_REQUEST_ID || null;
      let streamed = false;
      if (assistantRequestId && !mediaMatch) {
        try {
          const responseStream = createConversationResponseStream({ client: getClient() });
          const result = await responseStream.completeWithFullAnswer({
            requestId: assistantRequestId,
            output: message,
          });
          streamed = result.handled === true;
        } catch (error) {
          // The placeholder already owns this assistant request. Any error here
          // is retried against that same durable stream; emitting a fresh
          // message would risk a duplicate after an ambiguous Feishu outcome.
          throw error;
        }
      }

      if (streamed) {
        await recordOutgoing(message);
      } else if (mediaMatch) {
        const [, mediaType, mediaPath] = mediaMatch;
        await sendMedia(mediaType, mediaPath);
        await recordOutgoing(mediaType === 'image' ? '[sent image]' : '[sent file]');
      } else {
        await sendText(endpointId, message);
        await recordOutgoing(message);
      }
    }
    // Mark the trigger message as replied (for typing indicator removal)
    markTypingDone(parsedEndpoint.msg);
    console.log('Message sent successfully');
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

send();
