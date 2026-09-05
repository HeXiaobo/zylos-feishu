import { createFeishuConversationGateway } from './feishu-conversation-gateway.js';
import { createFeishuFinalReplyPort } from './feishu-final-reply-port.js';
import { normalizeFeishuInboundMessage } from './feishu-inbound-normalizer.js';
import { openFeishuReplyPresentation } from './feishu-reply-presentation.js';

export const REPLY_REFACTOR_FLAG = 'C4_REPLY_REFACTOR_V1';

export const TERMINAL_RUN_EVENTS = new Set(['RunCompleted', 'RunFailed', 'RunCancelled']);

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireMethods(value, methods, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  for (const method of methods) {
    if (typeof value[method] !== 'function') {
      throw new TypeError(`${field}.${method} must be a function`);
    }
  }
  return value;
}

function optionalMethods(value, methods, field) {
  if (value === null || value === undefined) return null;
  return requireMethods(value, methods, field);
}

function unsupported(operation) {
  throw domainError('UNSUPPORTED_CAPABILITY', `${operation} is not configured`);
}

export function replyRefactorEnabled(env = process.env) {
  const value = String(env?.[REPLY_REFACTOR_FLAG] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'enabled';
}

export function resolveFeishuRouteTarget(targetRef) {
  const encoded = requireText(targetRef, 'Feishu route targetRef');
  const match = encoded.match(/^feishu-(?:route|source):v1:([A-Za-z0-9_-]+)$/);
  if (!match) throw domainError('INVALID_ROUTE', 'Feishu route targetRef is unsupported');
  let route;
  try {
    route = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw domainError('INVALID_ROUTE', 'Feishu route targetRef is malformed');
  }
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw domainError('INVALID_ROUTE', 'Feishu route targetRef is malformed');
  }
  const chatId = requireText(route.chatId, 'Feishu route chatId');
  const chatType = route.chatType === 'p2p' ? 'p2p' : 'group';
  const replyToMessageId = chatType === 'group'
    ? requireText(
      route.parentId || route.rootId || route.messageId,
      'Feishu group route reply target',
    )
    : (route.messageId ? requireText(route.messageId, 'Feishu direct reply target') : null);
  return Object.freeze({ chatId, chatType, replyToMessageId });
}

function createLegacyComposition(legacy) {
  const rollback = requireMethods(legacy, ['acceptMessage'], 'legacy reply path');
  return Object.freeze({
    enabled: false,
    acceptMessage(input, options) { return rollback.acceptMessage(input, options); },
    recordProgress(event) {
      return typeof rollback.recordProgress === 'function'
        ? rollback.recordProgress(event)
        : unsupported('legacy progress projection');
    },
    deliverFinal(claim) {
      return typeof rollback.deliverFinal === 'function'
        ? rollback.deliverFinal(claim)
        : unsupported('legacy final delivery');
    },
    settleFinal(settlement) {
      return typeof rollback.settleFinal === 'function'
        ? rollback.settleFinal(settlement)
        : unsupported('legacy delivery settlement');
    },
    suppressFinal(outcome) {
      return typeof rollback.suppressFinal === 'function'
        ? rollback.suppressFinal(outcome)
        : unsupported('legacy silent settlement');
    },
    runTaskEffects(options) {
      return typeof rollback.runTaskEffects === 'function'
        ? rollback.runTaskEffects(options)
        : unsupported('legacy TaskEffect worker');
    },
    ingestNativeTask(event) {
      return typeof rollback.ingestNativeTask === 'function'
        ? rollback.ingestNativeTask(event)
        : unsupported('legacy NativeTask intake');
    },
    drainNativeTasks(options) {
      return typeof rollback.drainNativeTasks === 'function'
        ? rollback.drainNativeTasks(options)
        : unsupported('legacy NativeTask worker');
    },
    maintain(options) {
      return typeof rollback.maintain === 'function'
        ? rollback.maintain(options)
        : Promise.resolve({ legacy: true });
    },
    recover(options) {
      return typeof rollback.recover === 'function'
        ? rollback.recover(options)
        : Promise.resolve({ legacy: true });
    },
    inspect(requestId) {
      return typeof rollback.inspect === 'function' ? rollback.inspect(requestId) : null;
    },
    close() { return Promise.resolve(rollback.close?.()); },
  });
}

/**
 * Feishu's reply-refactor composition root. Durable modules own their own
 * transitions; this layer only selects the cutover path and connects their
 * receipts. In particular, card progress never settles Reply Presence and a
 * delivery receipt never substitutes for Core's DeliverySettlement.
 */
export function createFeishuReplyComposition({
  enabled = replyRefactorEnabled(),
  legacy,
  accountRef,
  gateway,
  presentation,
  finalReply,
  taskEffects = null,
  nativeTasks = null,
  normalizeInbound = normalizeFeishuInboundMessage,
  clock = Date.now,
  logger = console,
} = {}) {
  if (!enabled) return createLegacyComposition(legacy);

  const normalizedAccountRef = requireText(accountRef, 'Feishu composition accountRef');
  const inbound = requireMethods(gateway, ['accept', 'recover', 'close'], 'Feishu gateway');
  const replyPresentation = requireMethods(presentation, [
    'accept',
    'recordProgress',
    'observeDeliveryReceipt',
    'reconcile',
    'inspect',
    'close',
  ], 'Feishu reply presentation');
  const finalPort = requireMethods(finalReply, ['deliver', 'settle', 'suppress'], 'FinalReply port');
  const effectWorker = optionalMethods(taskEffects, ['run'], 'TaskEffect composition port');
  const nativeTaskPort = optionalMethods(
    nativeTasks,
    ['ingest', 'drain'],
    'NativeTask composition port',
  );
  if (typeof normalizeInbound !== 'function') {
    throw new TypeError('normalizeInbound must be a function');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  let state = 'open';
  let active = 0;
  let drainResolve = null;
  let closePromise = null;

  function completeOperation() {
    active -= 1;
    if (active === 0 && drainResolve) {
      const resolve = drainResolve;
      drainResolve = null;
      resolve();
    }
  }

  function run(operation) {
    if (state !== 'open') {
      return Promise.reject(domainError('COMPOSITION_DRAINING', 'Feishu reply composition is draining'));
    }
    active += 1;
    return Promise.resolve().then(operation).finally(completeOperation);
  }

  function waitForActive() {
    if (active === 0) return Promise.resolve();
    return new Promise(resolve => { drainResolve = resolve; });
  }

  function normalizedInbound(rawEvent, options) {
    return normalizeInbound(rawEvent, {
      accountRef: normalizedAccountRef,
      eventId: options?.eventId,
      eventType: options?.eventType,
      sourceOrder: options?.sourceOrder ?? null,
      priority: options?.priority ?? 2,
      clock,
    });
  }

  const composition = {
    enabled: true,

    acceptMessage(rawEvent, options = {}) {
      return run(async () => {
        const accepted = await inbound.accept(rawEvent, options);
        if (!accepted?.receipt) return accepted;
        const normalized = normalizedInbound(rawEvent, options);
        const requestId = requireText(accepted.receipt.requestId, 'MessageAccepted.requestId');
        const bound = await replyPresentation.accept({
          ingressId: normalized.message.commandId,
          requestId,
          sourceMessageId: normalized.message.source.messageId,
          route: Object.freeze({
            adapterId: 'feishu',
            targetRef: normalized.message.reply.targetRef,
          }),
          presentationId: `presentation:${requestId}`,
          presenceId: `presence:${requestId}`,
        });
        return Object.freeze({
          status: accepted.status,
          receipt: accepted.receipt,
          presentation: bound,
        });
      });
    },

    recordProgress(event) {
      if (state !== 'open') {
        throw domainError('COMPOSITION_DRAINING', 'Feishu reply composition is draining');
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new TypeError('Run projection event must be an object');
      }
      const requestId = requireText(event.requestId, 'Run event.requestId');
      const snapshot = replyPresentation.inspect(requestId);
      if (!snapshot?.handle) {
        throw domainError('PRESENTATION_NOT_FOUND', `reply presentation does not exist: ${requestId}`);
      }
      return replyPresentation.recordProgress({
        requestId,
        presentationId: snapshot.handle.presentationId,
        sequence: event.sequence,
        type: event.type,
        payload: event.payload,
        terminal: TERMINAL_RUN_EVENTS.has(event.type),
      });
    },

    deliverFinal(claim) {
      return run(async () => {
        const receipt = await finalPort.deliver(claim);
        try {
          replyPresentation.observeDeliveryReceipt(receipt);
        } catch (error) {
          logger.warn?.('Final delivery receipt could not be projected', {
            requestId: receipt?.requestId,
            error: error?.message ?? String(error),
          });
        }
        return receipt;
      });
    },

    settleFinal(settlement) {
      if (state !== 'open') {
        throw domainError('COMPOSITION_DRAINING', 'Feishu reply composition is draining');
      }
      return finalPort.settle(settlement);
    },

    suppressFinal(outcome) {
      if (state !== 'open') {
        throw domainError('COMPOSITION_DRAINING', 'Feishu reply composition is draining');
      }
      return finalPort.suppress(outcome);
    },

    runTaskEffects(options) {
      if (!effectWorker) return unsupported('TaskEffect worker');
      return run(() => effectWorker.run(options));
    },

    ingestNativeTask(event) {
      if (!nativeTaskPort) return unsupported('NativeTask intake');
      if (state !== 'open') {
        throw domainError('COMPOSITION_DRAINING', 'Feishu reply composition is draining');
      }
      return nativeTaskPort.ingest(event);
    },

    drainNativeTasks(options) {
      if (!nativeTaskPort) return unsupported('NativeTask worker');
      return run(() => nativeTaskPort.drain(options));
    },

    maintain(options) {
      return run(async () => {
        const presentationResult = await replyPresentation.reconcile(options);
        return Object.freeze({ presentation: presentationResult });
      });
    },

    recover(options) {
      return run(async () => {
        const gatewayResult = await inbound.recover(options);
        const presentationResult = await replyPresentation.reconcile(options);
        const taskEffectsResult = typeof effectWorker?.recover === 'function'
          ? await effectWorker.recover(options)
          : null;
        const nativeTasksResult = typeof nativeTaskPort?.recover === 'function'
          ? await nativeTaskPort.recover(options)
          : null;
        return Object.freeze({
          gateway: gatewayResult,
          presentation: presentationResult,
          taskEffects: taskEffectsResult,
          nativeTasks: nativeTasksResult,
        });
      });
    },

    inspect(requestId) { return replyPresentation.inspect(requestId); },

    close() {
      if (closePromise) return closePromise;
      state = 'draining';
      closePromise = (async () => {
        await waitForActive();
        let failure = null;
        try {
          await inbound.close();
        } catch (error) {
          failure = error;
        }
        try {
          replyPresentation.close();
        } catch (error) {
          failure ??= error;
        }
        state = 'closed';
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };

  return Object.freeze(composition);
}

export function openFeishuReplyComposition({
  enabled = true,
  legacy,
  inboundDbPath,
  presentationDbPath,
  accountRef,
  coreIntake,
  authorize,
  reactionPort,
  cardPort,
  delivery,
  taskEffects = null,
  nativeTasks = null,
  workerId,
  clock = Date.now,
  concurrency = 4,
  leaseMs = 30_000,
  maxAttempts = 5,
  pollIntervalMs = 10,
  baseRetryDelayMs = 1_000,
  maxRetryDelayMs = 60_000,
  coalesceMs = 500,
  logger = console,
} = {}) {
  if (!enabled) return createFeishuReplyComposition({ enabled, legacy });
  const normalizedWorkerId = requireText(workerId, 'Feishu composition workerId');
  const gateway = createFeishuConversationGateway({
    dbPath: inboundDbPath,
    accountRef,
    coreIntake,
    authorize,
    workerId: `${normalizedWorkerId}:inbound`,
    clock,
    concurrency,
    leaseMs,
    maxAttempts,
    pollIntervalMs,
    baseRetryDelayMs,
    maxRetryDelayMs,
  });
  let presentation;
  try {
    presentation = openFeishuReplyPresentation({
      dbPath: presentationDbPath,
      reactionPort,
      cardPort,
      clock,
      workerId: `${normalizedWorkerId}:presentation`,
      leaseMs,
      retryDelayMs: baseRetryDelayMs,
      coalesceMs,
    });
    const finalReply = createFeishuFinalReplyPort({ delivery, presentation, clock });
    return createFeishuReplyComposition({
      enabled: true,
      accountRef,
      gateway,
      presentation,
      finalReply,
      taskEffects,
      nativeTasks,
      clock,
      logger,
    });
  } catch (error) {
    presentation?.close();
    void gateway.close().catch(() => {});
    throw error;
  }
}
