/**
 * 拍板卡回调（issue #171）。
 *
 * 用户点了一下拍板卡上的按钮，飞书把 `card.action.trigger` 推过来。这里做的事
 * 只有三件，全部靠「投一条 C4 入站消息」交给已有的归单路径：
 *
 *   1. 鉴权：只有被问的人点了才算（按钮值里带 `u`），别人点只回一条提示，不改
 *      任何状态；
 *   2. 归单：`c4-receive --callback-ticket-id <单号>`，`route-input` 认出这是
 *      针对哪张单的后续，直接 `ticket input` 进那张单的干活会话，**不经前台**；
 *   3. 回写：原卡改成「已选：某项」，按钮去掉。第二次点还是会被上一步拒掉
 *      （单子已经不在等人），所以「不能重复点」是数据库状态兜住的，不靠 UI。
 *
 * 和 `task-card-runtime.js` 一样：校验/路由在 lib 里，`index.js` 只做接线。
 * 差别是这里不需要签名上下文：鉴权只依赖飞书回调自带的 `operator.open_id`，
 * 以及按钮值里由引擎写死的被问人 open_id —— 模型经手不到这个值。
 */

import { withoutButtons } from './card-structure.js';

export const ASK_CARD_MARKER = 'ask';
export const ASK_PICK = 'ask_pick';
export const ASK_WRITE = 'ask_write';
export const ASK_DELEGATE = 'ask_delegate';
const ASK_ACTIONS = new Set([ASK_PICK, ASK_WRITE, ASK_DELEGATE]);
const TICKET_ID = /^T\d{8}-[a-z0-9]{4}$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{6,}$/;
const MAX_LABEL = 40;
const MAX_QUESTION = 300;

function text(value, max) {
  return Array.from(String(value ?? '').trim()).slice(0, max).join('');
}

/**
 * 这个按钮值是不是拍板卡的。
 *
 * @param {unknown} value
 */
export function isAskCardAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.z === ASK_CARD_MARKER && TICKET_ID.test(String(value.t ?? '')) && ASK_ACTIONS.has(value.a);
}

/**
 * 把飞书回调摊平成我们关心的字段。
 *
 * 两种回调形状都要认：WebSocket 把事件摊平（`event.operator`），Webhook 的
 * 是 `{header, event}`。认不出来返回 null —— 不抛错，因为同一张卡上可能有
 * 别的按钮（比如以后加的）。
 *
 * @param {object} raw
 * @returns {{ticketId:string, action:string, actorId:string, messageId:string, label:string, question:string, askee:string}|null}
 */
export function parseAskCardEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const event = raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event) ? raw.event : raw;
  const value = event.action?.value;
  if (!isAskCardAction(value)) return null;
  const isV2 = Object.hasOwn(event, 'operator') || Object.hasOwn(event, 'context');
  const actorId = String((isV2 ? event.operator?.open_id : event.open_id) ?? '').trim();
  const messageId = String((isV2 ? event.context?.open_message_id : event.open_message_id) ?? '').trim();
  return {
    ticketId: String(value.t),
    action: value.a,
    actorId,
    messageId,
    label: text(value.l, MAX_LABEL),
    question: text(value.q, MAX_QUESTION),
    askee: String(value.u ?? '').trim(),
  };
}

/**
 * 这次点击算不算（纯判定，便于单测）。
 *
 * @param {{actorId:string, askee:string}} parsed
 * @returns {{ok:true}|{ok:false, reason:string, toast:string}}
 */
export function checkActor(parsed) {
  const actor = String(parsed?.actorId ?? '');
  if (!actor) return {ok: false, reason: 'no operator', toast: '拿不到你的身份，请直接在聊天里回复'};
  if (!OPEN_ID.test(parsed?.askee ?? '')) return {ok: false, reason: 'card has no askee', toast: '这张卡没记住要问谁，请直接在聊天里回复'};
  if (actor !== parsed.askee) return {ok: false, reason: 'not the asked person', toast: '这张卡不是问你的，答复不会被采纳'};
  return {ok: true};
}

/** 点击之后投给 C4 的正文。归单靠 `--callback-ticket-id`，正文只是给人看的。 */
export function tapContent(parsed) {
  if (parsed.action === ASK_PICK) return `〔拍板卡〕选：${parsed.label || '（无选项文字）'}`;
  if (parsed.action === ASK_DELEGATE) return '〔拍板卡〕我点了「交给别人定」，接下来会用文字说明交给谁。';
  return '〔拍板卡〕我点了「我自己写」，接下来会用文字写下决定。';
}

/** 写回卡片时的说明文字。 */
export function tapOutcomeText(parsed) {
  if (parsed.action === ASK_PICK) return parsed.label || '已选';
  if (parsed.action === ASK_DELEGATE) return '要用文字说明交给谁';
  return '要用文字写下决定';
}

/**
 * 把原卡改成「已选：某项」，按钮全部去掉。
 *
 * 只在**选项按钮**（`ask_pick`）之后调用；「我自己写」「交给别人定」不改卡片：
 * 那两条路还要人打字，卡片留着问题更有用。读不回原卡时用按钮值里的 `q` 拼一张
 * 最小卡，不发空卡。
 *
 * 回写的卡必须是飞书认的 2.0：按钮是 `body.elements` 的直接成员（不是
 * `{tag:'action', actions:[…]}`），说明文字用 `markdown`（2.0 没有 `note`）。
 * 旧版生成器写出的是带 `action` 壳的卡，所以这里**两种形状都要拆**——只过滤
 * `action` 会把扁平按钮留在原卡上，人点了以为没点上。
 *
 * @param {object|null} card 原卡片
 * @param {{label?:string, actorName?:string, ticketId:string, question?:string}} input
 */
export function answeredCard(card, {label, actorName, ticketId, question}) {
  const chosen = text(label, MAX_LABEL) || '已选';
  const who = text(actorName, 60);
  const summary = who ? `${who} 已选：${chosen}` : `已选：${chosen}`;
  const tail = {tag: 'markdown', content: `${summary}（这张不会再接受新的点击；要改请直接回复消息）`};
  if (card && Array.isArray(card?.body?.elements)) {
    return {
      ...card,
      config: {...(card.config || {}), update_multi: true, summary: {content: summary}},
      header: {
        ...(card.header || {}),
        template: 'green',
        title: {tag: 'plain_text', content: summary},
      },
      body: {
        ...card.body,
        elements: [...withoutButtons(card.body.elements), tail],
      },
    };
  }
  return {
    schema: '2.0',
    config: {update_multi: true, summary: {content: summary}},
    header: {template: 'green', title: {tag: 'plain_text', content: summary}},
    body: {elements: [
      ...(question ? [{tag: 'markdown', content: `**${text(question, MAX_QUESTION)}**`}] : []),
      {tag: 'markdown', content: `工单 ${String(ticketId)}`},
      tail,
    ]},
  };
}

/**
 * 回调的运行时：注入取原卡、改卡、投 C4 三个动作，逻辑留在这里。
 *
 * @param {object} input
 * @param {(messageId:string) => Promise<object|null>} input.readCard
 * @param {(messageId:string, card:object) => Promise<void>} input.patchCard
 * @param {(args:object) => Promise<object>} input.receive 投 c4-receive
 * @param {(reason:string) => void} [input.onError]
 */
export function createAskCardRuntime({readCard, patchCard, receive, onError}) {
  if (typeof readCard !== 'function' || typeof patchCard !== 'function' || typeof receive !== 'function') {
    throw new TypeError('ask card runtime needs readCard, patchCard and receive');
  }
  const report = typeof onError === 'function' ? onError : () => {};

  return Object.freeze({
    /**
     * @param {object} raw 飞书回调原文
     * @param {{actorName?:string}} [hints] 显示在卡片上的点选人名字（可缺）
     * @returns {Promise<{handled:boolean, toast?:{type:string, content:string}}>}
     */
    async handle(raw, hints = {}) {
      const parsed = parseAskCardEvent(raw);
      if (!parsed) return {handled: false};
      const allowed = checkActor(parsed);
      if (!allowed.ok) {
        // 别人点了：什么都不改，只提示。
        return {handled: true, toast: {type: 'warning', content: allowed.toast}};
      }
      let result;
      try {
        result = await receive({
          ticketId: parsed.ticketId,
          content: tapContent(parsed),
          messageId: parsed.messageId,
          actorId: parsed.actorId,
        });
      } catch (error) {
        report(error.message);
        return {handled: true, toast: {type: 'error', content: '这张单没接住这次点击，请直接在聊天里回复'}};
      }
      // 归单没落下去（单子已经答过、卡是上一轮的）：提示，不改卡片状态。
      if (result && result.accepted === false) {
        return {handled: true, toast: {type: 'warning', content: result.toast || '这张单已经答过了'}};
      }
      if (parsed.action === ASK_PICK && parsed.messageId) {
        try {
          const original = await readCard(parsed.messageId);
          await patchCard(parsed.messageId, answeredCard(original, {
            label: parsed.label, actorName: hints.actorName, ticketId: parsed.ticketId, question: parsed.question,
          }));
        } catch (error) {
          // 归单已经成立；改卡失败只影响观感，不该让点击变失败。
          report(`ask card patch skipped: ${error.message}`);
        }
      }
      return {handled: true, toast: {type: 'success', content: parsed.action === ASK_PICK ? '已记下，这张单接着办' : '接下来用文字说明就好'}};
    },
  });
}
