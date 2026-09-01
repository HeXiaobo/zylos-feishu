import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

const PHASE_ELEMENT_ID = 'zylos_phase';
const ANSWER_ELEMENT_ID = 'zylos_answer';
const PROGRESS_ELEMENT_ID = 'zylos_progress';
const MAX_PROGRESS_STEPS = 8;
const MAX_PUBLIC_REASONING_BYTES = 12_000;
const MAX_REASONING_DELTA_BYTES = 64 * 1024;
const MAX_CARD_BYTES = 30_000;
const DEFAULT_ANSWER_BYTES_PER_CARD = 12_000;
const DEFAULT_QUEUED_TIMEOUT_MS = 60_000;
const DEFAULT_MAIN_TIMEOUT_MS = 900_000;
const MAX_CHAT_LIST_SUMMARY_BYTES = 120;
const SUMMARY_ELLIPSIS = '…';
const DEFAULT_THROTTLE_MS = 250;
const RETRYABLE_FAILURE_ANSWER = '⚠️ 本次回复未生成，请重新发送。';
const NON_RETRYABLE_FAILURE_ANSWER = '⚠️ 本次回复未生成，请稍后再试。';
const MAIN_TIMEOUT_PHASE = '⚠️ 回复超时，请重试';
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 120_000;
const MAX_SEQUENCE = 2_147_483_647;
const PROCESS_DISPLAYS = new Set(['collapsible', 'answer_only']);
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
    error.deliveryOutcome = 'rejected';
    throw error;
  }
  return response;
}

function deliveryError(error) {
  if (error?.deliveryOutcome === 'rejected') return error;
  const explicitCode = error?.response?.data?.code;
  if (Number.isInteger(explicitCode) && explicitCode !== 0) {
    error.deliveryOutcome = 'rejected';
    return error;
  }
  const uncertain = error instanceof Error ? error : new Error(String(error));
  uncertain.code = 'FEISHU_DELIVERY_OUTCOME_UNKNOWN';
  uncertain.deliveryOutcome = 'unknown';
  return uncertain;
}

function stableToken(requestId, purpose) {
  return `zcr_${createHash('sha256').update(`${requestId}:${purpose}`).digest('hex').slice(0, 40)}`;
}

function outputHash(output) {
  return createHash('sha256').update(output).digest('hex');
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

function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function completedChatListSummary(output) {
  const normalized = typeof output === 'string'
    ? output
      .replace(/\r\n?/g, '\n')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .split('\n')
      .map(line => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    : '';
  const summary = normalized || '处理完成。';
  if (Buffer.byteLength(summary, 'utf8') <= MAX_CHAT_LIST_SUMMARY_BYTES) return summary;
  return `${truncateUtf8(summary, MAX_CHAT_LIST_SUMMARY_BYTES - Buffer.byteLength(SUMMARY_ELLIPSIS, 'utf8'))}${SUMMARY_ELLIPSIS}`;
}

function terminalChatListSummary(state) {
  return state.status === 'completed'
    ? completedChatListSummary(state.output)
    : state.phase;
}

function failureAnswer(phase) {
  return typeof phase === 'string' && (phase.includes('可重试') || phase.includes('请重试'))
    ? RETRYABLE_FAILURE_ANSWER
    : NON_RETRYABLE_FAILURE_ANSWER;
}

function publicProgressText(payload) {
  const actionText = PUBLIC_ACTION_PROGRESS[payload?.action]?.[payload?.status];
  return actionText || SAFE_PROGRESS[payload?.stage] || null;
}

function phaseForEvent(event) {
  switch (event.type) {
    case 'AssistantRequestAccepted': return '✅ 已接收';
    case 'RunQueued': return '⏳ 排队中';
    case 'RunStarted': return '思考中';
    case 'ProgressUpdated': return publicProgressText(event.payload);
    case 'OutputDelta': return '正在生成回答';
    case 'RunCompleted': return null;
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
  const stages = progress.map(step => `- ${step}`).join('\n');
  const reasoning = publicReasoning.trim();
  return [
    stages,
    reasoning ? `\n**工作摘要**\n${reasoning}` : '',
    '_仅展示可公开信息，不含模型隐藏思维_',
  ].filter(Boolean).join('\n');
}

function renderProcessPanel(phase, progress, publicReasoning) {
  return {
    tag: 'collapsible_panel',
    element_id: PROGRESS_ELEMENT_ID,
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: phase },
    },
    elements: [{
      tag: 'markdown',
      content: renderProcessTrace(progress, publicReasoning),
    }],
  };
}

function clearTransientProcess(state) {
  state.progress = [];
  state.publicReasoning = '';
}

function renderCard({
  phase,
  answer,
  summary,
  progress = [],
  publicReasoning = '',
  streaming,
  running = streaming,
  part,
  totalParts,
  processDisplay = 'collapsible',
}) {
  const continuation = part > 0
    ? `\n\n_续 ${part + 1}${totalParts > 1 ? ` / ${totalParts}` : ''}_`
    : '';
  const showProcess = processDisplay === 'collapsible'
    && running
    && (publicReasoning || progress.length > 0);
  const showPhase = Boolean(phase)
    && (!running || (processDisplay === 'collapsible' && !showProcess));
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      streaming_mode: streaming,
      summary: { content: summary || (running ? '正在回复…' : phase) },
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
        ...(showProcess
          ? [renderProcessPanel(phase, progress, publicReasoning)]
          : (showPhase ? [{ tag: 'markdown', element_id: PHASE_ELEMENT_ID, content: phase }] : [])),
        {
          tag: 'markdown',
          element_id: ANSWER_ELEMENT_ID,
          content: `${answer || (running
            ? '_等待回答…_'
            : (phase?.startsWith('⚠️') ? failureAnswer(phase) : '_没有可显示的回答_'))}${continuation}`,
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
  try {
    const response = await sendMessage(client, target, 'interactive', JSON.stringify(card), uuid);
    return requireText(response.data?.message_id, 'Feishu response messageId');
  } catch (error) {
    throw deliveryError(error);
  }
}

async function sendPlain(client, target, text, uuid) {
  try {
    const response = await sendMessage(client, target, 'text', JSON.stringify({ text }), uuid);
    return requireText(response.data?.message_id, 'Feishu fallback messageId');
  } catch (error) {
    throw deliveryError(error);
  }
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
  if (value.type === 'RunCompleted') {
    if (typeof value.payload.output !== 'string') {
      throw new TypeError('RunCompleted requires canonical output');
    }
    if (value.payload.output.trim() === '') {
      const error = new Error('RunCompleted output is blank');
      error.code = 'MISSING_OUTPUT';
      throw error;
    }
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
  queuedTimeoutMs = DEFAULT_QUEUED_TIMEOUT_MS,
  mainTimeoutMs = DEFAULT_MAIN_TIMEOUT_MS,
  processDisplay = 'collapsible',
  completedDeliveryReconciler = null,
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
  if (!Number.isSafeInteger(queuedTimeoutMs) || queuedTimeoutMs < 1) {
    throw new TypeError('queuedTimeoutMs is invalid');
  }
  if (!Number.isSafeInteger(mainTimeoutMs) || mainTimeoutMs < 1) {
    throw new TypeError('mainTimeoutMs is invalid');
  }
  if (!PROCESS_DISPLAYS.has(processDisplay)) throw new TypeError('processDisplay is invalid');
  if (completedDeliveryReconciler !== null && typeof completedDeliveryReconciler !== 'function') {
    throw new TypeError('completedDeliveryReconciler must be a function or null');
  }

  function load(requestId) {
    return readState(statePath(stateDirectory, requestId));
  }

  function save(state) {
    atomicWrite(statePath(stateDirectory, state.requestId), state);
  }

  function compactTerminalState(state) {
    const terminalOutput = typeof state.output === 'string' ? state.output : '';
    state.outputHash = outputHash(terminalOutput);
    state.terminalTombstone = true;
    state.terminalAt = clock();
    if (state.status === 'failed' && terminalOutput === '') {
      logger.warn?.('Terminal failed state with empty output', {
        requestId: state.requestId,
        phase: state.phase,
      });
    }
    clearTransientProcess(state);
    delete state.queuedAt;
    delete state.queuedTimeoutObservedAt;
    delete state.mainStartedAt;
    delete state.output;
    for (const card of state.cards) delete card.rendered;
  }

  function terminalOutputMatches(state, output) {
    return typeof state.output === 'string'
      ? state.output === output
      : state.outputHash === outputHash(output);
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

  async function settleInitialCardMode(state, { fallbackOnConversionError = false } = {}) {
    if (state.mode !== 'conversion_pending') return;
    const [initial] = state.cards;
    let cardId = null;
    try {
      cardId = await convertCard(initial.messageId);
    } catch (error) {
      logger.warn?.('CardKit placeholder conversion failed; attempting ordinary-card patch', {
        requestId: state.requestId,
        error: error.message,
      });
      if (!fallbackOnConversionError) throw error;
    }
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
      running: true,
      part: 0,
      totalParts: 1,
      processDisplay,
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
              summary: { content: terminalChatListSummary(state) },
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
      summary: terminal ? terminalChatListSummary(state) : null,
      progress: state.progress,
      publicReasoning: state.publicReasoning,
      streaming: !terminal,
      running: !terminal && part === totalParts - 1,
      part,
      totalParts,
      processDisplay,
    });
    const messageId = await sendInteractive(
      client,
      state.target,
      card,
      stableToken(state.requestId, `part:${part}`),
    );
    let cardId = null;
    try {
      cardId = await convertCard(messageId);
    } catch (error) {
      logger.warn?.('CardKit conversion failed for continuation; using ordinary cards', {
        requestId: state.requestId,
        part,
        error: error.message,
      });
    }
    const cardState = {
      part,
      messageId,
      cardId,
      nextSequence: 1,
      closed: terminal,
      rendered: card,
    };
    if (!cardId) {
      if (state.mode === 'cardkit') {
        logger.warn?.('CardKit conversion unavailable for continuation; using ordinary cards', {
          requestId: state.requestId,
          part,
        });
        state.mode = 'ordinary_card';
      }
      await patchOrdinary(messageId, card);
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
          : failureAnswer(state.phase);
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
        summary: terminal ? terminalChatListSummary(state) : null,
        progress: state.progress,
        publicReasoning: state.publicReasoning,
        streaming: state.mode === 'cardkit' && !terminal && part === segments.length - 1,
        running: !terminal && part === segments.length - 1,
        part,
        totalParts: segments.length,
        processDisplay,
      });
      if (JSON.stringify(cardState.rendered) !== JSON.stringify(card)) {
        await updateCard(state, cardState, card, purpose);
      }
      if (terminal || part < segments.length - 1) {
        await closeCard(state, cardState, `${purpose}:close`);
      }
    }
    if (terminal && state.status === 'failed' && state.cards.length > segments.length) {
      for (let part = segments.length; part < state.cards.length; part += 1) {
        const cardState = state.cards[part];
        const card = renderCard({
          phase: state.phase,
          answer: '',
          summary: terminalChatListSummary(state),
          streaming: false,
          running: false,
          part,
          totalParts: state.cards.length,
          processDisplay,
        });
        if (JSON.stringify(cardState.rendered) !== JSON.stringify(card)) {
          await updateCard(state, cardState, card, `${purpose}:invalidate-extra`);
        }
        await closeCard(state, cardState, `${purpose}:close-extra`);
      }
    }
    state.lastRenderedAt = clock();
  }

  async function terminalCompatibility(requestId, output, status, phase) {
    const state = load(requestId);
    if (!state) return { handled: false, reason: 'stream_not_found' };
    if (state.mode === 'delivery_pending') await finishOpening(state);
    if (['completed', 'failed'].includes(state.status)) {
      if (state.status === status && terminalOutputMatches(state, output)) {
        return { handled: true, replayed: true, messageId: state.cards[0]?.messageId || state.plainMessageId };
      }
      const error = new Error('conversation response stream already has a different terminal result');
      error.code = 'ASSISTANT_TERMINAL_CONFLICT';
      throw error;
    }
    try {
      await settleInitialCardMode(state, { fallbackOnConversionError: true });
    } catch (error) {
      // The Core completion event is persisted after this compatibility call.
      // Keep the local terminal durable without sending a second card whose
      // relationship to the accepted placeholder is unknown. The reliable
      // event path can still repair the same placeholder later.
      state.output = output;
      state.status = status;
      state.phase = phase;
      clearTransientProcess(state);
      state.compatibilityTerminal = true;
      state.durableOutput = output;
      compactTerminalState(state);
      state.terminalProjectionPending = true;
      save(state);
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
    compactTerminalState(state);
    save(state);
    return { handled: true, messageId: state.cards[0]?.messageId || state.plainMessageId };
  }

  function newOpeningState(requestId, target) {
    return {
      version: 1,
      requestId,
      target,
      mode: 'delivery_pending',
      delivery: {
        kind: 'interactive_placeholder',
        status: 'pending',
        uuid: stableToken(requestId, 'placeholder'),
      },
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

  async function finishOpening(state) {
    const initialCard = renderCard({
      phase: '正在接收消息…',
      answer: '',
      streaming: true,
      part: 0,
      totalParts: 1,
      processDisplay,
    });
    if (state.delivery.kind === 'interactive_placeholder') {
      let messageId;
      try {
        messageId = await sendInteractive(
          client,
          state.target,
          initialCard,
          state.delivery.uuid,
        );
      } catch (error) {
        state.delivery.lastError = error.message;
        save(state);
        if (error.deliveryOutcome !== 'rejected') throw error;
        logger.warn?.('Interactive response placeholder was rejected; using plain text', {
          requestId: state.requestId,
          error: error.message,
        });
        state.delivery = {
          kind: 'plain_placeholder',
          status: 'pending',
          uuid: stableToken(state.requestId, 'plain-placeholder'),
        };
        save(state);
      }
      if (messageId) {
        state.delivery.status = 'sent';
        state.delivery.messageId = messageId;
        delete state.delivery.lastError;
        state.mode = 'conversion_pending';
        state.cards = [{
          part: 0,
          messageId,
          cardId: null,
          nextSequence: 1,
          closed: false,
          rendered: initialCard,
        }];
        save(state);
        try {
          await settleInitialCardMode(state);
        } catch (error) {
          logger.warn?.('CardKit placeholder conversion is pending repair', {
            requestId: state.requestId,
            error: error.message,
          });
        }
        save(state);
        return;
      }
    }

    if (state.delivery.kind === 'plain_placeholder') {
      try {
        const plainMessageId = await sendPlain(
          client,
          state.target,
          '已接收，正在处理…',
          state.delivery.uuid,
        );
        state.delivery.status = 'sent';
        state.delivery.messageId = plainMessageId;
        delete state.delivery.lastError;
        state.plainMessageId = plainMessageId;
        state.mode = 'plain_text';
        save(state);
      } catch (error) {
        state.delivery.lastError = error.message;
        save(state);
        throw error;
      }
    }
  }

  async function finishCompletedPlain(state, output) {
    try {
      const messageId = await sendPlain(
        client,
        state.target,
        output,
        state.delivery.uuid,
      );
      state.plainMessageId = messageId;
      state.delivery.status = 'sent';
      state.delivery.messageId = messageId;
      delete state.delivery.lastError;
      compactTerminalState(state);
      save(state);
      return {
        handled: true,
        replayed: false,
        mode: 'plain_text',
        parts: 1,
        messageId,
      };
    } catch (error) {
      state.delivery.lastError = error.message;
      save(state);
      error.deliveredParts = 0;
      throw error;
    }
  }

  function normalizeCompletedRequest(input) {
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
    if (output.trim() === '') {
      const error = new Error('completed response output is blank');
      error.code = 'MISSING_OUTPUT';
      throw error;
    }
    return { requestId, target, output };
  }

  function assertCompletedStateIdentity(state, { target, output }) {
    if (state.status !== 'completed'
      || !terminalOutputMatches(state, output)
      || JSON.stringify(state.target) !== JSON.stringify(target)) {
      const error = new Error('completed response requestId already owns different content');
      error.code = 'ASSISTANT_TERMINAL_CONFLICT';
      throw error;
    }
  }

  function completedReplay(state) {
    return {
      handled: true,
      replayed: true,
      parts: state.cards.length || 1,
      messageId: state.cards[0]?.messageId || state.plainMessageId,
    };
  }

  async function finishCompletedCards(state, output) {
    const segments = splitUtf8(output, answerBytesPerCard);
    try {
      for (let part = state.cards.length; part < segments.length; part += 1) {
        const card = renderCard({
          phase: state.phase,
          answer: segments[part],
          summary: completedChatListSummary(output),
          streaming: false,
          part,
          totalParts: segments.length,
          processDisplay,
        });
        state.delivery.part = part;
        state.delivery.uuid = stableToken(state.requestId, `completed:${part}`);
        delete state.delivery.lastError;
        save(state);
        const messageId = await sendInteractive(
          client,
          state.target,
          card,
          state.delivery.uuid,
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
      state.delivery.lastError = error.message;
      save(state);
      error.deliveredParts = state.cards.length;
      if (error.deliveryOutcome === 'rejected' && state.cards.length === 0) {
        logger.warn?.('Completed response card was rejected; using one idempotent plain fallback', {
          requestId: state.requestId,
          error: error.message,
        });
        state.mode = 'plain_text';
        state.delivery = {
          kind: 'completed_plain',
          status: 'pending',
          uuid: stableToken(state.requestId, 'completed-plain'),
        };
        save(state);
        return finishCompletedPlain(state, output);
      }
      throw error;
    }
    state.delivery.status = 'sent';
    delete state.delivery.part;
    delete state.delivery.uuid;
    delete state.delivery.lastError;
    compactTerminalState(state);
    save(state);
    return {
      handled: true,
      replayed: false,
      parts: state.cards.length,
      messageId: state.cards[0]?.messageId,
    };
  }

  const stream = Object.freeze({
    async sendCompleted(input) {
      const { requestId, target, output } = normalizeCompletedRequest(input);
      const release = await acquireRequestLock(requestId);
      try {
        let state = load(requestId);
        if (state) {
          assertCompletedStateIdentity(state, { target, output });
          if (state.delivery?.status === 'sent') {
            return completedReplay(state);
          }
          if (!state.delivery && (state.cards.length > 0 || state.plainMessageId)) {
            return completedReplay(state);
          }
        }

        if (!state) {
          state = {
            version: 1,
            requestId,
            target,
            mode: 'ordinary_card',
            delivery: { kind: 'completed_cards', status: 'pending' },
            status: 'completed',
            phase: '',
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
          save(state);
        }
        if (state.delivery?.kind === 'completed_plain') {
          return finishCompletedPlain(state, output);
        }
        return finishCompletedCards(state, output);
      } finally {
        release();
      }
    },

    async reconcileCompleted(input) {
      const { requestId, target, output } = normalizeCompletedRequest(input);
      const release = await acquireRequestLock(requestId);
      try {
        const state = load(requestId);
        if (!state) {
          return {
            outcome: 'rejected',
            errorCode: 'FEISHU_DELIVERY_STATE_NOT_FOUND',
            retryable: true,
            messageId: null,
          };
        }
        assertCompletedStateIdentity(state, { target, output });
        if (state.delivery?.status === 'sent'
          || (!state.delivery && (state.cards.length > 0 || state.plainMessageId))) {
          return {
            outcome: 'reconciled',
            messageId: completedReplay(state).messageId,
          };
        }
        if (typeof completedDeliveryReconciler !== 'function') {
          const error = new Error('completed delivery reconciliation is unavailable');
          error.code = 'FEISHU_RECONCILIATION_UNAVAILABLE';
          error.deliveryOutcome = 'unknown';
          throw error;
        }
        const uuid = requireText(state.delivery?.uuid, 'pending completed delivery uuid');
        let result;
        try {
          result = requireRecord(await completedDeliveryReconciler({
            requestId,
            target: structuredClone(state.target),
            outputHash: outputHash(output),
            deliveryKind: state.delivery.kind,
            part: state.delivery.part ?? 0,
            uuid,
          }), 'completed delivery reconciliation result');
        } catch (error) {
          throw deliveryError(error);
        }
        if (result.outcome === 'rejected') {
          return {
            outcome: 'rejected',
            errorCode: requireText(
              result.errorCode,
              'completed delivery reconciliation errorCode',
            ),
            retryable: result.retryable === true,
            messageId: null,
          };
        }
        if (result.outcome !== 'reconciled') {
          const error = new Error('completed delivery reconciliation was inconclusive');
          error.code = 'FEISHU_RECONCILIATION_INCONCLUSIVE';
          error.deliveryOutcome = 'unknown';
          throw error;
        }
        const messageId = requireText(
          result.messageId,
          'completed delivery reconciliation messageId',
        );
        if (state.delivery.kind === 'completed_plain') {
          state.plainMessageId = messageId;
          state.delivery.status = 'sent';
          state.delivery.messageId = messageId;
          delete state.delivery.lastError;
          compactTerminalState(state);
          save(state);
          return { outcome: 'reconciled', messageId };
        }
        if (state.delivery.kind !== 'completed_cards') {
          throw new TypeError('pending completed delivery kind is unsupported');
        }
        const part = state.delivery.part ?? state.cards.length;
        if (part !== state.cards.length) {
          const error = new Error('completed delivery part identity is inconsistent');
          error.code = 'ASSISTANT_TERMINAL_CONFLICT';
          throw error;
        }
        const segments = splitUtf8(output, answerBytesPerCard);
        const card = renderCard({
          phase: state.phase,
          answer: segments[part],
          summary: completedChatListSummary(output),
          streaming: false,
          part,
          totalParts: segments.length,
          processDisplay,
        });
        state.cards.push({
          part,
          messageId,
          cardId: null,
          nextSequence: 1,
          closed: true,
          rendered: card,
        });
        delete state.delivery.lastError;
        save(state);
        const completed = await finishCompletedCards(state, output);
        return {
          outcome: 'reconciled',
          messageId: completed.messageId,
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
          if (existing.mode === 'delivery_pending') {
            await finishOpening(existing);
            return {
              handled: true,
              replayed: false,
              mode: existing.mode,
              messageId: existing.cards[0]?.messageId || existing.plainMessageId,
            };
          }
          return { handled: true, replayed: true, mode: existing.mode, messageId: existing.cards[0]?.messageId || existing.plainMessageId };
        }

        const state = newOpeningState(requestId, target);
        save(state);
        await finishOpening(state);
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
      if (!Array.isArray(request.events)) {
        throw new TypeError('events must be an array');
      }
      const release = await acquireRequestLock(requestId);
      try {
        const state = load(requestId);
        if (!state) return { handled: false, reason: 'stream_not_found' };
        if (state.mode === 'delivery_pending') await finishOpening(state);
        let projectionError = null;
        try {
          await settleInitialCardMode(state, { fallbackOnConversionError: true });
        } catch (error) {
          projectionError = error;
          logger.warn?.('Response placeholder projection is unavailable', {
            requestId,
            error: error.message,
          });
        }
        const events = request.events
          .map(event => validateEvent(event, requestId))
          .sort((left, right) => left.sequence - right.sequence);
        if (
          !projectionError
          && request.events.length === 0
          && state.terminalProjectionPending
          && ['completed', 'failed'].includes(state.status)
        ) {
          state.output = state.durableOutput || '';
          delete state.durableOutput;
          delete state.terminalProjectionPending;
          await render(state, { terminal: true, purpose: 'terminal-repair' });
          compactTerminalState(state);
          save(state);
          return {
            handled: true,
            replayed: false,
            repaired: true,
            status: state.status,
            parts: state.cards.length || 1,
          };
        }
        if (state.terminalTombstone && !state.compatibilityTerminal) {
          if (events.every(event => event.sequence <= state.lastEventSequence)) {
            return { handled: true, replayed: true, status: state.status };
          }
          const receivedSequences = events
            .filter(event => event.sequence > state.lastEventSequence)
            .map(event => event.sequence);
          logger.warn?.('Ignored response event after terminal state', {
            requestId,
            status: state.status,
            lastEventSequence: state.lastEventSequence,
            receivedSequences,
          });
          return {
            handled: true,
            ignored: true,
            reason: 'terminal_state',
            status: state.status,
          };
        }
        const compatibility = state.compatibilityTerminal
          ? { status: state.status, outputHash: state.outputHash, phase: state.phase }
          : null;
        let canonicalStatus = compatibility ? null : state.status;
        let canonicalPhase = compatibility ? state.phase : null;
        let canonicalOutput = compatibility ? (state.durableOutput || '') : null;
        let changed = false;
        let terminal = false;
        let containsDelta = false;
        for (const event of events) {
          if (event.sequence <= state.lastEventSequence) continue;
          // Core sequence spans the whole Run stream while this compatibility
          // projection receives only visible events. Missing sequence numbers
          // therefore mean another consumer owned those events, not data loss.
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
              canonicalPhase = '';
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
            if (event.type === 'RunStarted') {
              state.status = 'started';
              if (!Number.isSafeInteger(state.mainStartedAt)) state.mainStartedAt = clock();
            }
            if (event.type === 'OutputDelta') {
              state.output += event.payload.delta;
              containsDelta = true;
            }
            if (event.type === 'RunCompleted') {
              state.output = event.payload.output;
              state.status = 'completed';
              state.phase = '';
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
          if (event.type === 'RunQueued' && !Number.isSafeInteger(state.queuedAt)) {
            state.queuedAt = clock();
          }
          if (event.type === 'RunStarted') {
            delete state.queuedAt;
            delete state.queuedTimeoutObservedAt;
          }
        }
        if (!compatibility && state.status === 'started' && !Number.isSafeInteger(state.mainStartedAt)) {
          state.mainStartedAt = clock();
          changed = true;
        }
        if (state.status === 'queued' && !Number.isSafeInteger(state.queuedAt)) {
          state.queuedAt = clock();
          changed = true;
        }
        const queuedElapsed = state.status === 'queued'
          ? clock() - state.queuedAt
          : 0;
        const queuedTimedOut = state.status === 'queued' && queuedElapsed >= queuedTimeoutMs;
        if (queuedTimedOut) {
          if (!Number.isSafeInteger(state.queuedTimeoutObservedAt)) {
            state.queuedTimeoutObservedAt = clock();
            logger.warn?.('Queued response stream exceeded its observation window', {
              requestId,
              queuedElapsed,
              queuedTimeoutMs,
            });
          }
          save(state);
          return {
            handled: true,
            pending: true,
            replayed: true,
            status: state.status,
            reason: 'queued_timeout_observed',
          };
        }
        const mainElapsed = state.status === 'started'
          ? clock() - state.mainStartedAt
          : 0;
        const mainTimedOut = state.status === 'started' && mainElapsed >= mainTimeoutMs;
        if (mainTimedOut) {
          logger.warn?.('Main response stream timed out; projecting a retry terminal', {
            requestId,
            mainElapsed,
            mainTimeoutMs,
          });
          state.output = '';
          state.status = 'failed';
          state.phase = MAIN_TIMEOUT_PHASE;
          clearTransientProcess(state);
          state.compatibilityTerminal = true;
          if (projectionError) {
            compactTerminalState(state);
            state.terminalProjectionPending = true;
            save(state);
            return {
              handled: true,
              pending: true,
              replayed: false,
              status: state.status,
              reason: 'main_timeout',
            };
          }
          await render(state, { terminal: true, purpose: 'main-timeout' });
          compactTerminalState(state);
          save(state);
          return {
            handled: true,
            replayed: false,
            status: state.status,
            reason: 'main_timeout',
            parts: state.cards.length || 1,
          };
        }
        if (projectionError) {
          if (terminal) {
            state.durableOutput = state.output || '';
            compactTerminalState(state);
            state.terminalProjectionPending = true;
          }
          save(state);
          return {
            handled: true,
            pending: true,
            replayed: false,
            status: state.status,
          };
        }
        if (!changed) return { handled: true, replayed: true, status: state.status };

        if (compatibility) {
          state.durableOutput = canonicalOutput;
          if (!terminal) {
            save(state);
            return { handled: true, replayed: false, status: compatibility.status };
          }
          const sameTerminal = canonicalStatus === compatibility.status
            && outputHash(canonicalOutput) === compatibility.outputHash;
          state.status = canonicalStatus;
          state.phase = canonicalPhase;
          state.compatibilityTerminal = false;
          delete state.durableOutput;
          if (sameTerminal) {
            delete state.terminalProjectionPending;
            save(state);
            return { handled: true, replayed: false, status: state.status };
          }
          state.output = canonicalOutput;
          delete state.terminalProjectionPending;
          state.terminalTombstone = false;
          delete state.outputHash;
          delete state.terminalAt;
        }

        const elapsed = clock() - state.lastRenderedAt;
        if (!terminal && (containsDelta || state.status === 'started') && elapsed < throttleMs) {
          await pause(throttleMs - elapsed);
        }
        await render(state, { terminal, purpose: `event-${state.lastEventSequence}` });
        if (terminal) compactTerminalState(state);
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

    async sweepExpired() {
      let entries;
      try {
        entries = fs.readdirSync(stateDirectory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return { checked: 0, expired: 0, failed: 0 };
        throw error;
      }

      let checked = 0;
      let expired = 0;
      let failed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const state = readState(path.join(stateDirectory, entry.name));
        if (!state || !['queued', 'started'].includes(state.status)) continue;
        checked += 1;
        try {
          const result = await stream.apply({ requestId: state.requestId, events: [] });
          if (result?.reason === 'queued_timeout' || result?.reason === 'main_timeout') expired += 1;
        } catch (error) {
          failed += 1;
          logger.warn?.('Response stream timeout sweep failed', {
            requestId: state.requestId,
            error: error.message,
          });
        }
      }
      return { checked, expired, failed };
    },

    async completeWithFullAnswer({ requestId, output } = {}) {
      const id = requireText(requestId, 'requestId');
      const visibleOutput = typeof output === 'string' ? output : String(output || '');
      if (visibleOutput.trim() === '') {
        const error = new Error('completed response output is blank');
        error.code = 'MISSING_OUTPUT';
        throw error;
      }
      const release = await acquireRequestLock(id);
      try {
        return await terminalCompatibility(
          id,
          visibleOutput,
          'completed',
          '',
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
  return stream;
}
