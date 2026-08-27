const TASK_V2_SUBSCRIPTION_URL =
  '/open-apis/task/v2/task_v2/task_subscription?user_id_type=open_id';

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

/**
 * Bot-identity Adapter for the Task v2 durable event subscription relation.
 * This identity receives only Tasks for which the current App is responsible;
 * a user's personally followed Tasks are outside this real-time event scope.
 */
export function createTaskV2SubscriptionAdapter({ client } = {}) {
  const sdk = requireRecord(client, 'client');
  if (typeof sdk.request !== 'function') {
    throw new TypeError('client.request must be a function');
  }
  let subscribed = null;
  let pending = null;
  return Object.freeze({
    async subscribe() {
      if (subscribed) return subscribed;
      if (!pending) {
        pending = (async () => {
          const response = await sdk.request({
            method: 'POST',
            url: TASK_V2_SUBSCRIPTION_URL,
          });
          if (response?.code !== 0) {
            const code = response?.code ?? 'unknown';
            const message = typeof response?.msg === 'string' && response.msg.trim() !== ''
              ? response.msg.trim()
              : 'unknown Feishu response';
            throw new Error(`Task v2 subscription failed (${code}): ${message}`);
          }
          subscribed = Object.freeze({ status: 'subscribed' });
          return subscribed;
        })().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
  });
}

/** Fail-closed startup gate shared by every Task v2 event transport. */
export async function startTaskV2Transport({
  enabled,
  openStatusInbox,
  subscription,
  start,
} = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (enabled && typeof openStatusInbox !== 'function') {
    throw new TypeError('openStatusInbox must be a function');
  }
  if (enabled && typeof subscription?.subscribe !== 'function') {
    throw new TypeError('subscription.subscribe must be a function');
  }
  if (typeof start !== 'function') throw new TypeError('start must be a function');
  if (enabled) {
    const inbox = openStatusInbox();
    if (!inbox || typeof inbox.close !== 'function') {
      throw new TypeError('openStatusInbox must return an inbox with close');
    }
    inbox.close();
    await subscription.subscribe();
  }
  return start();
}
