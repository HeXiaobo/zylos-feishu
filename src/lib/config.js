/**
 * Configuration loader for zylos-feishu
 *
 * Loads config from ~/zylos/components/feishu/config.json
 * Secrets from ~/zylos/.env (FEISHU_APP_ID, FEISHU_APP_SECRET)
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/feishu');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Default configuration
export const DEFAULT_CONFIG = {
  enabled: true,
  // Connection mode: 'websocket' (SDK WSClient) or 'webhook' (Express HTTP server)
  connection_mode: 'websocket',
  webhook_port: 3458,
  // Bot settings
  bot: {
    encrypt_key: '',
    verification_token: ''
  },
  // Owner (primary partner) - must be explicitly configured by a trusted operator
  owner: {
    bound: false,
    user_id: '',
    open_id: '',
    name: ''
  },
  // DM policy: 'open' (anyone can DM), 'allowlist' (only dmAllowFrom), 'owner' (owner only)
  dmPolicy: 'owner',
  // DM allowlist — user_id or open_id values (used when dmPolicy = 'allowlist')
  dmAllowFrom: [],
  // Optional F2 member policy. null preserves the legacy dmPolicy behavior.
  // Supported modes: owner, tenant_members, departments, allowlist.
  // Non-owner modes require an exact tenantKey and are audited per decision.
  memberAccessPolicy: null,
  workIntake: {
    enabled: false,
    timeZone: 'Asia/Shanghai',
    confirmationTtlMs: 15 * 60 * 1000,
  },
  // Group policy: 'open' (all groups), 'allowlist' (only configured groups), 'disabled' (no groups)
  groupPolicy: 'allowlist',
  // Per-group configuration map
  // Format: { "oc_xxx": { name, mode, requireMention, allowFrom, historyLimit } }
  // mode: "mention" (respond to @mentions) or "smart" (receive all messages)
  groups: {},
  // Legacy fields (kept for backward compatibility, migrated to groups on upgrade)
  // group_whitelist: { enabled: true },
  // allowed_groups: [],
  // smart_groups: [],
  // Proxy settings (optional)
  proxy: {
    enabled: false,
    host: '',
    port: 0
  },
  // Message settings
  message: {
    context_messages: 10,
    useMarkdownCard: true,
    streamProcessDisplay: 'collapsible',
    responseStreamQueuedTimeoutMs: 60_000,
    responseStreamMainTimeoutMs: 900_000,
  }
};

let config = null;
let configWatcher = null;
let configReloadTimer = null;

/**
 * Load configuration from file
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        workIntake: {
          ...DEFAULT_CONFIG.workIntake,
          ...(parsed.workIntake || {}),
        },
      };
      // Runtime backward-compat: derive groupPolicy from legacy group_whitelist,
      // but only if the file doesn't already have an explicit groupPolicy
      if (config.group_whitelist !== undefined && !('groupPolicy' in parsed)) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
      }
      // Runtime backward-compat: derive dmPolicy for configs without explicit dmPolicy
      if (!('dmPolicy' in parsed)) {
        if (config.whitelist) {
          // Has legacy whitelist → derive from it
          const wlEnabled = config.whitelist.private_enabled ?? config.whitelist.enabled ?? false;
          config.dmPolicy = wlEnabled ? 'allowlist' : 'open';
          if (!('dmAllowFrom' in parsed)) {
            const legacyUsers = [
              ...(config.whitelist.private_users || []),
              ...(config.whitelist.group_users || [])
            ];
            if (legacyUsers.length) {
              config.dmAllowFrom = legacyUsers;
            }
          }
        } else {
          // Pre-whitelist era config → default to owner (safest default).
          // An unconfigured owner fails closed; inbound messages never bootstrap ownership.
          config.dmPolicy = 'owner';
        }
      }
    } else {
      console.warn(`[feishu] Config file not found: ${CONFIG_PATH}`);
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[feishu] Failed to load config: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

/**
 * Get current configuration
 */
export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

export function getStreamProcessDisplay(value = getConfig()) {
  const configured = value?.message?.streamProcessDisplay;
  return ['collapsible', 'answer_only'].includes(configured)
    ? configured
    : DEFAULT_CONFIG.message.streamProcessDisplay;
}

export function getResponseStreamQueuedTimeoutMs(value = getConfig()) {
  const configured = value?.message?.responseStreamQueuedTimeoutMs;
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CONFIG.message.responseStreamQueuedTimeoutMs;
}

export function getResponseStreamMainTimeoutMs(value = getConfig()) {
  const configured = value?.message?.responseStreamMainTimeoutMs;
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CONFIG.message.responseStreamMainTimeoutMs;
}

/**
 * Save configuration to file
 */
export function saveConfig(newConfig) {
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[feishu] Failed to save config: ${err.message}`);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    return false;
  }
}

/**
 * Watch config file for changes
 */
export function watchConfig(onChange) {
  if (configWatcher) {
    configWatcher.close();
  }
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }

  const configDir = path.dirname(CONFIG_PATH);
  const configBase = path.basename(CONFIG_PATH);

  const scheduleReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (!fs.existsSync(CONFIG_PATH)) {
        console.warn('[feishu] Config file missing after fs.watch event, skipping reload');
        return;
      }
      console.log('[feishu] Config file changed, reloading...');
      loadConfig();
      if (onChange) {
        onChange(config);
      }
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) {
        scheduleReload();
      }
    });
    configWatcher.on('error', (err) => {
      console.warn(`[feishu] Config watcher error: ${err.message}`);
      if (configReloadTimer) {
        clearTimeout(configReloadTimer);
        configReloadTimer = null;
      }
      try {
        configWatcher.close();
      } catch {}
      configWatcher = null;
    });
  }
}

/**
 * Stop watching config file
 */
export function stopWatching() {
  if (configReloadTimer) {
    clearTimeout(configReloadTimer);
    configReloadTimer = null;
  }
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
}

/**
 * Get credentials from environment
 */
export function getCredentials() {
  return {
    app_id: process.env.FEISHU_APP_ID || '',
    app_secret: process.env.FEISHU_APP_SECRET || ''
  };
}

/**
 * Get proxy config for axios
 */
export function getProxyConfig() {
  const cfg = getConfig();
  if (cfg.proxy?.enabled && cfg.proxy?.host && cfg.proxy?.port) {
    return {
      host: cfg.proxy.host,
      port: cfg.proxy.port
    };
  }
  return false;
}
