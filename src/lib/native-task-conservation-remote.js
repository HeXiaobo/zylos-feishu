const MAX_LIST_PAGES = 1_000;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('native Task inventory capture aborted', { cause: signal.reason });
  error.name = 'AbortError';
  throw error;
}

function responseError(response) {
  const error = new Error(response?.msg || 'Feishu Task v2 list failed');
  error.code = response?.code ?? 'FEISHU_API_ERROR';
  return error;
}

/** Read-only Adapter that captures the current App's complete assigned Task inventory. */
export function createSdkNativeTaskConservationReader({ client, appId } = {}) {
  const sdk = requireRecord(client, 'Feishu SDK client');
  const taskApi = sdk.task?.v2?.task;
  if (typeof taskApi?.list !== 'function') {
    throw new TypeError('Feishu SDK task.v2.task.list is unavailable');
  }
  const expectedAppId = requireText(appId, 'appId');

  return Object.freeze({
    async capture({ signal } = {}) {
      const tasks = [];
      for (const completed of [false, true]) {
        let pageToken;
        const seenPageTokens = new Set();
        let exhausted = false;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
          throwIfAborted(signal);
          const response = await taskApi.list({
            params: {
              user_id_type: 'open_id',
              type: 'my_tasks',
              completed,
              page_size: 50,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          }, { signal });
          throwIfAborted(signal);
          if (response?.code !== 0) throw responseError(response);
          const data = requireRecord(response.data, 'Feishu Task v2 list data');
          if (!Array.isArray(data.items)) {
            throw new TypeError('Feishu Task v2 list items must be an array');
          }
          if (typeof data.has_more !== 'boolean') {
            throw new TypeError('Feishu Task v2 list has_more must be a boolean');
          }
          tasks.push(...data.items);
          if (!data.has_more) {
            exhausted = true;
            break;
          }
          const nextPageToken = requireText(data.page_token, 'Feishu Task v2 list page_token');
          if (seenPageTokens.has(nextPageToken)) {
            throw new Error('Feishu Task v2 list repeated a page token');
          }
          seenPageTokens.add(nextPageToken);
          pageToken = nextPageToken;
        }
        if (!exhausted) throw new Error('Feishu Task v2 list exceeded the page safety limit');
      }
      return {
        identity: { kind: 'app', appId: expectedAppId },
        tasks,
      };
    },
  });
}
