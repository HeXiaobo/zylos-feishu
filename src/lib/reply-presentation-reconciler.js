export function createReplyPresentationReconciler({ presence, projection } = {}) {
  if (!presence || typeof presence.recover !== 'function') {
    throw new TypeError('presence reconciler capability is invalid');
  }
  if (!projection || typeof projection.drain !== 'function') {
    throw new TypeError('projection reconciler capability is invalid');
  }

  return Object.freeze({
    async run({ limit = 100 } = {}) {
      return {
        presence: await presence.recover({ limit }),
        projection: await projection.drain({ limit }),
      };
    },
    async flushProjection({ limit = 100 } = {}) {
      return {
        presence: { attempted: 0, finished: 0, pending: 0 },
        projection: await projection.drain({ limit }),
      };
    },
  });
}
