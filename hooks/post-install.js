#!/usr/bin/env node
/**
 * Post-install hook for zylos-feishu
 *
 * Called during installation (both terminal and JSON/Claude modes).
 * Terminal mode (stdio: inherit): runs interactive prompts for config.
 * JSON mode (stdio: pipe): runs silently, skips interactive prompts.
 *
 * This hook handles feishu-specific setup:
 * - Create subdirectories (logs, media)
 * - Create default config.json
 * - Check for environment variables (informational)
 * - Prompt for connection mode and related config (terminal mode only)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  requireCompatibleCore,
  installLarkCliBinary,
  installLarkCliSkills,
  syncCredentialsToLarkCli,
} from './post-install-shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, '..');

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/feishu');
const ENV_FILE = path.join(HOME, 'zylos/.env');

// Minimal initial config - full defaults are in src/lib/config.js
const INITIAL_CONFIG = {
  enabled: true,
  connection_mode: 'websocket',
  webhook_port: 3458,
  message: { useMarkdownCard: true }
};

const isInteractive = process.stdin.isTTY === true;

/**
 * Prompt user for input (only works in terminal mode).
 */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

console.log('[post-install] Running feishu-specific setup...\n');

// 1. Create subdirectories
console.log('Creating subdirectories...');
fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true });
console.log('  - logs/');
console.log('  - media/');

// 2. Create default config if not exists
const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.log('\nCreating default config.json...');
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2));
  console.log('  - config.json created');
} else {
  console.log('\nConfig already exists, skipping.');
}

// 3. Check environment variables (informational)
console.log('\nChecking environment variables...');
let envContent = '';
try {
  envContent = fs.readFileSync(ENV_FILE, 'utf8');
} catch (e) {}

const hasAppId = envContent.includes('FEISHU_APP_ID');
const hasAppSecret = envContent.includes('FEISHU_APP_SECRET');

if (!hasAppId || !hasAppSecret) {
  console.log('  FEISHU_APP_ID and/or FEISHU_APP_SECRET not yet in .env.');
} else {
  console.log('  Credentials found.');
}

// 4. Connection mode and related config (terminal mode only)
if (isInteractive) {
  console.log('\nConnection Mode:');
  console.log('  1) websocket - Feishu SDK long connection (simpler, no public URL needed)');
  console.log('  2) webhook   - HTTP webhook (requires public URL + Caddy route)');
  const modeAnswer = await ask('\nChoose mode [1/2, default 1]: ');
  const mode = modeAnswer === '2' ? 'webhook' : 'websocket';

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.connection_mode = mode;

  if (mode === 'webhook') {
    // Verification token is required for webhook mode
    const token = await ask('\n  Verification Token (REQUIRED, from Event Subscriptions page): ');
    if (token) {
      config.bot = config.bot || {};
      config.bot.verification_token = token;
      console.log('  Verification token saved.');
    } else {
      console.log('  WARNING: Verification token is required for webhook mode.');
      console.log('  You must set bot.verification_token in config.json before starting.');
    }

    const encryptKey = await ask('  Encrypt Key (optional, for payload encryption) [press Enter to skip]: ');
    if (encryptKey) {
      config.bot = config.bot || {};
      config.bot.encrypt_key = encryptKey;
      console.log('  Encrypt key saved.');
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\n  Connection mode set to: ${mode}`);
}

// 5. lark-cli integration (idempotent — safe to re-run on reinstall)
requireCompatibleCore();
console.log('\nIntegrating lark-cli...');
try {
  installLarkCliBinary();
  installLarkCliSkills(SKILL_DIR);
  syncCredentialsToLarkCli();
} catch (err) {
  console.error('lark-cli integration failed:', err.message);
  process.exit(1);
}

// Note: PM2 service is started by Claude after this hook completes.

console.log('\n[post-install] Complete!');

// Read domain from zylos config for webhook URL display
let webhookUrl = 'https://<your-domain>/feishu/webhook';
try {
  const zylosConfig = JSON.parse(fs.readFileSync(path.join(HOME, 'zylos/.zylos/config.json'), 'utf8'));
  if (zylosConfig.domain) {
    const protocol = zylosConfig.protocol || 'https';
    webhookUrl = `${protocol}://${zylosConfig.domain}/feishu/webhook`;
  }
} catch (e) {}

// Read the chosen mode for appropriate instructions
let chosenMode = 'websocket';
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  chosenMode = config.connection_mode || 'websocket';
} catch (e) {}

console.log('\n========================================');
console.log('  Feishu (飞书) Setup — Remaining Steps');
console.log('========================================');
console.log('');
console.log('In the developer console: open.feishu.cn/app');
console.log('');
console.log('1. Enable "Bot" capability');
console.log('2. Subscribe to event: im.message.receive_v1');

if (chosenMode === 'webhook') {
  console.log(`3. Set subscription mode to "webhook"`);
  console.log(`4. Set Request URL: ${webhookUrl}`);
} else {
  console.log(`3. Set subscription mode to "长连接" (long connection / WebSocket)`);
}

console.log('');
console.log('First private message to the bot will auto-bind the sender as owner.');
console.log('========================================');
