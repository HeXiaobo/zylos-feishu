/**
 * Feishu Contact/User Functions
 */

import { getClient } from './client.js';

/**
 * Get user ID by email or mobile
 * @param {string} identifier - Email or mobile number
 */
export async function getUserId(identifier) {
  const client = getClient();

  // Determine if it's email or mobile
  const isEmail = identifier.includes('@');

  try {
    const requestData = isEmail
      ? { emails: [identifier] }
      : { mobiles: [identifier] };

    const res = await client.contact.user.batchGetId({
      params: {
        user_id_type: 'user_id',
      },
      data: requestData,
    });

    if (res.code === 0) {
      const userList = res.data.user_list || [];

      if (userList.length === 0) {
        return {
          success: false,
          message: `User not found: ${identifier}`,
        };
      }

      const user = userList[0];
      return {
        success: true,
        user: {
          userId: user.user_id,
          email: user.email,
          mobile: user.mobile,
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to get user ID: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Get user info by user_id or open_id
 * @param {string} userId - User ID (user_id) or Open ID (ou_xxx)
 */
export async function getUserInfo(userId) {
  const client = getClient();

  // Auto-detect ID type: ou_ prefix means open_id
  const idType = userId.startsWith('ou_') ? 'open_id' : 'user_id';

  try {
    const res = await client.contact.user.get({
      path: {
        user_id: userId,
      },
      params: {
        user_id_type: idType,
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        user: {
          userId: res.data.user?.user_id,
          openId: res.data.user?.open_id,
          name: res.data.user?.name,
          email: res.data.user?.email,
          mobile: res.data.user?.mobile,
          avatar: res.data.user?.avatar?.avatar_origin,
          departmentIds: res.data.user?.department_ids || [],
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to get user info: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
