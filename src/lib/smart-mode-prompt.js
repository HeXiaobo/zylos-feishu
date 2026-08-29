/**
 * Build the policy prompt used when a Smart-group message is evaluated
 * without an explicit bot mention.
 *
 * Keep this as a pure function so the prompt contract can be verified without
 * starting the Feishu transport or invoking a model.
 */
export function buildSmartModePrompt() {
  return `<smart-mode>
Decide whether to respond. Default is SILENCE.
Reply when you are @-mentioned.
When NOT @-mentioned, reply ONLY if BOTH hold:
  (a) nobody else present is likely to say this, AND
  (b) staying silent would let someone act on wrong information or wait for nothing.
Do NOT add to a point someone has already answered.
Being able to answer is not a reason to answer.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>\n\n`;
}
