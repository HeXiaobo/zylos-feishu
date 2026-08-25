#!/usr/bin/env node

import { getClient } from '../src/lib/client.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';

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
    if (
      delivery?.schemaVersion !== 1
      || typeof delivery.requestId !== 'string'
      || !Array.isArray(delivery.events)
    ) {
      throw new TypeError('invalid C4 assistant response delivery');
    }
    const stream = createConversationResponseStream({ client: getClient() });
    const result = await stream.apply({
      requestId: delivery.requestId,
      events: delivery.events,
    });
    if (!result.handled && result.reason === 'stream_not_found') {
      // A missing local placeholder after C4 accepted the request is a real
      // recovery failure.  Returning non-zero keeps the durable event pending
      // for retry/dead-letter instead of silently discarding the response.
      throw new Error('Feishu response stream placeholder is missing');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stderr.write(`[feishu] Response stream delivery failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

main();
