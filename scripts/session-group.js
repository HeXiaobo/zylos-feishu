#!/usr/bin/env node
/**
 * Print the in-group session name for a Feishu reply endpoint.
 * Usage: node scripts/session-group.js <endpoint>
 * Success: group name (without the `feishu:` namespace) on stdout, exit 0.
 * An endpoint with `|type:` is mapped directly. A bare chat id is resolved via
 * the local chat type cache or, on a miss, Feishu im.chat.get (~4s timeout, well
 * under Core's 6.5s query limit) and maps to dm-<id> or group-<id>.
 * Wrong arguments, an endpoint that cannot be mapped, or a failed lookup:
 * message on stderr, nothing on stdout, exit 1 (never guessed).
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { resolveSessionGroup } from '../src/lib/session-group.js';

// stdout carries only the group name (Core reads it). The Feishu SDK (loaded
// lazily on a cache miss) logs to console, e.g. "[info]: client ready", so
// route console output to stderr.
console.log = console.info = console.debug = (...args) => console.error(...args);

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node scripts/session-group.js <endpoint>');
  process.exit(1);
}
try {
  const name = await resolveSessionGroup(args[0]);
  process.stdout.write(`${name}\n`);
  // Exit explicitly: the Feishu SDK may keep sockets or timers alive.
  process.exit(0);
} catch (err) {
  console.error(`[feishu] session-group: ${err.message}`);
  process.exit(1);
}
