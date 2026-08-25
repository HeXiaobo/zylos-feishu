#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

import { getClient } from '../src/lib/client.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';
import { createConversationResponseDelivery } from '../src/lib/conversation-response-delivery.js';

dotenv.config({ path: path.join(process.env.HOME || os.homedir(), 'zylos/.env') });

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const delivery = JSON.parse(raw);
    const stream = createConversationResponseStream({ client: getClient() });
    const result = await createConversationResponseDelivery({ stream }).deliver(delivery);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[feishu] Response stream delivery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
