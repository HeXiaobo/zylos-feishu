/**
 * Feishu Messaging Functions
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getClient } from './client.js';
import { getCredentials, getProxyConfig } from './config.js';

/**
 * Get fresh access token for direct API calls
 */
async function getAccessToken() {
  const creds = getCredentials();
  const proxy = getProxyConfig();

  const res = await axios({
    method: 'POST',
    url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    headers: { 'Content-Type': 'application/json' },
    data: { app_id: creds.app_id, app_secret: creds.app_secret },
    timeout: 30000,
    proxy
  });

  return res.data.tenant_access_token;
}

/**
 * Send message to a chat (group or individual)
 */
export async function sendMessage(
  receiveId,
  content,
  receiveIdType = 'chat_id',
  msgType = 'text',
  options = {},
) {
  const client = getClient();

  let messageContent;
  if (msgType === 'text') {
    messageContent = JSON.stringify({ text: content });
  } else {
    messageContent = typeof content === 'string' ? content : JSON.stringify(content);
  }

  try {
    const data = {
      receive_id: receiveId,
      msg_type: msgType,
      content: messageContent,
    };
    if (typeof options.uuid === 'string' && options.uuid !== '') data.uuid = options.uuid;
    if (typeof options.replyInThread === 'boolean') data.reply_in_thread = options.replyInThread;
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data,
    });

    if (res.code === 0) {
      return {
        success: true,
        messageId: res.data.message_id,
        message: 'Message sent successfully',
      };
    } else {
      // Check for permission error
      const permErr = extractPermissionError({ response: { data: res } });
      if (permErr) {
        return {
          success: false,
          message: `Permission error: ${res.msg}`,
          code: res.code,
          permissionError: permErr,
        };
      }
      return {
        success: false,
        message: `Failed to send: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Reply to a specific message (used for thread/topic routing and reply threading).
 * Uses the im.message.reply API to create a reply in the same thread.
 */
export async function replyToMessage(messageId, content, msgType = 'text', options = {}) {
  const client = getClient();

  let messageContent;
  if (msgType === 'text') {
    messageContent = JSON.stringify({ text: content });
  } else {
    messageContent = typeof content === 'string' ? content : JSON.stringify(content);
  }

  try {
    const data = {
      msg_type: msgType,
      content: messageContent,
    };
    if (typeof options.uuid === 'string' && options.uuid !== '') data.uuid = options.uuid;
    const res = await client.im.message.reply({
      path: { message_id: messageId },
      data,
    });

    if (res.code === 0) {
      return {
        success: true,
        messageId: res.data.message_id,
        message: 'Reply sent successfully',
      };
    } else {
      return {
        success: false,
        message: `Failed to reply: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send message to a group chat
 */
export async function sendToGroup(chatId, content, msgType = 'text') {
  return sendMessage(chatId, content, 'chat_id', msgType);
}

/**
 * Send message to a user
 */
export async function sendToUser(userId, content, msgType = 'text') {
  const idType = userId.startsWith('ou_') ? 'open_id' : 'user_id';
  return sendMessage(userId, content, idType, msgType);
}

/**
 * List messages in a chat
 */
export async function listMessages(chatId, limit = 20, sortType = 'desc', startTime = null, endTime = null, containerIdType = 'chat') {
  const client = getClient();

  try {
    const params = {
      container_id_type: containerIdType,
      container_id: chatId,
      page_size: Math.min(limit, 50),
      sort_type: sortType === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
      user_id_type: 'open_id',
    };

    if (startTime) params.start_time = String(startTime);
    if (endTime) params.end_time = String(endTime);

    const res = await client.im.message.list({ params });

    if (res.code === 0) {
      const messages = (res.data.items || []).map(msg => ({
        id: msg.message_id,
        type: msg.msg_type,
        content: parseMessageContent(msg.body?.content, msg.msg_type),
        sender: msg.sender?.id,
        senderType: msg.sender?.sender_type,
        createTime: new Date(parseInt(msg.create_time)).toISOString(),
        mentions: msg.mentions || [],
      }));

      return { success: true, messages, hasMore: res.data.has_more };
    } else {
      return { success: false, message: `Failed to list messages: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function parseMessageContent(content, msgType) {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content);
    if (msgType === 'text') return parsed.text || '';
    return content;
  } catch {
    return content;
  }
}

// Keep the read-back contract in one place. `user_card_content` is required
// for Schema 2.0 cards; without it Feishu may return only the client-upgrade
// placeholder instead of the card's original body.
export const MESSAGE_GET_PARAMS = Object.freeze({
  user_id_type: 'open_id',
  card_msg_content_type: 'user_card_content',
});

function normalizeMessageReadOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('message read options must be an object');
  }
  return {
    client: options.client,
    request: options.request || axios,
    getToken: options.getToken || getAccessToken,
  };
}

function normalizeMessageId(messageId) {
  if (typeof messageId !== 'string' || messageId.trim() === '') {
    throw new TypeError('messageId must be a non-empty string');
  }
  return messageId.trim();
}

async function readMessage(messageId, options = {}) {
  const id = normalizeMessageId(messageId);
  const { client, request, getToken } = normalizeMessageReadOptions(options);
  if (client) {
    if (typeof client.im?.message?.get !== 'function') {
      throw new TypeError('client.im.message.get must be a function');
    }
    return client.im.message.get({
      path: { message_id: id },
      params: MESSAGE_GET_PARAMS,
    });
  }

  const token = await getToken();
  const params = new URLSearchParams(MESSAGE_GET_PARAMS);
  return request({
    method: 'GET',
    url: `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(id)}?${params}`,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
    proxy: getProxyConfig(),
  });
}

function apiResponse(response, fromHttpRequest) {
  return fromHttpRequest ? (response?.data ?? response) : response;
}

function parseMessageBody(raw, messageId) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`message ${messageId} has no readable body content`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`message ${messageId} body content is not valid JSON`, { cause: error });
  }
}

/**
 * Read the original content of an interactive card.
 *
 * The optional request/getToken hooks are a test seam. Production passes the
 * configured SDK client so Feishu/Lark domain selection stays centralized.
 */
export async function getInteractiveCardContent(messageId, options = {}) {
  const id = normalizeMessageId(messageId);
  const normalized = normalizeMessageReadOptions(options);
  try {
    const response = await readMessage(id, normalized);
    const body = apiResponse(response, !normalized.client);
    const item = body?.code === 0 ? body.data?.items?.[0] : null;
    if (!item) {
      return {
        success: false,
        message: `API error: ${body?.msg || 'interactive card content unavailable'}`,
        ...(body?.code === undefined ? {} : { code: body.code }),
      };
    }
    return {
      success: true,
      content: parseMessageBody(item.body?.content ?? item.content, id),
      mentions: item.mentions || [],
    };
  } catch (error) {
    console.error(`[feishu] getInteractiveCardContent error for ${id}: ${error.message}`);
    return { success: false, message: error.message };
  }
}

/**
 * Download image from Feishu message
 */
export async function downloadImage(messageId, imageKey, savePath) {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const res = await axios({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
      headers: { 'Authorization': 'Bearer ' + token },
      responseType: 'arraybuffer',
      timeout: 30000,
      proxy
    });

    if (res.data && res.data.length > 0) {
      fs.writeFileSync(savePath, res.data);
      return { success: true, path: savePath, message: 'Image downloaded successfully' };
    } else {
      return { success: false, message: 'No data in response' };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Upload image to Feishu
 */
export async function uploadImage(imagePath, imageType = 'message') {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const form = new FormData();
    form.append('image_type', imageType);
    form.append('image', fs.createReadStream(imagePath));

    const res = await axios({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/images',
      headers: {
        'Authorization': 'Bearer ' + token,
        ...form.getHeaders()
      },
      data: form,
      timeout: 30000,
      proxy
    });

    if (res.data.code === 0) {
      return { success: true, imageKey: res.data.data.image_key, message: 'Image uploaded successfully' };
    } else {
      return { success: false, message: `Failed to upload image: ${res.data.msg}`, code: res.data.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Send image message
 */
export async function sendImage(receiveId, imageKey, receiveIdType = 'chat_id') {
  const client = getClient();

  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });

    if (res.code === 0) {
      return { success: true, messageId: res.data.message_id, message: 'Image sent successfully' };
    } else {
      return { success: false, message: `Failed to send image: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Download file from Feishu message
 */
export async function downloadFile(messageId, fileKey, savePath) {
  try {
    const token = await getAccessToken();
    const proxy = getProxyConfig();

    const res = await axios({
      method: 'GET',
      url: `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
      headers: { 'Authorization': 'Bearer ' + token },
      responseType: 'arraybuffer',
      timeout: 30000,
      proxy
    });

    if (res.data && res.data.length > 0) {
      fs.writeFileSync(savePath, res.data);
      return { success: true, path: savePath, message: 'File downloaded successfully' };
    } else {
      return { success: false, message: 'No data in response' };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function inferFileType(ext) {
  const map = {
    '.opus': 'opus', '.mp4': 'mp4', '.pdf': 'pdf',
    '.doc': 'doc', '.docx': 'doc',
    '.xls': 'xls', '.xlsx': 'xls',
    '.ppt': 'ppt', '.pptx': 'ppt',
  };
  return map[(ext || '').toLowerCase()] || 'stream';
}

/**
 * Upload file to Feishu
 */
export async function uploadFile(filePath, fileType) {
  const client = getClient();

  try {
    if (!fileType) fileType = inferFileType(path.extname(filePath));

    const res = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: path.basename(filePath),
        file: fs.createReadStream(filePath),
      },
    });

    const fileKey = res.file_key ?? res.data?.file_key;
    if (fileKey) {
      return { success: true, fileKey, message: 'File uploaded successfully' };
    } else {
      return { success: false, message: `Failed to upload file: ${res.msg ?? JSON.stringify(res)}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Build a Feishu interactive card with markdown content.
 * Cards render markdown properly (code blocks, tables, links, etc.)
 * Uses schema 2.0 format for proper markdown rendering.
 */
export function buildMarkdownCard(text) {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

/**
 * Send a markdown card message to a chat.
 * Interactive cards render code blocks, tables, and formatting properly.
 */
export async function sendMarkdownCard(receiveId, text, receiveIdType = 'chat_id') {
  const client = getClient();
  const card = buildMarkdownCard(text);

  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        messageId: res.data.message_id,
        message: 'Markdown card sent successfully',
      };
    } else {
      return {
        success: false,
        message: `Failed to send markdown card: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Reply to a message with a markdown card.
 */
export async function replyMarkdownCard(messageId, text) {
  const client = getClient();
  const card = buildMarkdownCard(text);

  try {
    const res = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        messageId: res.data.message_id,
        message: 'Markdown card reply sent successfully',
      };
    } else {
      return {
        success: false,
        message: `Failed to reply with markdown card: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Add an emoji reaction to a message.
 * @param {string} messageId - Message to react to
 * @param {string} emojiType - Feishu emoji type (e.g., "THUMBSUP", "Typing")
 * @returns {{ success: boolean, reactionId?: string, message?: string }}
 */
export async function addReaction(messageId, emojiType) {
  const client = getClient();

  try {
    const res = await client.im.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: emojiType },
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        reactionId: res.data?.reaction_id,
        message: 'Reaction added',
      };
    } else {
      return {
        success: false,
        message: `Failed to add reaction: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Remove an emoji reaction from a message.
 * @param {string} messageId - Message containing the reaction
 * @param {string} reactionId - Reaction ID to remove
 */
export async function removeReaction(messageId, reactionId) {
  const client = getClient();

  try {
    const res = await client.im.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId,
      },
    });

    if (res.code === 0) {
      return { success: true, message: 'Reaction removed' };
    } else {
      return {
        success: false,
        message: `Failed to remove reaction: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Remove every Typing reaction the bot itself added to a message.
 * Unlike removeReaction this does not need a locally-tracked reactionId, so it
 * clears an orphaned typing indicator even when the local presence state was
 * lost (e.g. the reply-refactor v1 composition adds reactions via its own
 * presence ledger rather than the legacy typing store).
 * @param {string} messageId - Message to clear typing reactions from
 * @param {{ getClient?: Function }} [deps]
 * @returns {{ success: boolean, removed: number, message?: string }}
 */
export async function clearTypingReactions(messageId, { client = getClient() } = {}) {
  let removed = 0;
  try {
    const list = await client.im.messageReaction.list({
      path: { message_id: messageId },
      params: { reaction_type: 'Typing', page_size: 50 },
    });
    if (list?.code !== 0 || !Array.isArray(list.data?.items)) {
      return { success: false, removed: 0, message: list?.msg || 'reaction list failed' };
    }
    for (const item of list.data.items) {
      // A bot can only delete reactions it added itself.
      const isOwned = item.operator?.operator_type === 'app'
        && (!item.reaction_id || true);
      if (!isOwned || !item.reaction_id) continue;
      try {
        const del = await client.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: item.reaction_id },
        });
        if (del?.code === 0) removed += 1;
      } catch {
        // single-reaction delete failure must not block the rest
      }
    }
    return { success: true, removed };
  } catch (err) {
    return { success: false, removed, message: err.message };
  }
}

/**
 * Extract permission error info from Feishu API errors.
 * Detects error code 99991672 and extracts the grant URL for admin authorization.
 * @param {Error|object} err - The error from a Feishu API call
 * @returns {{ code: number, message: string, grantUrl?: string } | null}
 */
export function extractPermissionError(err) {
  if (!err || typeof err !== 'object') return null;

  // Check err.response.data (axios-style) or err directly
  const data = err.response?.data || err;
  if (!data || typeof data !== 'object') return null;

  const code = data.code;
  if (code !== 99991672) return null;

  const msg = data.msg || data.message || '';
  // Extract grant URL from the error message
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0];

  return { code, message: msg, grantUrl };
}

/**
 * Send file message
 */
export async function sendFile(receiveId, fileKey, receiveIdType = 'chat_id') {
  const client = getClient();

  try {
    const res = await client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });

    if (res.code === 0) {
      return { success: true, messageId: res.data.message_id, message: 'File sent successfully' };
    } else {
      return { success: false, message: `Failed to send file: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
