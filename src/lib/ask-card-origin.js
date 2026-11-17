/**
 * 拍板卡回调要回到哪个会话（issue #179 第 1 条，R5）。
 *
 * 私聊里的拍板从这一版起也发卡，于是回调不能再写死 `type:group`：`c4-gate` 的
 * `privateChat`、`auto-deliver` 的「私聊算内部」都按 endpoint 里的 `|type:p2p`
 * 认私聊，标成组就会把一条私聊入站当群消息办。
 *
 * 这里只认原单 `origin_endpoint` 里的 chat 段和 type 段，别的段（`parent:` /
 * `thread:` / `msg:`）一律不管。认不出 type 时退回 `group`——这与 #179-1 之前
 * 写死 group 的行为一致，不会把老单改判。
 */

/** `|type:p2p` / `private` / `dm` 都算私聊；group 与未知值都按群。 */
export function originSession(ticket) {
  const endpoint = String(ticket?.origin_endpoint || '');
  const chatId = endpoint.split('|')[0];
  if (!chatId) return { chatId: null, type: 'group' };
  const kind = endpoint.match(/\|type:(p2p|private|dm|group)(\||$)/)?.[1];
  const type = kind === 'p2p' || kind === 'private' || kind === 'dm' ? 'p2p' : 'group';
  return { chatId, type };
}
