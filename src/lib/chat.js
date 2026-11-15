/**
 * Feishu Chat/Group Functions
 */

import { getClient } from './client.js';

/**
 * List all chats the bot is in
 * @param {number} limit - Number of chats to fetch
 */
export async function listChats(limit = 50) {
  const client = getClient();

  try {
    const res = await client.im.chat.list({
      params: {
        page_size: Math.min(limit, 100),
      },
    });

    if (res.code === 0) {
      const chats = (res.data.items || []).map(chat => ({
        id: chat.chat_id,
        name: chat.name,
        description: chat.description,
        memberCount: chat.user_count,
        chatType: chat.chat_type,  // 'group' or 'p2p'
      }));

      return {
        success: true,
        chats,
        hasMore: res.data.has_more,
      };
    } else {
      return {
        success: false,
        message: `Failed to list chats: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Search chats by keyword
 * @param {string} query - Search keyword
 */
export async function searchChats(query) {
  const client = getClient();

  try {
    const res = await client.im.chat.search({
      params: {
        query: query,
        page_size: 20,
      },
    });

    if (res.code === 0) {
      const chats = (res.data.items || []).map(chat => ({
        id: chat.chat_id,
        name: chat.name,
        description: chat.description,
        memberCount: chat.user_count,
      }));

      return {
        success: true,
        chats,
        hasMore: res.data.has_more,
      };
    } else {
      return {
        success: false,
        message: `Failed to search chats: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * List chat members
 * @param {string} chatId - Chat ID
 */
export async function listChatMembers(chatId, memberIdType = 'open_id') {
  const client = getClient();

  try {
    const allMembers = [];
    let pageToken;

    do {
      const params = {
        page_size: 100,
        member_id_type: memberIdType,
      };
      if (pageToken) params.page_token = pageToken;

      const res = await client.im.chatMembers.get({
        path: { chat_id: chatId },
        params,
      });

      if (res.code !== 0) {
        return {
          success: false,
          message: `Failed to list members: ${res.msg}`,
          code: res.code,
        };
      }

      const members = (res.data.items || []).map(member => ({
        memberId: member.member_id,
        memberType: member.member_id_type,
        name: member.name,
        tenantKey: member.tenant_key,
      }));
      allMembers.push(...members);

      pageToken = res.data.has_more ? res.data.page_token : null;
    } while (pageToken);

    return {
      success: true,
      members: allMembers,
      memberCount: allMembers.length,
    };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Get chat info
 * @param {string} chatId - Chat ID
 */
export async function getChatInfo(chatId) {
  const client = getClient();

  try {
    const res = await client.im.chat.get({
      path: {
        chat_id: chatId,
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        chat: {
          id: res.data.chat_id,
          name: res.data.name,
          description: res.data.description,
          memberCount: res.data.user_count,
          owner: res.data.owner_id,
          external: res.data.external,
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to get chat info: ${res.msg}`,
        // Kept verbatim so a missing-scope denial can name the scope (#162).
        msg: res.msg,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
