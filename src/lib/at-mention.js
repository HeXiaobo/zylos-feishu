/**
 * @-mention syntax conversion for interactive (card) messages.
 *
 * Feishu accepts two different @-mention syntaxes, and which one is valid depends
 * on the message type:
 *
 *   text         <at user_id="ou_xxx">Display Name</at>   quoted id, display name kept
 *   interactive  <at id=ou_xxx></at>                      bare id, no display name
 *
 * scripts/send.js routes any message containing markdown through the card
 * (interactive) path. A caller writing the text-format mention — the form that
 * works everywhere else, and the only form documented for c4-send — therefore
 * reaches a card builder that does not understand it, and the tag renders as
 * literal text with no notification delivered. Messages without markdown were
 * unaffected, since they take the text path where the text form is native.
 *
 * This module converts text-format mentions to card-format so the card path
 * accepts them. Already-card-format tags carry no `user_id` attribute and are
 * left untouched, so running this over converted text is a no-op.
 */

// A text-format <at> tag. Deliberately broader than the minimum needed:
//
//   - the id may be double-quoted, single-quoted, or bare — a bare or
//     single-quoted id is just as valid in HTML-ish markup, and matching only
//     the double-quoted form would leave those mentions silently broken (the
//     exact failure this module exists to fix);
//   - other attributes may sit on either side of user_id;
//   - the display name is matched with [\s\S]*? so a name containing a newline
//     still terminates at the first </at> rather than swallowing the rest.
const AT_TEXT_TAG = /<at\s+[^>]*?user_id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>[\s\S]*?<\/at>/gi;

// Fenced blocks (``` … ```) and inline spans (` … `). Capturing, so String.split
// interleaves them into the result and they can be passed through verbatim.
const CODE_SPAN = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Apply `fn` to every part of `text` that is NOT inside a code span.
 *
 * Without this, a message explaining the mention syntax — a fenced block
 * containing a literal `<at user_id="…">` — would itself be rewritten, silently
 * corrupting documentation and code samples. Conversion is a rendering
 * concession for the card API; it has no business editing quoted code.
 *
 * An unterminated fence matches nothing and is treated as ordinary text, which
 * keeps a stray backtick from disabling conversion for the rest of the message.
 */
function mapOutsideCode(text, fn) {
  return text
    .split(CODE_SPAN)
    .map((segment, i) => (i % 2 === 1 ? segment : fn(segment)))
    .join('');
}

/**
 * Rewrite text-format @-mentions into the card-format the interactive message
 * API expects. Returns the input unchanged when there is nothing to convert.
 *
 * @param {string} text
 * @returns {string}
 */
export function convertAtMentionsForCard(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (!text.includes('<at')) return text;   // fast path: most messages have none

  return mapOutsideCode(text, (segment) =>
    segment.replace(AT_TEXT_TAG, (whole, doubleQuoted, singleQuoted, bare) => {
      const id = doubleQuoted ?? singleQuoted ?? bare;
      // An empty user_id ("") can't address anyone; leaving the tag as-is keeps
      // the original text visible rather than emitting a broken <at id=></at>.
      return id ? `<at id=${id}></at>` : whole;
    }),
  );
}
