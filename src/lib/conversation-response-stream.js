import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

const PHASE_ELEMENT_ID = 'zylos_phase';
const ANSWER_ELEMENT_ID = 'zylos_answer';
const PROGRESS_ELEMENT_ID = 'zylos_progress';
const COPY_ELEMENT_ID = 'zylos_copy';
const MAX_PROGRESS_STEPS = 8;
const MAX_PUBLIC_REASONING_BYTES = 12_000;
const MAX_REASONING_DELTA_BYTES = 64 * 1024;
const MAX_CARD_BYTES = 30_000;
const DEFAULT_ANSWER_BYTES_PER_CARD = 12_000;
const DEFAULT_THROTTLE_MS = 250;
const DEFAULT_COPY_ACTION_CHARACTERS = 120;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;
const MAX_SEQUENCE = 2_147_483_647;
const EVENT_TYPES = new Set([
  'AssistantRequestAccepted',
  'RunQueued',
  'RunStarted',
  'ProgressUpdated',
  'PublicReasoningDelta',
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
const PUBLIC_ACTION_PROGRESS = Object.freeze({
  analyze_request: Object.freeze({ started: '正在分析问题' }),
  read_sources: Object.freeze({
    started: '正在读取相关资料',
    completed: '相关资料已读取',
  }),
  search_sources: Object.freeze({
    started: '正在查找相关信息',
    completed: '已找到相关信息',
  }),
  query_data: Object.freeze({
    started: '正在核对相关数据',
    completed: '相关数据已核对',
  }),
  update_content: Object.freeze({
    started: '正在整理内容更新',
    completed: '内容更新已完成',
  }),
  execute_operation: Object.freeze({
    started: '正在执行所需操作',
    completed: '所需操作已完成',
  }),
  communicate: Object.freeze({
    started: '正在处理消息与通知',
    completed: '消息与通知已处理',
  }),
  organize_result: Object.freeze({
    started: '正在整理回答',
    completed: '回答已整理',
  }),
  coordinate_work: Object.freeze({
    started: '正在协调并行工作',
    completed: '并行工作已汇总',
  }),
  prepare_workflow: Object.freeze({
    started: '正在准备所需工作流',
    completed: '工作流已准备',
  }),
  recover_tool: Object.freeze({
    failed: '操作遇到问题，正在调整方案',
  }),
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
    if (state?.version !== 1) return null;
    if (!Array.isArray(state.progress)) state.progress = [];
    if (typeof state.publicReasoning !== 'string') state.publicReasoning = '';
    return state;
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

function publicProgressText(payload) {
  const actionText = PUBLIC_ACTION_PROGRESS[payload?.action]?.[payload?.status];
  return actionText || SAFE_PROGRESS[payload?.stage] || null;
}

function phaseForEvent(event) {
  switch (event.type) {
    case 'AssistantRequestAccepted': return '✅ 已接收';
    case 'RunQueued': return '⏳ 排队中';
    case 'RunStarted': return '▶️ 已开始处理';
    case 'ProgressUpdated': return publicProgressText(event.payload);
    case 'OutputDelta': return '✍️ 正在生成回答';
    case 'RunCompleted': return '✅ 已完成';
    case 'RunFailed': return event.payload?.retryable
      ? '⚠️ 本次处理未完成，可重试'
      : '⚠️ 本次处理未完成';
    default: return null;
  }
}

function progressForEvent(event) {
  if (event.type === 'RunStarted') return '正在分析问题';
  if (event.type === 'ProgressUpdated') return publicProgressText(event.payload);
  if (event.type === 'OutputDelta') return '正在生成回答';
  return null;
}

function appendProgress(state, step) {
  if (!step || state.progress.includes(step)) return;
  if (state.progress.length >= MAX_PROGRESS_STEPS) {
    state.progress.splice(state.progress.length > 1 ? 1 : 0, 1);
  }
  state.progress.push(step);
}

function appendPublicReasoning(state, delta) {
  const combined = `${state.publicReasoning || ''}${delta}`;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_PUBLIC_REASONING_BYTES) {
    state.publicReasoning = combined;
    return;
  }
  const omission = '_…较早思路已省略…_\n';
  const budget = MAX_PUBLIC_REASONING_BYTES - Buffer.byteLength(omission, 'utf8');
  const characters = Array.from(combined);
  const kept = [];
  let bytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const characterBytes = Buffer.byteLength(characters[index], 'utf8');
    if (bytes + characterBytes > budget) break;
    kept.push(characters[index]);
    bytes += characterBytes;
  }
  state.publicReasoning = `${omission}${kept.reverse().join('')}`;
}

function renderProcessTrace(progress, publicReasoning) {
  const stages = progress.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const reasoning = publicReasoning.trim();
  return [
    '**处理过程（实时）**',
    '_仅展示可公开的阶段与工作摘要，不含模型隐藏思维；完成后自动收起_',
    stages,
    reasoning ? `\n**公开工作摘要**\n${reasoning}` : '',
  ].filter(Boolean).join('\n');
}

function clearTransientProcess(state) {
  state.progress = [];
  state.publicReasoning = '';
}

function copyButton(requestId) {
  return {
    tag: 'button',
    element_id: COPY_ELEMENT_ID,
    text: { tag: 'plain_text', content: '获取可复制文本' },
    type: 'default',
    width: 'fill',
    behaviors: [{
      type: 'callback',
      value: { action: 'assistant_response_copy', requestId },
    }],
  };
}

function shouldOfferCopy(answer) {
  return Array.from(answer || '').length >= DEFAULT_COPY_ACTION_CHARACTERS;
}

function renderCard({
  phase,
  answer,
  progress = [],
  publicReasoning = '',
  streaming,
  part,
  totalParts,
  copyRequestId = null,
}) {
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
        ...(streaming && (publicReasoning || progress.length > 0)
          ? [{
              tag: 'markdown',
              element_id: PROGRESS_ELEMENT_ID,
              content: renderProcessTrace(progress, publicReasoning),
            }]
          : []),
        ...(!streaming && copyRequestId ? [copyButton(copyRequestId)] : []),
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
  if (target.chatType === 'group' && target.replyToMessageId) {
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
  if (value.type === 'PublicReasoningDelta') {
    if (typeof value.payload.delta !== 'string' || value.payload.delta.length === 0) {
      throw new TypeError('PublicReasoningDelta requires a real string delta');
    }
    if (Buffer.byteLength(value.payload.delta, 'utf8') > MAX_REASONING_DELTA_BYTES) {
      throw new TypeError('PublicReasoningDelta exceeds the supported size');
    }
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
      progress: state.progress,
      publicReasoning: state.publicReasoning,
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
      progress: state.progress,
      publicReasoning: state.publicReasoning,
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
      const terminalFingerprint = terminal
        ? createHash('sha256')
          .update(`${state.status}\0${state.output}`)
          .digest('hex')
          .slice(0, 20)
        : null;
      if (terminal && state.plainTerminalFingerprint !== terminalFingerprint) {
        const text = state.status === 'completed'
          ? (state.output || '处理完成。')
          : state.phase;
        await sendPlain(
          client,
          state.target,
          text,
          stableToken(state.requestId, `plain-terminal:${terminalFingerprint}`),
        );
        state.plainTerminalSent = true;
        state.plainTerminalFingerprint = terminalFingerprint;
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
        progress: state.progress,
        publicReasoning: state.publicReasoning,
        streaming: state.mode === 'cardkit' && !terminal && part === segments.length - 1,
        part,
        totalParts: segments.length,
        copyRequestId: terminal
          && state.status === 'completed'
          && part === 0
          && shouldOfferCopy(state.output)
          ? state.requestId
          : null,
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
    clearTransientProcess(state);
    state.compatibilityTerminal = true;
    await render(state, { terminal: true, purpose: 'compatibility-terminal' });
    save(state);
    return { handled: true, messageId: state.cards[0]?.messageId || state.plainMessageId };
  }

  return Object.freeze({
    async sendCompleted(input) {
      const request = requireRecord(input, 'completed response request');
      requireExactFields(request, ['requestId', 'target', 'output'], 'completed response request');
      const requestId = requireText(request.requestId, 'requestId');
      const targetValue = requireRecord(request.target, 'target');
      requireExactFields(targetValue, ['chatId', 'chatType', 'replyToMessageId'], 'target');
      const target = {
        chatId: requireText(targetValue.chatId, 'target.chatId'),
        chatType: targetValue.chatType,
        replyToMessageId: targetValue.replyToMessageId === null
          ? null
          : requireText(targetValue.replyToMessageId, 'target.replyToMessageId'),
      };
      if (!['p2p', 'group'].includes(target.chatType)) {
        throw new TypeError('target.chatType is unsupported');
      }
      const output = typeof request.output === 'string' ? request.output : String(request.output || '');
      const release = await acquireRequestLock(requestId);
      try {
        const existing = load(requestId);
        if (existing) {
          if (existing.status !== 'completed'
            || existing.output !== output
            || JSON.stringify(existing.target) !== JSON.stringify(target)) {
            const error = new Error('completed response requestId already owns different content');
            error.code = 'ASSISTANT_TERMINAL_CONFLICT';
            throw error;
          }
          return {
            handled: true,
            replayed: true,
            parts: existing.cards.length,
            messageId: existing.cards[0]?.messageId || existing.plainMessageId,
          };
        }

        const state = {
          version: 1,
          requestId,
          target,
          mode: 'ordinary_card',
          status: 'completed',
          phase: '✅ 已完成',
          progress: [],
          publicReasoning: '',
          output,
          lastEventSequence: 0,
          lastRenderedAt: clock(),
          compatibilityTerminal: false,
          plainTerminalSent: false,
          plainTerminalFingerprint: null,
          cards: [],
        };
        const segments = splitUtf8(output, answerBytesPerCard);
        try {
          for (let part = 0; part < segments.length; part += 1) {
            const card = renderCard({
              phase: state.phase,
              answer: segments[part],
              streaming: false,
              part,
              totalParts: segments.length,
              copyRequestId: part === 0 && shouldOfferCopy(output) ? requestId : null,
            });
            const messageId = await sendInteractive(
              client,
              target,
              card,
              stableToken(requestId, `completed:${part}`),
            );
            state.cards.push({
              part,
              messageId,
              cardId: null,
              nextSequence: 1,
              closed: true,
              rendered: card,
            });
            save(state);
          }
        } catch (error) {
          error.deliveredParts = state.cards.length;
          throw error;
        }
        return {
          handled: true,
          replayed: false,
          parts: state.cards.length,
          messageId: state.cards[0]?.messageId,
        };
      } finally {
        release();
      }
    },

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
            progress: [],
            publicReasoning: '',
            output: '',
            lastEventSequence: 0,
            lastRenderedAt: clock(),
            compatibilityTerminal: false,
            plainTerminalSent: false,
            plainTerminalFingerprint: null,
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
            progress: [],
            publicReasoning: '',
            output: '',
            lastEventSequence: 0,
            lastRenderedAt: clock(),
            compatibilityTerminal: false,
            plainTerminalSent: false,
            plainTerminalFingerprint: null,
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
        const compatibility = state.compatibilityTerminal
          ? { status: state.status, output: state.output, phase: state.phase }
          : null;
        let canonicalStatus = compatibility ? null : state.status;
        let canonicalPhase = compatibility ? state.phase : null;
        let canonicalOutput = compatibility ? (state.durableOutput || '') : null;
        let changed = false;
        let terminal = false;
        let containsDelta = false;
        for (const event of events) {
          if (event.sequence <= state.lastEventSequence) continue;
          if (event.sequence !== state.lastEventSequence + 1) {
            throw new Error(`assistant response event gap: expected ${state.lastEventSequence + 1}, received ${event.sequence}`);
          }
          const phase = phaseForEvent(event);
          appendProgress(state, progressForEvent(event));
          if (event.type === 'PublicReasoningDelta') {
            appendPublicReasoning(state, event.payload.delta);
            containsDelta = true;
          }
          if (compatibility) {
            if (phase) canonicalPhase = phase;
            if (event.type === 'AssistantRequestAccepted') canonicalStatus = 'accepted';
            if (event.type === 'RunQueued') canonicalStatus = 'queued';
            if (event.type === 'RunStarted') canonicalStatus = 'started';
            if (event.type === 'OutputDelta') {
              canonicalOutput += event.payload.delta;
              containsDelta = true;
            }
            if (event.type === 'RunCompleted') {
              canonicalOutput = event.payload.output;
              canonicalStatus = 'completed';
              clearTransientProcess(state);
              terminal = true;
            }
            if (event.type === 'RunFailed') {
              canonicalStatus = 'failed';
              clearTransientProcess(state);
              terminal = true;
            }
          } else {
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
              clearTransientProcess(state);
              terminal = true;
            }
            if (event.type === 'RunFailed') {
              state.status = 'failed';
              clearTransientProcess(state);
              terminal = true;
            }
          }
          state.lastEventSequence = event.sequence;
          changed = true;
        }
        if (!changed) return { handled: true, replayed: true, status: state.status };

        if (compatibility) {
          state.durableOutput = canonicalOutput;
          if (!terminal) {
            save(state);
            return { handled: true, replayed: false, status: compatibility.status };
          }
          const sameTerminal = canonicalStatus === compatibility.status
            && canonicalOutput === compatibility.output;
          state.status = canonicalStatus;
          state.phase = canonicalPhase;
          state.output = canonicalOutput;
          state.compatibilityTerminal = false;
          delete state.durableOutput;
          if (sameTerminal) {
            save(state);
            return { handled: true, replayed: false, status: state.status };
          }
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
