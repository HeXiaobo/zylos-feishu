/**
 * Raw API probes for the startup scope check (issue #162 item 4).
 *
 * Each probe returns the **raw** SDK response (`{ code, msg, data }`) or throws
 * the SDK/Axios error untouched, because the scope a denial names only exists in
 * that shape. Wrapping the response first (`{ success: false, message: … }`)
 * loses `code`, which made every scope look "unknown" no matter what Feishu said.
 *
 * The two calls were chosen so that each one really needs the scope it reports:
 *
 *   tenant.tenant.query        needs `tenant:tenant:readonly` (verified failure
 *                              text in REPORT-E4 §7.2)
 *   im.message.list  (1 page)  needs `im:message.group_msg` (verified failure
 *                              text in REPORT-E4 §7.1); `im.chat.get` would only
 *                              prove `im:chat`, which the component may already
 *                              have without the group-message scope
 *
 * A bot can list messages only in a chat it is in, so the group probe needs a
 * known `chat_id`. With no group yet there is nothing to probe and the scope is
 * reported `unknown` by the caller — never `granted`.
 */

/** @returns {{probeTenant: () => Promise<any>}} */
export function createScopeProbes({ client, chatId = null, pageSize = 1 } = {}) {
  const probeTenant = () => {
    if (!client?.tenant?.tenant?.query) throw new Error('feishu client has no tenant.tenant.query');
    return client.tenant.tenant.query({});
  };
  const probeGroupMessages = () => {
    if (!chatId) throw new Error('no group chat id to probe');
    if (!client?.im?.message?.list) throw new Error('feishu client has no im.message.list');
    return client.im.message.list({
      params: {
        container_id_type: 'chat',
        container_id: chatId,
        page_size: Math.min(pageSize, 50),
        sort_type: 'ByCreateTimeDesc',
      },
    });
  };
  return { probeTenant, probeGroupMessages: chatId ? probeGroupMessages : undefined };
}
