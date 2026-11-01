// ESM loader used only by test/card-send-entry.test.js. It replaces the
// component's message module (the only place scripts/send.js talks to Feishu)
// with a local stub, so the real entry script can run inside a test without
// network access.
import fs from 'node:fs';

const STUB = new URL('./card-entry-message-stub.mjs', import.meta.url);

export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/lib/message.js')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: fs.readFileSync(STUB, 'utf8'),
    };
  }
  return nextLoad(url, context);
}
