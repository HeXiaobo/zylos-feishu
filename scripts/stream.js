#!/usr/bin/env node

import { getClient } from '../src/lib/client.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';
import { createConversationResponseDelivery } from '../src/lib/conversation-response-delivery.js';

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
