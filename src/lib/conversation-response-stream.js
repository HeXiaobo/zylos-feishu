import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

const PHASE_ELEMENT_ID = 'zylos_phase';
const ANSWER_ELEMENT_ID = 'zylos_answer';
const MAX_CARD_BYTES = 30_000;
const DEFAULT_ANSWER_BYTES_PER_CARD = 12_000;
const DEFAULT_THROTTLE_MS = 250;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;
const MAX_SEQUENCE = 2_147_483_647;
const EVENT_TYPES = new Set([
  'AssistantRequestAccepted',
  'RunQueued',
  'RunStarted',
  'ProgressUpdated',
  'OutputDelta',
  'RunCompleted',
  'RunFailed',
]);
const SAFE_PROGRESS = Object.freeze({
  reading: '正在读取资料',
  searching: '正在查找信息',
  querying: '正在查询数据',
  writing: '正在整理内容',
  executing: '正在执行操作',
  communicating: '正在处理通信',
  organizing: '正在整理结果',
  recovering: '工具调用未成功，正在安全恢复',
});

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maxLength = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maxLength) throw new TypeError(`${field} is too long`);
  return text;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireSuccess(response, operation) {
  if (response?.code !== 0) {
    const error = new Error(response?.msg || `${operation} failed`);
    error.code = response?.code;
    throw error;
  }
  return response;
}

function stableToken(requestId, purpose) {
  return `zcr_${createHash('sha256').update(`${requestId}:${purpose}`).digest('hex').slice(0, 40)}`;
}

function statePath(directory, requestId) {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return path.join(directory, `${digest}.json`);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readState(filePath) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return state?.version === 1 ? state : null;
  } catch {
    return null;
  }
}

function splitUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const segments = [];
  let current = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes && current) {
      segments.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current || segments.length === 0) segments.push(current);
  return segments;
}

function phaseForEvent(event) {
  switch (event.type) {
    case 'AssistantRequestAccepted': return '✅ 已接收';
    case 'RunQueued': return '⏳ 排队中';
    case 'RunStarted': return '▶️ 已开始处理';
    case 'ProgressUpdated': return SAFE_PROGRESS[event.payload?.stage] || null;
    case 'RunCompleted': return '✅ 已完成';
    case 'RunFailed': return event.payload?.retryable
      ? '⚠️ 本次处理未完成，可重试'
      : '⚠️ 本次处理未完成';
    default: return null;
  }
}

function renderCard({ phase, answer, streaming, part, totalParts }) {
  const continuation = part > 0
    ? `\n\n_续 ${part + 1}${totalParts > 1 ? ` / ${totalParts}` : ''}_`
    : '';
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      streaming_mode: streaming,
      summary: { content: streaming ? 'Zylos 正在处理…' : phase },
      ...(streaming
        ? {
            streaming_config: {
              print_frequency_ms: { default: 45 },
              print_step: { default: 1 },
              print_strategy: 'fast',
            },
          }
        : {}),
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: PHASE_ELEMENT_ID, content: phase },
        {
          tag: 'markdown',
          element_id: ANSWER_ELEMENT_ID,
          content: `${answer || (streaming ? '_等待回答…_' : '_没有可显示的回答_')}${continuation}`,
        },
      ],
    },
  };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES) {
    throw new TypeError('conversation response card exceeds Feishu size limit');
  }
  return card;
}

function normalizeTarget(value) {
  const target = requireRecord(value, 'target');
  requireExactFields(target, ['chatId', 'chatType', 'replyToMessageId'], 'target');
  const chatId = requireText(target.chatId, 'target.chatId');
  if (!['p2p', 'group'].includes(target.chatType)) throw new TypeError('target.chatType is unsupported');
  const replyToMessageId = target.replyToMessageId === null
    ? null
    : requireText(target.replyToMessageId, 'target.replyToMessageId');
  if (target.chatType === 'group' && !replyToMessageId) {
    throw new TypeError('group response streams require replyToMessageId');
  }
  return { chatId, chatType: target.chatType, replyToMessageId };
}

async function sendMessage(client, target, msgType, content, uuid) {
  const data = { msg_type: msgType, content, uuid };
  if (target.chatType === 'group') {
    return requireSuccess(await client.im.message.reply({
      path: { message_id: target.replyToMessageId },
      data,
    }), 'Feishu conversation response reply');
  }
  return requireSuccess(await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: target.chatId, ...data },
  }), 'Feishu conversation response send');
}

async function sendInteractive(client, target, card, uuid) {
  const response = await sendMessage(client, target, 'interactive', JSON.stringify(card), uuid);
  return requireText(response.data?.message_id, 'Feishu response messageId');
}

async function sendPlain(client, target, text, uuid) {
  const response = await sendMessage(client, target, 'text', JSON.stringify({ text }), uuid);
  return requireText(response.data?.message_id, 'Feishu fallback messageId');
}

function validateEvent(event, requestId) {
  const value = requireRecord(event, 'assistant response event');
  requireExactFields(
    value,
    ['schemaVersion', 'eventId', 'requestId', 'sequence', 'type', 'occurredAt', 'payload'],
    'assistant response event',
  );
  if (value.schemaVersion !== 1) throw new TypeError('assistant response event schema is unsupported');
  if (value.requestId !== requestId) throw new TypeError('assistant response event requestId mismatch');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
    throw new TypeError('assistant response event sequence must be positive');
  }
  if (!EVENT_TYPES.has(value.type)) throw new TypeError('assistant response event type is unsupported');
  requireRecord(value.payload, 'assistant response event payload');
  if (value.type === 'OutputDelta' && typeof value.payload.delta !== 'string') {
    throw new TypeError('OutputDelta requires a real string delta');
  }
  if (value.type === 'RunCompleted' && typeof value.payload.output !== 'string') {
    throw new TypeError('RunCompleted requires canonical output');
  }
  if (value.type === 'ProgressUpdated' && !Object.hasOwn(SAFE_PROGRESS, value.payload.stage)) {
    throw new TypeError('ProgressUpdated stage is not safe to display');
  }
  if (value.type === 'RunFailed' && typeof value.payload.retryable !== 'boolean') {
    throw new TypeError('RunFailed retryable flag is required');
  }
  return value;
}

function nextSequence(card) {
  if (!Number.isSafeInteger(card.nextSequence) || card.nextSequence < 1 || card.nextSequence > MAX_SEQUENCE) {
    throw new TypeError('CardKit sequence exhausted');
  }
  const sequence = card.nextSequence;
  card.nextSequence += 1;
  return sequence;
}

/**
 * Feishu-owned ConversationResponseStream Module.  Callers only open a stream
 * and apply channel-neutral lifecycle events; the implementation hides stable
 * message creation, CardKit conversion, coalescing, monotonic sequences,
 * overlong continuation cards, restart state, terminal close, and fallback.
 */
export function createConversationResponseStream({
  client,
  stateDirectory = path.join(DATA_DIR, 'conversation-response-streams'),
  clock = Date.now,
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  throttleMs = DEFAULT_THROTTLE_MS,
  answerBytesPerCard = DEFAULT_ANSWER_BYTES_PER_CARD,
  logger = console,
} = {}) {
  requireRecord(client, 'client');
  if (typeof clock !== 'function' || typeof pause !== 'function') {
    throw new TypeError('clock and pause must be functions');
  }
  if (!Number.isSafeInteger(throttleMs) || throttleMs < 0) throw new TypeError('throttleMs is invalid');
  if (!Number.isSafeInteger(answerBytesPerCard) || answerBytesPerCard < 256) {
    throw new TypeError('answerBytesPerCard is invalid');
  }

  function load(requestId) {
    return readState(statePath(stateDirectory, requestId));
  }

  function save(state) {
    atomicWrite(statePath(stateDirectory, state.requestId), state);
  }

  async function acquireRequestLock(requestId) {
    fs.mkdirSync(stateDirectory, { recursive: true });
    const filePath = `${statePath(stateDirectory, requestId)}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      let descriptor = null;
      try {
        descriptor = fs.openSync(filePath, 'wx', 0o600);
        fs.writeFileSync(descriptor, token, 'utf8');
        return () => {
          try {
            fs.closeSync(descriptor);
          } catch {
            // The lock still has a token check before removal.
          }
          try {
            if (fs.readFileSync(filePath, 'utf8') === token) fs.unlinkSync(filePath);
          } catch {
            // A stale-lock recovery may already have removed it.
          }
        };
      } catch (error) {
        if (descriptor !== null) {
          try { fs.closeSync(descriptor); } catch {}
        }
        if (error?.code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - fs.statSync(filePath).mtimeMs;
          if (age > STALE_LOCK_MS) {
            fs.unlinkSync(filePath);
            continue;
          }
        } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() >= deadline) throw new Error('conversation response stream is busy');
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  async function convertCard(messageId) {
    const converted = await client.cardkit.v1.card.idConvert({ data: { message_id: messageId } });
    if (converted?.code !== 0 || !converted.data?.card_id) return null;
    return requireText(converted.data.card_id, 'Feishu CardKit cardId');
  }

  async function patchOrdinary(messageId, card) {
    requireSuccess(await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }), 'Feishu ordinary response card patch');
  }

  async function settleInitialCardMode(state) {
    if (state.mode !== 'conversion_pending') return;
    const [initial] = state.cards;
    const cardId = await convertCard(initial.messageId);
    if (cardId) {
      initial.cardId = cardId;
      state.mode = 'cardkit';
      save(state);
      return;
    }
    const ordinary = renderCard({
      phase: state.phase,
      answer: state.output,
      streaming: false,
      part: 0,
      totalParts: 1,
    });
    await patchOrdinary(initial.messageId, ordinary);
    initial.rendered = ordinary;
    state.mode = 'ordinary_card';
    save(state);
  }

  async function updateCard(state, cardState, card, purpose) {
    if (state.mode === 'ordinary_card') {
      await patchOrdinary(cardState.messageId, card);
      cardState.rendered = card;
      return;
    }
    const sequence = nextSequence(cardState);
    requireSuccess(await client.cardkit.v1.card.update({
      path: { card_id: cardState.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence,
        uuid: stableToken(state.requestId, `${purpose}:${cardState.part}:${sequence}`),
      },
    }), 'Feishu response card update');
    cardState.rendered = card;
  }

  async function closeCard(state, cardState, purpose) {
    if (cardState.closed) return;
    if (state.mode === 'cardkit') {
      const sequence = nextSequence(cardState);
      requireSuccess(await client.cardkit.v1.card.settings({
        path: { card_id: cardState.cardId },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: false,
              summary: { content: state.phase },
            },
          }),
          sequence,
          uuid: stableToken(state.requestId, `${purpose}:${cardState.part}:${sequence}`),
        },
      }), 'Feishu response card close');
    }
    cardState.closed = true;
  }

  async function createContinuation(state, part, answer, totalParts, terminal) {
    const card = renderCard({
      phase: state.phase,
      answer,
      streaming: !terminal,
      part,
      totalParts,
    });
    const messageId = await sendInteractive(
      client,
      state.target,
      card,
      stableToken(state.requestId, `part:${part}`),
    );
    const cardId = await convertCard(messageId);
    const cardState = {
      part,
      messageId,
      cardId,
      nextSequence: 1,
      closed: terminal,
      rendered: card,
    };
    if (!cardId && state.mode === 'cardkit') {
      logger.warn?.('CardKit conversion unavailable for continuation; using ordinary cards', {
        requestId: state.requestId,
        part,
      });
      state.mode = 'ordinary_card';
    }
    state.cards.push(cardState);
    if (terminal) await closeCard(state, cardState, `close-terminal-part-${part}`);
    return cardState;
  }

  async function render(state, { terminal = false, purpose = 'event' } = {}) {
    if (state.mode === 'plain_text') {
      if (terminal && !state.plainTerminalSent) {
        const text = state.status === 'completed'
          ? (state.output || '处理完成。')
          : state.phase;
        await sendPlain(
          client,
          state.target,
          text,
          stableToken(state.requestId, 'plain-terminal'),
        );
        state.plainTerminalSent = true;
        save(state);
      }
      return;
    }

    const segments = splitUtf8(state.output, answerBytesPerCard);
    for (let part = 0; part < segments.length; part += 1) {
      let cardState = state.cards[part];
      if (!cardState) {
        const previous = state.cards.at(-1);
        if (previous) await closeCard(state, previous, `close-before-part-${part}`);
        cardState = await createContinuation(state, part, segments[part], segments.length, terminal);
      }
      const card = renderCard({
        phase: state.phase,
        answer: segments[part],
        streaming: state.mode === 'cardkit' && !terminal && part === segments.length - 1,
        part,
        totalParts: segments.length,
      });
      if (JSON.stringify(cardState.rendered) !== JSON.stringify(card)) {
        await updateCard(state, cardState, card, purpose);
      }
      if (terminal || part < segments.length - 1) {
        await closeCard(state, cardState, `${purpose}:close`);
      }
    }
    state.lastRenderedAt = clock();
  }

  async function terminalCompatibility(requestId, output, status, phase) {
    const state = load(requestId);
    if (!state) return { handled: false, reason: 'stream_not_found' };
    if (['completed', 'failed'].includes(state.status)) {
      if (state.status === status && state.output === output) {
        return { handled: true, replayed: true, messageId: state.cards[0]?.messageId || state.plainMessageId };
      }
      const error = new Error('conversation response stream already has a different terminal result');
      error.code = 'ASSISTANT_TERMINAL_CONFLICT';
      throw error;
    }
    try {
      await settleInitialCardMode(state);
    } catch (error) {
      // The Core completion event is persisted after this compatibility call.
      // Defer projection to that reliable delivery path instead of making the
      // caller send a second answer card and orphaning the accepted placeholder.
      logger.warn?.('Response placeholder repair deferred to durable event delivery', {
        requestId,
        error: error.message,
      });
      return {
        handled: true,
        pending: true,
        messageId: state.cards[0]?.messageId || state.plainMessageId,
      };
    }
    state.output = output;
    state.status = status;
    state.phase = phase;
    state.compatibilityTerminal = true;
    await render(state, { terminal: true, purpose: 'compatibility-terminal' });
    save(state);
    return { handled: true, messageId: state.cards[0]?.messageId || state.plainMessageId };
  }

  return Object.freeze({
    async open(input) {
      const request = requireRecord(input, 'open response stream request');
      requireExactFields(request, ['requestId', 'target'], 'open response stream request');
      const requestId = requireText(request.requestId, 'requestId');
      const target = normalizeTarget(request.target);
      const release = await acquireRequestLock(requestId);
      try {
        const existing = load(requestId);
        if (existing) {
          if (JSON.stringify(existing.target) !== JSON.stringify(target)) {
            throw new Error('response stream requestId belongs to a different target');
          }
          return { handled: true, replayed: true, mode: existing.mode, messageId: existing.cards[0]?.messageId || existing.plainMessageId };
        }

        const initialCard = renderCard({
          phase: '正在接收消息…',
          answer: '',
          streaming: true,
          part: 0,
          totalParts: 1,
        });
        let state;
        let messageId = null;
        try {
          messageId = await sendInteractive(
            client,
            target,
            initialCard,
            stableToken(requestId, 'placeholder'),
          );
        } catch (error) {
          logger.warn?.('Interactive response placeholder failed; using plain text', {
            requestId,
            error: error.message,
          });
          const plainMessageId = await sendPlain(
            client,
            target,
            '已接收，正在处理…',
            stableToken(requestId, 'plain-placeholder'),
          );
          state = {
            version: 1,
            requestId,
            target,
            mode: 'plain_text',
            plainMessageId,
            status: 'opening',
            phase: '正在接收消息…',
            output: '',
            lastEventSequence: 0,
            lastRenderedAt: clock(),
            compatibilityTerminal: false,
            plainTerminalSent: false,
            cards: [],
          };
        }
        if (messageId) {
          state = {
            version: 1,
            requestId,
            target,
            mode: 'conversion_pending',
            status: 'opening',
            phase: '正在接收消息…',
            output: '',
            lastEventSequence: 0,
            lastRenderedAt: clock(),
            compatibilityTerminal: false,
            plainTerminalSent: false,
            cards: [{
              part: 0,
              messageId,
              cardId: null,
              nextSequence: 1,
              closed: false,
              rendered: initialCard,
            }],
          };
          // Once Feishu has accepted the stable placeholder UUID, persist its
          // ownership before attempting conversion.  A later conversion or
          // patch failure must repair this message, never send a second one.
          save(state);
          try {
            await settleInitialCardMode(state);
          } catch (error) {
            logger.warn?.('CardKit placeholder conversion is pending repair', {
              requestId,
              error: error.message,
            });
          }
        }
        save(state);
        return {
          handled: true,
          replayed: false,
          mode: state.mode,
          messageId: state.cards[0]?.messageId || state.plainMessageId,
        };
      } finally {
        release();
      }
    },

    async apply(input) {
      const request = requireRecord(input, 'apply response events request');
      requireExactFields(request, ['requestId', 'events'], 'apply response events request');
      const requestId = requireText(request.requestId, 'requestId');
      if (!Array.isArray(request.events) || request.events.length === 0) {
        throw new TypeError('events must be a non-empty array');
      }
      const release = await acquireRequestLock(requestId);
      try {
        const state = load(requestId);
        if (!state) return { handled: false, reason: 'stream_not_found' };
        await settleInitialCardMode(state);
        const events = request.events
          .map(event => validateEvent(event, requestId))
          .sort((left, right) => left.sequence - right.sequence);
        let changed = false;
        let terminal = false;
        let containsDelta = false;
        for (const event of events) {
          if (event.sequence <= state.lastEventSequence) continue;
          if (event.sequence !== state.lastEventSequence + 1) {
            throw new Error(`assistant response event gap: expected ${state.lastEventSequence + 1}, received ${event.sequence}`);
          }
          const phase = phaseForEvent(event);
          if (phase) state.phase = phase;
          if (event.type === 'AssistantRequestAccepted') state.status = 'accepted';
          if (event.type === 'RunQueued') state.status = 'queued';
          if (event.type === 'RunStarted') state.status = 'started';
          if (event.type === 'OutputDelta') {
            state.output += event.payload.delta;
            containsDelta = true;
          }
          if (event.type === 'RunCompleted') {
            state.output = event.payload.output;
            state.status = 'completed';
            terminal = true;
          }
          if (event.type === 'RunFailed') {
            state.status = 'failed';
            terminal = true;
          }
          state.lastEventSequence = event.sequence;
          changed = true;
        }
        if (!changed) return { handled: true, replayed: true, status: state.status };

        // A compatibility completion may have already closed the same card before
        // the durable terminal event arrives.  Advance the event cursor without
        // reopening or duplicating the answer.
        if (state.compatibilityTerminal && ['completed', 'failed'].includes(state.status)) {
          save(state);
          return { handled: true, replayed: false, status: state.status };
        }

        const elapsed = clock() - state.lastRenderedAt;
        if (!terminal && (containsDelta || state.status === 'started') && elapsed < throttleMs) {
          await pause(throttleMs - elapsed);
        }
        await render(state, { terminal, purpose: `event-${state.lastEventSequence}` });
        save(state);
        return {
          handled: true,
          replayed: false,
          status: state.status,
          parts: state.cards.length || 1,
        };
      } finally {
        release();
      }
    },

    async completeWithFullAnswer({ requestId, output } = {}) {
      const id = requireText(requestId, 'requestId');
      const release = await acquireRequestLock(id);
      try {
        return await terminalCompatibility(
          id,
          typeof output === 'string' ? output : String(output || ''),
          'completed',
          '✅ 已完成',
        );
      } finally {
        release();
      }
    },

    async fail({ requestId, retryable = true } = {}) {
      const id = requireText(requestId, 'requestId');
      const release = await acquireRequestLock(id);
      try {
        return await terminalCompatibility(
          id,
          '',
          'failed',
          retryable ? '⚠️ 本次处理未完成，可重试' : '⚠️ 本次处理未完成',
        );
      } finally {
        release();
      }
    },
  });
}
