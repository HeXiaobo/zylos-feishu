/**
 * Master compatibility switch for the arch2 work.
 *
 * Unset or `0` means: behave exactly like the pre-arch2 component (baseline
 * 8c0a3e2). `1` enables the new architecture; the individual switches then
 * apply on top of it.
 *
 * Only the literal string `1` turns it on. Anything else — a typo, `true`,
 * `yes`, a trailing space — stays on the old path, because a mistake here must
 * never widen who the bot answers in a group.
 */
export const ARCH2_ENV = 'ZYLOS_ARCH2';

export function arch2Enabled(env = process.env) {
  return env?.[ARCH2_ENV] === '1';
}
