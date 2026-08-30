/**
 * Feishu SDK Client
 * Handles authentication and provides client instance
 *
 * Credentials from environment variables:
 * - FEISHU_APP_ID
 * - FEISHU_APP_SECRET
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { getCredentials } from './config.js';

let clientInstance = null;

/**
 * Create and return Feishu client instance
 */
export function getClient() {
  if (clientInstance) {
    return clientInstance;
  }

  const creds = getCredentials();

  if (!creds.app_id || !creds.app_secret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in ~/zylos/.env');
  }

  clientInstance = new lark.Client({
    appId: creds.app_id,
    appSecret: creds.app_secret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,  // Chinese version (feishu.cn)
    loggerLevel: lark.LoggerLevel.error,
  });

  return clientInstance;
}

/**
 * Reset client instance (useful for config changes)
 */
export function resetClient() {
  clientInstance = null;
}

/**
 * Get bot info (open_id, name, etc.)
 * Uses the /bot/v3/info endpoint
 */
export async function getBotInfo() {
  const client = getClient();
  try {
    const res = await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    if (res.code === 0 && res.bot) {
      return {
        success: true,
        open_id: res.bot.open_id,
        app_name: res.bot.app_name,
      };
    }
    return { success: false, message: `API error: ${res.msg}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Test authentication by getting tenant access token
 */
export async function testAuth() {
  const client = getClient();

  try {
    // Try to list chats as a simple auth test
    const res = await client.im.chat.list({
      params: {
        page_size: 1
      }
    });

    if (res.code === 0) {
      return { success: true, message: 'Authentication successful' };
    } else {
      return { success: false, message: `API error: ${res.msg}`, code: res.code };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
