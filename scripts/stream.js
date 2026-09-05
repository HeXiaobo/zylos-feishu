#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

import { getClient } from '../src/lib/client.js';
import {
  DATA_DIR,
  getConfig,
  getResponseStreamMainTimeoutMs,
  getStreamProcessDisplay,
} from '../src/lib/config.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';
import { createConversationResponseRuntimeAdapter } from '../src/lib/conversation-response-runtime-adapter.js';
import { openTypingDoneMarkerStore } from '../src/lib/typing-done-marker.js';
import { clearTypingReactions } from '../src/lib/message.js';

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
    const config = getConfig();
    const stream = createConversationResponseStream({
      client: getClient(),
      processDisplay: getStreamProcessDisplay(config),
      mainTimeoutMs: getResponseStreamMainTimeoutMs(config),
    });
    const result = await createConversationResponseRuntimeAdapter({
      stream,
      markers: openTypingDoneMarkerStore({ directory: path.join(DATA_DIR, 'typing') }),
      onTerminalMark: async (messageId) => {
        const cleared = await clearTypingReactions(messageId, { client: getClient() });
        if (cleared?.removed > 0) {
          console.log(`[feishu] Cleared ${cleared.removed} typing reaction(s) for ${messageId}`);
        }
      },
    }).deliver(delivery);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[feishu] Response stream delivery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
