// Hard safety bounds for the card walk. The input is parsed JSON — an acyclic,
// size-bounded tree (Feishu caps card JSON at ~28KB), so a cycle/infinite loop
// is not actually possible and real cards nest only a few levels deep. These
// caps are belt-and-suspenders: even a pathologically deep or huge card can
// neither overflow the call stack nor spin — the walk stops and logs once,
// degrading to whatever text was gathered so far (never a crash or hang).
const MAX_CARD_WALK_DEPTH = 100;   // real cards nest < ~10; 100 is unreachable normally
const MAX_CARD_WALK_NODES = 5000;  // total element nodes visited per card

/**
 * Extract readable text from a Feishu interactive (card) message.
 *
 * Feishu transforms cards when reading them back via the message API:
 *  - Schema 2.0 cards can lose their markdown body from the top-level fields;
 *    the original card (with the body) survives under `user_dsl` when the
 *    request asks for `card_msg_content_type: user_card_content`.
 *  - Legacy / Schema 1.0 cards keep their text under a top-level `elements[]`
 *    (a 1D list of element objects, or a 2D array of text runs).
 *  - The title may move from `header.title.content` to a top-level `title`.
 *
 * This walks all of those shapes, including the `div` CONTENT component's
 * `fields[]` (each field carrying its own `{tag, content}` text), which
 * field-layout cards (e.g. an approval card) use for ALL their text. Kept as a
 * pure, dependency-free function so it is unit-testable in isolation
 * (index.js opens a WebSocket on import).
 *
 * Official div / text component reference:
 *   https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/embedded-non-interactive-elements/text
 *
 * @param {object} content parsed card content (message `body.content` JSON).
 * @returns {string} extracted text, `[card] <title>` when only a title is
 *   available, or `[interactive message]` when nothing is recognized.
 */
export function extractInteractiveText(content) {
  try {
    const parts = [];

    const pushText = (t) => { if (typeof t === 'string' && t.trim()) parts.push(t); };

    // Recursively extract visible text from card elements. Covers the shapes
    // Feishu actually emits on a read-back card (Schema 2.0 `body.elements`,
    // the original `user_dsl` DSL, and the top-level `elements` of transformed
    // / Schema 1.0 cards):
    //   • text blocks: `markdown` / `lark_md` / `plain_text` / legacy `text`
    //   • the `div` CONTENT component — an optional main `text` object AND an
    //     optional `fields[]` list, where EACH field carries its own
    //     `{ tag: lark_md|plain_text, content }` text. Field-layout cards put
    //     all their text in `fields`; reading only `div.text` would drop them
    //     and leave just the title.
    //   • `column_set` → `columns[]` → nested `elements[]` containers
    //   • `note` containers and `action` → `button` text
    let nodesVisited = 0;
    let walkTruncated = false;
    const overCap = (depth) => {
      if (depth > MAX_CARD_WALK_DEPTH || ++nodesVisited > MAX_CARD_WALK_NODES) {
        if (!walkTruncated) {
          walkTruncated = true;
          try {
            console.log(`[feishu] extractInteractiveText: card walk hit ${depth > MAX_CARD_WALK_DEPTH ? 'depth' : 'node'} cap — truncating (text may be incomplete)`);
          } catch { /* ignore */ }
        }
        return true;
      }
      return false;
    };

    // Depth-bounded, node-bounded tree walk. `depth` guards the call stack and
    // `nodesVisited` (via overCap) guards total work; arrays don't add depth
    // (they're sibling containers, not nesting). Parsed JSON is acyclic so this
    // always terminates; the caps just make a pathological card safe too.
    // NOTE: iterate arrays explicitly (NOT `el.forEach(walkElement)`), so the
    // forEach index isn't passed as `depth`.
    const walkElement = (el, depth) => {
      if (!el || overCap(depth)) return;
      if (Array.isArray(el)) { for (const x of el) walkElement(x, depth); return; }
      if (typeof el !== 'object') return;
      switch (el.tag) {
        case 'markdown':
        case 'lark_md':
          pushText(el.content);
          break;
        case 'text': // legacy text element: string in `.text` (or nested object)
          pushText(typeof el.text === 'string' ? el.text : el.text?.content);
          break;
        case 'plain_text':
          pushText(el.content ?? el.text?.content);
          break;
        case 'div': // CONTENT component: main text + fields[]
          pushText(el.text?.content);
          for (const f of (el.fields || [])) pushText(f?.text?.content);
          break;
        case 'column_set':
          for (const col of (el.columns || [])) walkElement(col.elements, depth + 1);
          break;
        case 'note':
          walkElement(el.elements, depth + 1);
          break;
        case 'action':
          walkElement(el.actions, depth + 1);
          break;
        case 'button':
          pushText(el.text?.content);
          break;
        default:
          // Unknown/container element: pick up a directly-attached text object
          // and descend defensively into nested shapes.
          pushText(el.text?.content);
          if (el.elements) walkElement(el.elements, depth + 1);
          if (el.columns) for (const col of el.columns) walkElement(col.elements, depth + 1);
      }
    };
    // Back-compat alias for the two Schema-2.0 call sites below.
    const walkSchema2Elements = (elements) => walkElement(elements || [], 0);

    // Schema 2.0 read-back: when Feishu reads/pushes a card back, it transforms
    // it and drops the markdown body from the top-level fields — only the
    // RENDERED form survives in `elements[]` (often just an image), which is
    // why a real markdown card otherwise falls through to the
    // `[interactive message]` placeholder. The ORIGINAL card (with the markdown
    // content) is preserved under `user_dsl`: a JSON string of
    // `{ body: { elements: [...] }, schema }`. Prefer it when present so
    // inbound markdown cards read correctly.
    if (content?.user_dsl) {
      try {
        const dsl = typeof content.user_dsl === 'string'
          ? JSON.parse(content.user_dsl)
          : content.user_dsl;
        walkSchema2Elements(dsl?.body?.elements);
        const dslMeaningful = parts.map(p => p.trim()).filter(Boolean);
        if (dslMeaningful.length > 0) return dslMeaningful.join('\n');
        parts.length = 0; // nothing usable in user_dsl — reset and try other strategies
      } catch {
        // Malformed user_dsl — fall through to the other strategies below.
      }
    }

    // Schema 2.0 cards (original, before API transformation): body.elements[]
    walkSchema2Elements(content?.body?.elements);
    if (parts.length > 0) return parts.join('\n');

    // Legacy / API-transformed / Schema 1.0 format: `elements[]` at the top
    // level — may be a 1D list of element objects (div/markdown/action/…) or a
    // 2D array of text runs. Route both through the same recursive walker so
    // `div.fields[]`, buttons and nested containers are extracted here too.
    walkElement(content?.elements || [], 0);

    // Filter out whitespace-only parts
    const meaningful = parts.map(p => p.trim()).filter(Boolean);
    if (meaningful.length > 0) return meaningful.join('\n');

    // Title fallback: API-transformed cards have top-level "title" string,
    // original cards have header.title.content
    const title = content?.title || content?.header?.title?.content;
    if (title) return `[card] ${title}`;
  } catch (err) {
    // Log a truncated preview so a parse-throwing card schema can be diagnosed.
    try {
      console.log(`[feishu] extractInteractiveText threw (${err.message}); content preview: ${JSON.stringify(content).slice(0, 2000)}`);
    } catch { /* unable to stringify */ }
    return '[interactive message]';
  }
  // No strategy matched — log a preview so the unhandled card schema can be
  // identified and supported in a follow-up.
  try {
    console.log(`[feishu] extractInteractiveText: unrecognized card schema, content preview: ${JSON.stringify(content).slice(0, 2000)}`);
  } catch { /* unable to stringify */ }
  return '[interactive message]';
}
