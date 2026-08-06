/**
 * Merge-forward (合并转发 /「聊天记录」) tree assembly.
 *
 * Kept free of network and of index.js's parsing helpers (which are injected)
 * so the nesting logic — the part Feishu does not document — is unit-testable
 * without a live API or a running WebSocket.
 */

// Bounds for resolving a forward-of-a-forward. Feishu's docs never state
// whether a nested forward's children come back flattened in the same items[],
// so recursion is possible — these caps keep a pathological chain from fanning
// out into unbounded API calls.
export const MAX_MERGE_FORWARD_DEPTH = 3;
export const MAX_MERGE_FORWARD_FETCHES = 12;

/**
 * Unwrap an `im.message.get` response into its items[], rejecting a failed call.
 *
 * The SDK surfaces the Feishu error classes observed in practice (malformed id,
 * nonexistent id, `230002` bot-not-in-chat) as a thrown AxiosError on HTTP 400,
 * so those already reach the caller's catch. This guards the remaining shape —
 * a resolved response carrying a non-zero `code` — because silently treating it
 * as `[]` would render a failed read-back as "no child messages", i.e. report a
 * fetch failure as a genuinely empty forward and drop the transcript. Callers
 * must let this propagate so the failed-content marker is used instead.
 *
 * @param {object} res raw `im.message.get` response
 * @param {string} messageId id being read, for the error message
 * @returns {Array<object>} `data.items` (possibly empty)
 */
export function itemsFromResponse(res, messageId) {
  if (!res || res.code !== 0) {
    throw new Error(
      `im.message.get failed for ${messageId}: code=${res?.code ?? 'missing'} msg=${res?.msg ?? 'none'}`
    );
  }
  return res.data?.items || [];
}

/**
 * Group a `im.message.get` items[] payload by `upper_message_id` (the id of the
 * forward each item sits directly inside).
 *
 * Falls back to treating every non-wrapper item as a direct child of `rootId`
 * when no item carries `upper_message_id` — the field is documented as
 * "仅在合并转发场景会有返回值", so this keeps a payload that omits it from
 * rendering as an empty forward.
 *
 * @param {Array<object>} items raw items[] from `im.message.get`
 * @param {string} rootId message_id that was queried (the forward wrapper)
 * @returns {Map<string, Array<object>>} parent message_id → direct children
 */
export function groupByUpperMessageId(items, rootId) {
  const byUpper = new Map();
  const others = (items || []).filter((item) => item && item.message_id !== rootId);
  const anyUpper = others.some((item) => item.upper_message_id);
  for (const item of others) {
    const key = anyUpper ? (item.upper_message_id || rootId) : rootId;
    if (!byUpper.has(key)) byUpper.set(key, []);
    byUpper.get(key).push(item);
  }
  return byUpper;
}

/**
 * Render the children of one merge_forward level into `lines`.
 *
 * Feishu documents that `items[]` holds "1 条合并转发消息和 N 条子消息" and that a
 * child's `upper_message_id` is the id of the forward containing it — but it
 * never documents what happens with a forward-of-a-forward: whether the inner
 * forward's own children arrive flattened in the same array or not (there is no
 * merge_forward response example in the docs at all). Rather than guess, this
 * decides at runtime: an inner forward whose children are already present in
 * `byUpper` is rendered from that array; one whose children are absent gets its
 * own fetch. Both API behaviours therefore produce the same output, with
 * neither duplicated nor dropped levels.
 *
 * @param {object} opts
 * @param {string} opts.parentId forward whose children are being rendered
 * @param {Map<string, Array<object>>} opts.byUpper grouping for this payload
 * @param {string[]} opts.lines output accumulator
 * @param {number} opts.depth current nesting depth (1 = top level)
 * @param {string} opts.indent prefix for this level
 * @param {{fetches: number}} opts.budget shared nested-fetch counter
 * @param {(msg: object) => string} opts.parseItemText renders one item's text
 * @param {(msg: object) => Promise<string>} opts.resolveSenderName sender name
 * @param {(messageId: string) => Promise<Array<object>>} opts.fetchItems nested fetch
 * @param {(message: string) => void} [opts.log] diagnostic sink
 */
export async function renderForwardLevel({
  parentId, byUpper, lines, depth, indent, budget,
  parseItemText, resolveSenderName, fetchItems, log = () => {},
}) {
  const children = byUpper.get(parentId) || [];
  for (const item of children) {
    const senderName = await resolveSenderName(item);
    // A child's text can be multi-line (a forwarded card commonly is). Indent
    // the continuation lines to this child's level too, otherwise they land at
    // column 0 and read as separate top-level entries in a nested forward.
    const body = String(parseItemText(item) ?? '').replace(/\n/g, `\n${indent}  `);
    lines.push(`${indent}${senderName}: ${body}`);

    if (item.msg_type !== 'merge_forward') continue;
    if (depth + 1 > MAX_MERGE_FORWARD_DEPTH) {
      lines.push(`${indent}  [nested forward not expanded: depth limit]`);
      continue;
    }
    if (byUpper.has(item.message_id)) {
      // Flattened: this inner forward's children are already in the payload.
      await renderForwardLevel({
        parentId: item.message_id, byUpper, lines, depth: depth + 1,
        indent: `${indent}  `, budget, parseItemText, resolveSenderName, fetchItems, log,
      });
      continue;
    }
    // Not flattened: the inner forward's children need their own fetch.
    if (budget.fetches >= MAX_MERGE_FORWARD_FETCHES) {
      lines.push(`${indent}  [nested forward not expanded: fetch limit]`);
      continue;
    }
    budget.fetches += 1;
    try {
      const nested = await fetchItems(item.message_id);
      await renderForwardLevel({
        parentId: item.message_id,
        byUpper: groupByUpperMessageId(nested, item.message_id),
        lines, depth: depth + 1, indent: `${indent}  `, budget,
        parseItemText, resolveSenderName, fetchItems, log,
      });
    } catch (err) {
      log(`Failed to expand nested merge_forward ${item.message_id}: ${err.message}`);
      lines.push(`${indent}  [nested forward, failed to fetch content]`);
    }
  }
}

/**
 * Render a whole merge_forward payload to display text.
 *
 * @returns {Promise<string>} `[Forwarded conversation]` + one line per child,
 *   or a bracketed marker when there is nothing to show.
 */
export async function renderMergeForward({
  items, rootId, parseItemText, resolveSenderName, fetchItems, log = () => {},
}) {
  const byUpper = groupByUpperMessageId(items, rootId);
  if (byUpper.size === 0) return '[merge_forward message, no child messages]';

  const lines = [];
  await renderForwardLevel({
    parentId: rootId, byUpper, lines, depth: 1, indent: '', budget: { fetches: 0 },
    parseItemText, resolveSenderName, fetchItems, log,
  });
  if (lines.length === 0) return '[merge_forward message, no child messages]';
  return `[Forwarded conversation]\n${lines.join('\n')}`;
}
