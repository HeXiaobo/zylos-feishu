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
  return value;
}

function hasVisibleText(value) {
  return value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '') !== '';
}

function normalizeClaim(rawClaim, expectedAction) {
  const claim = requireRecord(rawClaim, 'delivery claim');
  if (claim.action !== expectedAction) {
    throw new TypeError(`delivery claim action must be ${expectedAction}`);
  }
  const intent = requireRecord(claim.intent, 'ReplyIntent');
  if (intent.schemaVersion !== 1 || intent.type !== 'ReplyIntent') {
    throw new TypeError('ReplyIntent contract version is unsupported');
  }
  requireText(intent.intentId, 'ReplyIntent.intentId');
  requireText(intent.route?.targetRef, 'ReplyIntent.route.targetRef');
  if (intent.route?.adapterId !== 'feishu') {
    throw new TypeError('ReplyIntent route adapterId must be feishu');
  }
  if (intent.payload?.format !== 'text' || typeof intent.payload.text !== 'string') {
    throw new TypeError('ReplyIntent payload must be text');
  }
  if (!hasVisibleText(intent.payload.text)) {
    const error = new Error('visible ReplyIntent output is blank');
    error.code = 'MISSING_OUTPUT';
    throw error;
  }
  return { claim, intent };
}

function rejectedResult(error) {
  return {
    outcome: 'rejected',
    externalRef: null,
    errorCode: String(error?.code || 'FEISHU_DELIVERY_REJECTED'),
    retryable: error?.retryable === true,
  };
}

function unknownResult() {
  return { outcome: 'unknown', externalRef: null };
}

function normalizeTarget(rawTarget) {
  const target = requireRecord(rawTarget, 'resolved Feishu target');
  return {
    chatId: requireText(target.chatId, 'resolved Feishu target chatId'),
    chatType: target.chatType,
    replyToMessageId: target.replyToMessageId === null
      ? null
      : requireText(target.replyToMessageId, 'resolved Feishu target replyToMessageId'),
  };
}

/**
 * Bridges Core ReplyIntent claims to the existing Feishu-owned response stream.
 * The stable intentId, rather than an attempt or redrive generation, is the
 * stream key so the already-bound message/card identity cannot be replaced.
 */
export function createConversationResponseFinalReplyCompatibility({
  stream,
  resolveTarget,
} = {}) {
  const responseStream = requireRecord(stream, 'stream');
  for (const method of ['sendCompleted', 'reconcileCompleted']) {
    if (typeof responseStream[method] !== 'function') {
      throw new TypeError(`stream.${method} must be a function`);
    }
  }
  if (typeof resolveTarget !== 'function') {
    throw new TypeError('resolveTarget must be a function');
  }

  async function requestFor(rawClaim, expectedAction) {
    const { claim, intent } = normalizeClaim(rawClaim, expectedAction);
    const target = normalizeTarget(await resolveTarget(intent.route.targetRef, intent));
    return {
      claim,
      request: {
        requestId: intent.intentId,
        target,
        output: intent.payload.text,
      },
    };
  }

  return Object.freeze({
    async send(rawClaim) {
      const { request } = await requestFor(rawClaim, 'send');
      try {
        const result = requireRecord(
          await responseStream.sendCompleted(request),
          'completed response result',
        );
        return {
          outcome: 'platform_accepted',
          externalRef: requireText(result.messageId, 'completed response messageId'),
        };
      } catch (error) {
        if (error?.deliveryOutcome === 'rejected') return rejectedResult(error);
        if (error?.deliveryOutcome === 'unknown') return unknownResult();
        throw error;
      }
    },
    async reconcile(rawClaim) {
      const { request } = await requestFor(rawClaim, 'reconcile');
      let result;
      try {
        result = requireRecord(
          await responseStream.reconcileCompleted(request),
          'completed response reconciliation result',
        );
      } catch (error) {
        if (error?.deliveryOutcome === 'rejected') return rejectedResult(error);
        throw error;
      }
      if (result.outcome === 'reconciled') {
        return {
          outcome: 'reconciled',
          externalRef: requireText(result.messageId, 'reconciled response messageId'),
        };
      }
      if (result.outcome === 'rejected') {
        return {
          outcome: 'rejected',
          externalRef: null,
          errorCode: requireText(result.errorCode, 'reconciliation errorCode'),
          retryable: result.retryable === true,
        };
      }
      const error = new Error('Feishu delivery reconciliation was inconclusive');
      error.code = 'FEISHU_RECONCILIATION_INCONCLUSIVE';
      error.deliveryOutcome = 'unknown';
      throw error;
    },
  });
}
