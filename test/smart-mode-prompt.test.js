import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSmartModePrompt } from '../src/lib/smart-mode-prompt.js';

test('smart mode prompt defaults to silence and requires a missing critical answer', () => {
  assert.equal(buildSmartModePrompt(), `<smart-mode>
Decide whether to respond. Default is SILENCE.
Reply when you are @-mentioned.
When NOT @-mentioned, reply ONLY if BOTH hold:
  (a) nobody else present is likely to say this, AND
  (b) staying silent would let someone act on wrong information or wait for nothing.
Do NOT add to a point someone has already answered.
Being able to answer is not a reason to answer.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>\n\n`);
});
