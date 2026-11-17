/**
 * 卡片 2.0 的结构底线：飞书会不会收下这张卡。
 *
 * 为什么要有这个文件（2026-11-17 生产 T11172125-6m6p）：
 *
 *   出站 661 / 663 两张卡 `send_status=failed`、**没有平台消息 id**，同一条路径
 *   的 666 发出去就成功了。三张卡的差别只在结构：前两张把按钮包在
 *   `{tag:'action', actions:[…]}` 壳里，另外还带一个 `{tag:'note', …}`；
 *   成功的那张按钮**直接是 `body.elements` 的成员**，说明文字用 `markdown`。
 *
 *   `readCardFile()` 当时只查了「路径、JSON 可解析、顶层是对象、
 *   `schema === '2.0'`、`body` 是对象」，**从不往下看元素**。所以这两种 1.0
 *   时代的容器一路通过本地校验，直到飞书回了 400 才失败——单元测试全绿、
 *   线上才失败，就是这么来的。
 *
 * 判据只收**有依据**的：
 *   - `action`：2.0 组件文档原文「2.0 已废弃 `action` 交互模块，按钮直接放
 *     `elements`」（`lark-im/references/card/components/button.md`「嵌套 / 易错点」）。
 *   - `note`：2.0 组件大纲（`card-2.0-schema.md`）的组件表里没有这个 tag；生产上
 *     唯一发成功的卡也没用它。**〔未验证〕** 单凭文档不能断定它一定被拒，
 *     但从这一版起我们不再生成它，也就没有赌的必要。
 *
 * 刻意**不做白名单**：2.0 还在加组件，列全集必然误伤（`report-card` 生成的
 * 卡片里就有 `column` / `column_set` / `hr` 这类合法结构）。只拦**已经确认是
 * 1.0 遗留**的那几个，漏网的由发送结果兜。
 */

/**
 * 1.0 时代才有、2.0 里已经拆掉的容器 tag。出现即视为必然被飞书拒绝。
 *
 * @type {ReadonlyMap<string, string>}
 */
export const RETIRED_CONTAINER_TAGS = new Map([
  ['action', 'card 2.0 has no `action` module; put `button` elements directly in `elements`'],
  ['note', 'card 2.0 has no `note` element; use a `markdown` element'],
]);

/**
 * 找出卡片里第一处必然被飞书拒绝的结构。
 *
 * 只往「会渲染成元素」的位置走：`body.elements`、`column_set.columns[].elements`、
 * `form.elements` 等容器里的 `elements` / `columns` / `actions`。按钮值、文本内容
 * 一律不看，所以不碰卡片正文、不碰敏感内容。
 *
 * @param {unknown} card
 * @returns {{path:string, tag:string, reason:string}|null}
 */
export function findUnsupportedStructure(card) {
  const seen = new Set();
  /** @type {{value:unknown, path:string}[]} */
  const stack = [{value: card, path: 'card'}];

  while (stack.length > 0) {
    const {value, path} = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => stack.push({value: entry, path: `${path}[${index}]`}));
      continue;
    }

    if (typeof value.tag === 'string') {
      const reason = RETIRED_CONTAINER_TAGS.get(value.tag);
      if (reason) return {path: `${path}.tag`, tag: value.tag, reason};
    }

    // 只往下走这些「装着元素」的字段名。别的字段（value / text / content /
    // summary…）是数据，不是元素树，不必也不该翻。
    for (const key of ['elements', 'columns', 'actions']) {
      if (value[key] !== undefined) stack.push({value: value[key], path: `${path}.${key}`});
    }
  }

  return null;
}

/**
 * 把一张卡里的按钮全部去掉，其余结构原样留下。
 *
 * 两种形状都要拆：新生成的卡是扁平按钮（`body.elements` 的成员），历史卡是
 * `{tag:'action', actions:[…]}`。只过滤 `action` 会把扁平按钮留在原卡上，
 * 人点了以为没点上。
 *
 * @param {unknown[]} elements
 * @returns {unknown[]}
 */
export function withoutButtons(elements) {
  if (!Array.isArray(elements)) return [];
  return elements
    .filter(element => element?.tag !== 'action' && element?.tag !== 'button')
    .map(element => {
      if (!element || typeof element !== 'object') return element;
      if (Array.isArray(element.columns)) {
        return {
          ...element,
          columns: element.columns.map(column => (column && Array.isArray(column.elements)
            ? {...column, elements: withoutButtons(column.elements)}
            : column)),
        };
      }
      return element;
    });
}
