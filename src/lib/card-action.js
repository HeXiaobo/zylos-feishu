import fs from 'node:fs';
import path from 'node:path';

function includesId(allowed, actual) {
  return typeof actual === 'string' && actual.length > 0
    && Array.isArray(allowed) && allowed.includes(actual);
}

function getEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash
    || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('invalid endpoint');
  }
  return endpoint;
}

export function createCardActionHandler({ appId, getSettings,
  fetchImpl = globalThis.fetch, readFileImpl = fs.readFileSync,
  logger = console }) {
  return async (data) => {
    const settings = getSettings();
    if (settings?.enabled !== true) return {};
    if (!appId || data?.app_id !== appId
      || !includesId(settings.message_ids, data.context?.open_message_id)
      || !includesId(settings.chat_ids, data.context?.open_chat_id)
      || !includesId(settings.operator_ids, data.operator?.open_id)) return {};

    try {
      const endpoint = getEndpoint(settings.endpoint);
      if (typeof settings.bearer_key_file !== 'string'
        || !path.isAbsolute(settings.bearer_key_file)) throw new Error('invalid key file');
      const bearer = readFileImpl(settings.bearer_key_file, 'utf8').trim();
      if (!bearer || /[\r\n]/.test(bearer)) throw new Error('invalid key');
      const configuredTimeout = settings.timeout_ms ?? 2000;
      if (!Number.isInteger(configuredTimeout) || configuredTimeout < 1
        || configuredTimeout > 2000) throw new Error('invalid timeout');
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(configuredTimeout),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          schema: '2.0',
          header: { app_id: appId, event_type: 'card.action.trigger' },
          event: {
            action: { value: data.action?.value, form_value: data.action?.form_value },
            operator: { open_id: data.operator.open_id },
            context: {
              open_chat_id: data.context.open_chat_id,
              open_message_id: data.context.open_message_id
            }
          }
        })
      });
      if (!response.ok) throw new Error('receiver rejected action');
      const result = await response.json();
      const toast = result?.toast;
      if (!toast || !['success', 'info', 'warning', 'error'].includes(toast.type)
        || typeof toast.content !== 'string' || toast.content.length > 500) {
        throw new Error('invalid receiver response');
      }
      return { toast: { type: toast.type, content: toast.content } };
    } catch {
      logger.warn('[feishu] Card action receiver failed; submission outcome is unknown');
      return { toast: { type: 'error', content: '提交结果未确认，请联系机器人管理员。' } };
    }
  };
}
