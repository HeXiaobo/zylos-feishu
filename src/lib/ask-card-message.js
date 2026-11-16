/**
 * 拍板卡回写用的两个 Feishu 消息动作：读原卡、改原卡。
 *
 * 单独一层是因为这两件事都要真的碰飞书，而回调逻辑（`ask-card-runtime.js`）
 * 应该是纯的、可单测的。这里只做「调 API、把结果摊平」。
 *
 * `patch` 的三个前提都在这里保住：
 *   - 卡片本身必须声明 `config.update_multi=true`（引擎生成时已经写了）；
 *   - 只有机器人自己发的消息能改；
 *   - 一条消息 5 QPS，所以这里不做循环重试，失败就交给调用方吞掉。
 */

import { MESSAGE_GET_PARAMS } from './message.js';

/**
 * 读回一张卡片的原始内容。
 *
 * 读出的是 `body.content` 里的卡片 JSON。读不回来返回 null：调用方用按钮值里
 * 带着的问题重拼一张最小卡，不阻断归单。
 *
 * @param {{client:object, messageId:string}} input
 * @returns {Promise<object|null>}
 */
export async function readCardContent({client, messageId}) {
  const id = String(messageId ?? '').trim();
  if (!id) return null;
  const res = await client.im.message.get({path: {message_id: id}, params: MESSAGE_GET_PARAMS});
  const items = res?.data?.items;
  const raw = Array.isArray(items) ? items[0]?.body?.content : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // user_card_content 给的是原始 2.0 卡；拿不到 body.elements 就等于没有可
    // 复用的结构，仍然交给调用方重拼。
    return parsed;
  } catch { return null; }
}

/**
 * 改一条机器人自己发的卡片。
 *
 * @param {{client:object, messageId:string, card:object}} input
 * @returns {Promise<{ok:true}>}
 * @throws 当飞书返回非 0 code
 */
export async function patchCardContent({client, messageId, card}) {
  const id = String(messageId ?? '').trim();
  if (!id) throw new Error('messageId required');
  const res = await client.im.message.patch({
    path: {message_id: id},
    data: {content: JSON.stringify(card)},
  });
  if (res && res.code !== undefined && res.code !== 0) {
    throw new Error(`feishu patch failed: code=${res.code} msg=${res.msg ?? ''}`);
  }
  return {ok: true};
}
