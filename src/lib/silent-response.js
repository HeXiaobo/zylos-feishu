const TERMINAL_SKIP = /(?:^|\r?\n)[\t ]*\[SKIP\][\t ]*$/;

/**
 * Return true only when the runtime ends its response with the standalone
 * compatibility control marker. Inline discussion of the marker remains
 * visible user content.
 */
export function isSilentResponse(value) {
  return typeof value === 'string' && TERMINAL_SKIP.test(value);
}
