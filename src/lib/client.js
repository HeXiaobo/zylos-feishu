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
import { explainBotInfoError } from './bot-identity.js';

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
  });

  return clientInstance;
}

/**
 * Reset client instance (useful for config changes)
 */
export function resetClient() {
  clientInstance = null;
}

export const BOT_INFO_TIMEOUT_MS = 10_000;

/**
 * Get bot info (open_id, name, etc.)
 * Uses the /bot/v3/info endpoint
 */
export async function getBotInfo() {
  const client = getClient();
  // Bounded so a hung request (the SDK's axios instance has no timeout, and
  // the tenant-token fetch it makes first takes no per-call timeout) cannot
  // leave the caller waiting forever. `timeout` also reaches axios for the
  // bot/info request itself.
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`bot info request timed out after ${BOT_INFO_TIMEOUT_MS}ms`)), BOT_INFO_TIMEOUT_MS);
    });
    const res = await Promise.race([
      client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        timeout: BOT_INFO_TIMEOUT_MS,
      }),
      timeout,
    ]);
    if (res.code === 0 && res.bot) {
      return {
        success: true,
        open_id: res.bot.open_id,
        app_name: res.bot.app_name,
      };
    }
    return { success: false, message: `API error: ${res.msg}` };
  } catch (err) {
    return { success: false, message: explainBotInfoError(err.message) };
  } finally {
    clearTimeout(timer);
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
