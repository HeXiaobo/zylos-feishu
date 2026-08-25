#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-feishu
 *
 * Called by Claude after CLI upgrade completes (zylos upgrade --json).
 * CLI handles: stop service, backup, file sync, npm install, manifest.
 *
 * This hook handles component-specific migrations:
 * - Config schema migrations
 * - Data format updates
 *
 * Note: Service restart is handled by Claude after this hook.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  requireCompatibleCore,
  installLarkCliBinary,
  installLarkCliSkills,
  syncCredentialsToLarkCli,
} from './post-install-shared.js';

requireCompatibleCore();

const __filename_hook = fileURLToPath(import.meta.url);
const __dirname_hook = path.dirname(__filename_hook);
const SKILL_DIR = path.resolve(__dirname_hook, '..');

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.backup.${timestampSuffix()}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function atomicWriteJSON(filePath, obj) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/feishu');
const configPath = path.join(DATA_DIR, 'config.json');

console.log('[post-upgrade] Running feishu-specific migrations...\n');

// Config migrations
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let migrated = false;
    const migrations = [];

    // Migration 1: Ensure enabled field
    if (config.enabled === undefined) {
      config.enabled = true;
      migrated = true;
      migrations.push('Added enabled field');
    }

    // Migration 2: Ensure webhook_port
    if (config.webhook_port === undefined) {
      config.webhook_port = 3458;
      migrated = true;
      migrations.push('Added webhook_port');
    }

    // Migration 3: Ensure bot settings
    if (!config.bot) {
      config.bot = { encrypt_key: '' };
      migrated = true;
      migrations.push('Added bot settings');
    }
    // Ensure verification_token exists (required for webhook mode)
    if (config.bot.verification_token === undefined) {
      config.bot.verification_token = '';
      migrated = true;
      migrations.push('Added bot.verification_token placeholder');
    }

    // Migration 4: Ensure owner structure
    if (!config.owner) {
      config.owner = { bound: false, user_id: '', open_id: '', name: '' };
      migrated = true;
      migrations.push('Added owner structure');
    }

    // Migration 5: Migrate legacy whitelist → dmPolicy/dmAllowFrom
    if (config.whitelist && !config.dmPolicy) {
      const wlEnabled = config.whitelist.private_enabled ?? config.whitelist.enabled ?? false;
      config.dmPolicy = wlEnabled ? 'allowlist' : 'open';
      const legacyUsers = [
        ...(config.whitelist.private_users || []),
        ...(config.whitelist.group_users || [])
      ];
      if (legacyUsers.length) {
        config.dmAllowFrom = [...(config.dmAllowFrom || [])];
        for (const u of legacyUsers) {
          if (!config.dmAllowFrom.includes(u)) config.dmAllowFrom.push(u);
        }
      }
      migrations.push(`Migrated whitelist → dmPolicy=${config.dmPolicy}, ${(config.dmAllowFrom || []).length} users in dmAllowFrom`);
      delete config.whitelist;
      migrated = true;
    }
    if (config.dmPolicy === undefined) {
      // Pre-whitelist config (very old, no whitelist field at all).
      // Default to 'owner' — the most restrictive safe default.
      // Owner binding handles bootstrap: first DM user becomes owner.
      config.dmPolicy = 'owner';
      migrated = true;
      migrations.push(`Added dmPolicy=${config.dmPolicy}`);
    }
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
      migrated = true;
      migrations.push('Added dmAllowFrom');
    }

    // Migration 6: Migrate legacy allowed_groups/smart_groups → groups map + groupPolicy
    if (!config.groups && (Array.isArray(config.allowed_groups) || Array.isArray(config.smart_groups))) {
      const groups = {};

      // Migrate allowed_groups → mode: "mention"
      if (Array.isArray(config.allowed_groups)) {
        for (const g of config.allowed_groups) {
          if (g.chat_id) {
            groups[g.chat_id] = {
              name: g.name || '',
              mode: 'mention',
              requireMention: true,
            };
          }
        }
      }

      // Migrate smart_groups → mode: "smart" (override if already in map)
      if (Array.isArray(config.smart_groups)) {
        for (const g of config.smart_groups) {
          if (g.chat_id) {
            groups[g.chat_id] = {
              name: g.name || '',
              mode: 'smart',
              requireMention: false,
            };
          }
        }
      }

      config.groups = groups;

      // Set groupPolicy based on existing group_whitelist setting
      if (config.group_whitelist?.enabled === false) {
        config.groupPolicy = 'open';
      } else {
        config.groupPolicy = 'allowlist';
      }

      // Preserve legacy fields as backup
      if (config.allowed_groups?.length > 0) {
        config._legacy_allowed_groups = config.allowed_groups;
      }
      if (config.smart_groups?.length > 0) {
        config._legacy_smart_groups = config.smart_groups;
      }

      // Remove legacy fields
      delete config.allowed_groups;
      delete config.smart_groups;
      delete config.group_whitelist;

      migrated = true;
      migrations.push(`Migrated ${Object.keys(groups).length} groups to new groups map format`);
    }

    // Ensure groups and groupPolicy exist
    if (config.groups === undefined) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
    }
    if (config.groupPolicy === undefined) {
      // Derive from group_whitelist if present before defaulting
      if (config.group_whitelist !== undefined) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
        migrations.push(`Derived groupPolicy=${config.groupPolicy} from group_whitelist`);
        config._legacy_group_whitelist = config.group_whitelist;
        delete config.group_whitelist;
      } else {
        config.groupPolicy = 'allowlist';
        migrations.push('Added groupPolicy (default: allowlist)');
      }
      migrated = true;
    }

    // Migration 7 (legacy): Ensure proxy settings
    if (!config.proxy) {
      config.proxy = { enabled: false, host: '', port: 0 };
      migrated = true;
      migrations.push('Added proxy settings');
    }

    // Migration 8: Ensure message settings
    if (!config.message) {
      config.message = { context_messages: 10 };
      migrated = true;
      migrations.push('Added message settings');
    } else {
      if (config.message.context_messages === undefined) {
        config.message.context_messages = 10;
        migrated = true;
        migrations.push('Added message.context_messages');
      }
      // Clean up removed field
      if (config.message.max_length !== undefined) {
        delete config.message.max_length;
        migrated = true;
        migrations.push('Removed unused message.max_length');
      }
    }

    // Migration 9: Default useMarkdownCard to true
    if (config.message.useMarkdownCard === undefined) {
      config.message.useMarkdownCard = true;
      migrated = true;
      migrations.push('Added message.useMarkdownCard=true');
    }

    // Migration 10: Migrate legacy group config to new groups map
    if ((Array.isArray(config.allowed_groups) && config.allowed_groups.length > 0) ||
        (Array.isArray(config.smart_groups) && config.smart_groups.length > 0) ||
        (config.group_whitelist !== undefined && !config.groupPolicy)) {

      if (!config.groups) config.groups = {};

      // Migrate allowed_groups → groups with mode: "mention"
      if (Array.isArray(config.allowed_groups) && config.allowed_groups.length > 0) {
        for (const g of config.allowed_groups) {
          if (g.chat_id && !config.groups[g.chat_id]) {
            config.groups[g.chat_id] = {
              name: g.name || 'unnamed',
              mode: 'mention',
              requireMention: true,
              added_at: g.added_at || new Date().toISOString()
            };
            migrations.push(`Migrated allowed_group ${g.chat_id} → groups[mention]`);
          }
        }
        config._legacy_allowed_groups = config.allowed_groups;
        delete config.allowed_groups;
        migrated = true;
      }

      // Migrate smart_groups → groups with mode: "smart"
      if (Array.isArray(config.smart_groups) && config.smart_groups.length > 0) {
        for (const g of config.smart_groups) {
          if (g.chat_id) {
            config.groups[g.chat_id] = {
              name: g.name || config.groups[g.chat_id]?.name || 'unnamed',
              mode: 'smart',
              requireMention: false,
              added_at: g.added_at || config.groups[g.chat_id]?.added_at || new Date().toISOString()
            };
            migrations.push(`Migrated smart_group ${g.chat_id} → groups[smart]`);
          }
        }
        config._legacy_smart_groups = config.smart_groups;
        delete config.smart_groups;
        migrated = true;
      }

      // Migrate group_whitelist → groupPolicy
      if (config.group_whitelist !== undefined && !config.groupPolicy) {
        config.groupPolicy = config.group_whitelist?.enabled !== false ? 'allowlist' : 'open';
        migrations.push(`Migrated group_whitelist → groupPolicy=${config.groupPolicy}`);
        config._legacy_group_whitelist = config.group_whitelist;
        delete config.group_whitelist;
        migrated = true;
      }
    }

    // Ensure groupPolicy exists
    if (!config.groupPolicy) {
      config.groupPolicy = 'allowlist';
      migrated = true;
      migrations.push('Added groupPolicy=allowlist');
    }

    // Ensure groups map exists
    if (!config.groups) {
      config.groups = {};
      migrated = true;
      migrations.push('Added groups map');
    }

    // Save if migrated
    if (migrated) {
      const backupPath = backupConfigFile(configPath);
      if (backupPath) console.log(`[post-upgrade] Backed up config to ${path.basename(backupPath)}`);
      atomicWriteJSON(configPath, config);
      console.log('Config migrations applied:');
      migrations.forEach(m => console.log('  - ' + m));
    } else {
      console.log('No config migrations needed.');
    }
  } catch (err) {
    console.error('Config migration failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('No config file found, skipping migrations.');
}

// lark-cli integration migration
//
// Legacy zylos-feishu installs (pre-bundle) have only .env credentials and
// no lark-cli on PATH / no references/. This block brings them in line
// with the current install layout. All three steps are idempotent:
//   - installLarkCliBinary:    no-op when `lark-cli` is already at target version
//   - installLarkCliSkills:    no-op when all sub-skills present at target version
//   - syncCredentialsToLarkCli: overwrites keychain every run, so secret
//                                rotations propagate after `zylos upgrade feishu`
console.log('\nEnsuring lark-cli integration is in place...');
try {
  installLarkCliBinary();
  installLarkCliSkills(SKILL_DIR);
  syncCredentialsToLarkCli();
} catch (err) {
  console.error('lark-cli integration migration failed:', err.message);
  process.exit(1);
}

console.log('\n[post-upgrade] Complete!');
