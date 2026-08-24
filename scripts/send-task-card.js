#!/usr/bin/env node

import path from 'node:path';

import dotenv from 'dotenv';

import { sendMessage } from '../src/lib/message.js';
import { sendTaskCardCommand } from '../src/lib/task-card-send-command.js';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

try {
  const result = await sendTaskCardCommand({
    args: process.argv.slice(2),
    env: process.env,
  }, {
    clock: Date.now,
    sendMessage,
  });
  console.log(JSON.stringify({ ok: true, result }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: { message: error.message },
  }));
  process.exitCode = 1;
}
