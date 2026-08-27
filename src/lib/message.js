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
