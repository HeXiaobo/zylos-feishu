/**
 * Feishu config migrations shared by the install and upgrade hooks.
 *
 * Kept out of the hook scripts so both switch states are testable: the hooks
 * call `installConfig()` / `migrateConfig()`, and the tests call the same
 * functions with `{ arch2: false }` and `{ arch2: true }`.
 *
 * Rule for the master switch: with arch2 off, nothing new is added to the
 * config. An upgrade of an existing instance must produce the same file the
 * pre-arch2 component produced, otherwise the output format changes silently.
 */

// Baseline 8c0a3e2 seeded exactly this (see hooks/post-install.js at 8c0a3e2).
export const BASELINE_INITIAL_CONFIG = Object.freeze({
  enabled: true,
  connection_mode: 'websocket',
  webhook_port: 3458,
  message: { useMarkdownCard: true },
});

export function installConfig({ arch2 = false } = {}) {
  const config = structuredClone(BASELINE_INITIAL_CONFIG);
  if (arch2) config.message.alwaysCard = true;
  return config;
}

/**
 * Apply the config migrations to `input` in place and return the changed flag
 * plus the human-readable migration list.
 *
 * Only the steps that belong to this card live here; the import path is used by
 * hooks/post-upgrade.js so there is a single implementation.
 */
export function migrateMessageSettings(config, { arch2 = false } = {}) {
  const migrations = [];
  let migrated = false;

  if (!config.message) {
    config.message = { context_messages: 10 };
    migrated = true;
    migrations.push('Added message settings');
  } else if (config.message.context_messages === undefined) {
    config.message.context_messages = 10;
    migrated = true;
    migrations.push('Added message.context_messages');
  }
  if (config.message.max_length !== undefined) {
    delete config.message.max_length;
    migrated = true;
    migrations.push('Removed unused message.max_length');
  }

  // Migration 9 (baseline): markdown cards
  if (config.message.useMarkdownCard === undefined) {
    config.message.useMarkdownCard = true;
    migrated = true;
    migrations.push('Added message.useMarkdownCard=true');
  }

  // Arch2 only: default every message to a card. Off leaves the old output
  // format alone, so an upgrade with the switch off changes nothing.
  if (arch2 && config.message.alwaysCard === undefined) {
    config.message.alwaysCard = true;
    migrated = true;
    migrations.push('Added message.alwaysCard=true');
  }

  return { config, migrated, migrations };
}

export function migrateConfig(config, { arch2 = false } = {}) {
  return migrateMessageSettings(config, { arch2 });
}
