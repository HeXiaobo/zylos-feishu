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
const STATUS_CLEANUP_RETRY_MS = 30_000;
const STATUS_CLEANUP_MAX_ATTEMPTS = 5;
const RETRYABLE_FAILURE_PHASE = '⚠️ 回复暂时中断';
const NON_RETRYABLE_FAILURE_PHASE = '⚠️ 回复中断';
const RETRYABLE_FAILURE_ANSWER = '⚠️ 回复暂时中断，消息已记录。';
const NON_RETRYABLE_FAILURE_ANSWER = '⚠️ 回复中断，消息已记录。';
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
    if (!Array.isArray(state.answerCards)) state.answerCards = [];
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

function failureAnswer(phase) {
  return phase === RETRYABLE_FAILURE_PHASE
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
      ? RETRYABLE_FAILURE_PHASE
      : NON_RETRYABLE_FAILURE_PHASE;
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

// Two-card split: the status card streams phase/progress in place and never
// carries the answer; the answer is delivered as new card message(s) at the
// terminal so completion re-notifies the chat list (in-place updates never do).
function statusCardTerminalSummary(state) {
  return state.status === 'completed' ? '已完成' : state.phase;
}

// The delivered answer lives in the answer cards; the status card (or plain
// receipt) is only the fallback identity for legacy/pre-answer states.
function terminalMessageId(state) {
  return state.answerCards?.at(-1)?.messageId
    || state.cards[0]?.messageId
    || state.plainMessageId;
}

function renderStatusCard({
  phase,
  summary,
  progress = [],
  publicReasoning = '',
  streaming,
  running = streaming,
  showPhase = true,
  processDisplay = 'collapsible',
}) {
  const showProcess = processDisplay === 'collapsible'
    && running
    && (publicReasoning || progress.length > 0);
  // The phase renders whenever the process panel does not (the panel header
  // carries the phase). With the answer living in its own cards, this line is
  // the status card's only body content in non-collapsible modes.
  const renderPhase = showPhase && Boolean(phase) && !showProcess;
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
          : (renderPhase ? [{ tag: 'markdown', element_id: PHASE_ELEMENT_ID, content: phase }] : [])),
      ],
    },
  };
  if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES) {
    throw new TypeError('conversation response card exceeds Feishu size limit');
  }
  return card;
}

function renderAnswerCard({ answer, summary, part = 0, totalParts = 1 }) {
  const continuation = part > 0
    ? `\n\n_续 ${part + 1}${totalParts > 1 ? ` / ${totalParts}` : ''}_`
    : '';
  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      streaming_mode: false,
      summary: { content: summary },
    },
    body: {
      elements: [{
        tag: 'markdown',
        element_id: ANSWER_ELEMENT_ID,
        content: `${answer}${continuation}`,
      }],
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
 * message creation, CardKit conversion, coalescing, monotonic sequences, the
 * two-card split (in-place status card + answer delivered as new message(s)
 * so completion re-notifies), restart state, terminal close, and fallback.
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
  // Issue #57: when true, the intake receipt is a plain text message and the
  // final answer is delivered as a separate new plain message, instead of an
  // interactive card updated in place. Both are new messages (so the answer
  // re-notifies and never clears the unread state silently). Accepts a getter
  // so a hot-reloaded config is read at each open rather than at construction.
  preferPlainPlaceholder = false,
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
    // Idempotent: once compacted (output replaced by its hash), a re-close
    // must not recompute the hash from the missing output.
    if (state.terminalTombstone === true && typeof state.output !== 'string') return;
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
    for (const card of state.answerCards || []) delete card.rendered;
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
    const ordinary = renderStatusCard({
      phase: state.phase,
      progress: state.progress,
      publicReasoning: state.publicReasoning,
      streaming: false,
      running: true,
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
              summary: { content: statusCardTerminalSummary(state) },
            },
          }),
          sequence,
          uuid: stableToken(state.requestId, `${purpose}:${cardState.part}:${sequence}`),
        },
      }), 'Feishu response card close');
    }
    cardState.closed = true;
  }

  // Terminal answer delivery for the two-card split. The answer always
  // arrives as NEW message(s) — card messages for completed answers, one
  // plain message for failures — because only new messages re-notify the
  // chat list. Idempotent three ways: per-part Feishu uuid dedupe, the
  // per-part answerCards entries persisted before the next send, and the
  // terminal fingerprint that short-circuits fully delivered results.
  async function deliverTerminalAnswer(state) {
    const fingerprint = createHash('sha256')
      .update(`${state.status}\0${state.output || ''}`)
      .digest('hex')
      .slice(0, 20);
    if (state.finalAnswerFingerprint === fingerprint) return;
    if (!Array.isArray(state.answerCards)) state.answerCards = [];
    try {
      if (state.status === 'failed') {
        const messageId = await sendPlain(
          client,
          state.target,
          failureAnswer(state.phase),
          stableToken(state.requestId, `final-answer-plain:${fingerprint}`),
        );
        // part -1: the failure notice is not an answer segment, so a later
        // canonical correction (failed → completed) still delivers part 0.
        state.answerCards.push({ part: -1, messageId, cardId: null, closed: true, rendered: null });
      } else {
        const segments = splitUtf8(state.output || '', answerBytesPerCard);
        const summary = completedChatListSummary(state.output || '');
        for (let part = 0; part < segments.length; part += 1) {
          if (state.answerCards.some(entry => entry.part === part)) continue;
          const card = renderAnswerCard({
            answer: segments[part],
            summary,
            part,
            totalParts: segments.length,
          });
          let answerMessageId;
          try {
            answerMessageId = await sendInteractive(
              client,
              state.target,
              card,
              stableToken(state.requestId, `final-answer:${part}`),
            );
            state.answerCards.push({ part, messageId: answerMessageId, cardId: null, closed: true, rendered: card });
          } catch (error) {
            if (error.deliveryOutcome !== 'rejected') throw error;
            // A deterministic card rejection (e.g. invalid card) would loop
            // forever on retry — degrade that segment to a plain message.
            logger.warn?.('Final answer card was rejected; delivering the segment as plain text', {
              requestId: state.requestId,
              part,
              error: error.message,
            });
            answerMessageId = await sendPlain(
              client,
              state.target,
              segments[part],
              stableToken(state.requestId, `final-answer-plain:${fingerprint}:${part}`),
            );
            state.answerCards.push({ part, messageId: answerMessageId, cardId: null, closed: true, rendered: null, plain: true });
          }
          save(state);
        }
      }
      state.finalAnswerFingerprint = fingerprint;
    } finally {
      save(state);
    }
  }

  // Recall only this request's temporary receipt, after every answer segment
  // is acknowledged. Cleanup has its own durable retry state: it must never
  // turn a delivered answer into a failed/repeated delivery.
  async function cleanupSuccessfulStatus(state, { initialize = false } = {}) {
    if (state.status !== 'completed') return;
    const messageId = state.cards[0]?.messageId || state.plainMessageId;
    if (!messageId) return;
    if (!state.statusCleanup && initialize) {
      state.statusCleanup = { status: 'pending', messageId, attempts: 0, retryAt: 0 };
      save(state);
    }
    const cleanup = state.statusCleanup;
    if (!cleanup || cleanup.status !== 'pending' || cleanup.retryAt > clock()) return;
    // Persist the attempt before the API call, including a backoff in case
    // the process dies after Feishu accepts the recall but before we save.
    if (cleanup.attempts >= STATUS_CLEANUP_MAX_ATTEMPTS) {
      cleanup.status = 'abandoned';
      save(state);
      return;
    }
    cleanup.attempts += 1;
    cleanup.retryAt = clock() + STATUS_CLEANUP_RETRY_MS;
    save(state);
    try {
      const result = await client.im.message.delete({ path: { message_id: cleanup.messageId } });
      // A previous attempt may have succeeded before a connection/process loss.
      if (result?.code !== 230011) requireSuccess(result, 'Feishu temporary status recall');
      cleanup.status = 'recalled';
      delete cleanup.lastError;
    } catch (error) {
      if (error?.response?.data?.code === 230011 || error?.code === 230011) {
        cleanup.status = 'recalled';
        delete cleanup.lastError;
      } else {
        cleanup.lastError = error.message;
        if (cleanup.attempts >= STATUS_CLEANUP_MAX_ATTEMPTS) cleanup.status = 'abandoned';
        logger.warn?.('Temporary response status cleanup failed; final answer remains delivered', {
          requestId: state.requestId,
          messageId: cleanup.messageId,
          attempts: cleanup.attempts,
          error: error.message,
        });
      }
    }
    save(state);
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

    // Two-card split: the single status card carries phase/progress only.
    // The answer is never rendered here — deliverTerminalAnswer sends it as
    // new message(s) at the terminal so the chat list re-notifies.
    const [cardState] = state.cards;
    if (cardState && state.statusCleanup?.status !== 'recalled') {
      const card = renderStatusCard({
        phase: terminal && state.status === 'completed' ? '✅ 已完成' : state.phase,
        summary: terminal ? statusCardTerminalSummary(state) : null,
        progress: state.progress,
        publicReasoning: state.publicReasoning,
        streaming: state.mode === 'cardkit' && !terminal,
        running: !terminal,
        processDisplay,
      });
      if (JSON.stringify(cardState.rendered) !== JSON.stringify(card)) {
        await updateCard(state, cardState, card, purpose);
      }
    }
    if (terminal) {
      if (cardState) await closeCard(state, cardState, `${purpose}:close`);
      await deliverTerminalAnswer(state);
    }
    state.lastRenderedAt = clock();
  }

  // Terminal renders must survive a mid-delivery crash: the pending flag is
  // persisted BEFORE rendering, so a later apply() can resume the close +
  // final-answer delivery idempotently instead of silently skipping it.
  async function renderTerminal(state, purpose) {
    state.terminalRenderPending = true;
    save(state);
    await render(state, { terminal: true, purpose });
    await cleanupSuccessfulStatus(state, { initialize: true });
    delete state.terminalRenderPending;
  }

  async function terminalCompatibility(requestId, output, status, phase) {
    const state = load(requestId);
    if (!state) return { handled: false, reason: 'stream_not_found' };
    if (state.mode === 'delivery_pending') await finishOpening(state);
    if (['completed', 'failed'].includes(state.status)) {
      if (state.status === status && terminalOutputMatches(state, output)) {
        await cleanupSuccessfulStatus(state);
        return { handled: true, replayed: true, messageId: terminalMessageId(state) };
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
        messageId: terminalMessageId(state),
      };
    }
    state.output = output;
    state.status = status;
    state.phase = phase;
    clearTransientProcess(state);
    state.compatibilityTerminal = true;
    await renderTerminal(state, 'compatibility-terminal');
    compactTerminalState(state);
    save(state);
    return { handled: true, messageId: terminalMessageId(state) };
  }

  function prefersPlainPlaceholder() {
    return typeof preferPlainPlaceholder === 'function'
      ? preferPlainPlaceholder() === true
      : preferPlainPlaceholder === true;
  }

  function newOpeningState(requestId, target, initialPhase = '正在接收消息…') {
    return {
      version: 1,
      requestId,
      target,
      mode: 'delivery_pending',
      delivery: prefersPlainPlaceholder()
        ? {
          kind: 'plain_placeholder',
          status: 'pending',
          uuid: stableToken(requestId, 'plain-placeholder'),
        }
        : {
          kind: 'interactive_placeholder',
          status: 'pending',
          uuid: stableToken(requestId, 'placeholder'),
        },
      status: 'opening',
      phase: initialPhase,
      progress: [],
      publicReasoning: '',
      output: '',
      lastEventSequence: 0,
      lastRenderedAt: clock(),
      compatibilityTerminal: false,
      plainTerminalSent: false,
      plainTerminalFingerprint: null,
      finalAnswerFingerprint: null,
      answerCards: [],
      cards: [],
    };
  }

  async function finishOpening(state) {
    const initialCard = renderStatusCard({
      phase: state.phase || '正在接收消息…',
      streaming: true,
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
      parts: state.answerCards?.length || state.cards.length || 1,
      messageId: terminalMessageId(state),
    };
  }

  async function finishCompletedCards(state, output) {
    const segments = splitUtf8(output, answerBytesPerCard);
    if (!Array.isArray(state.answerCards)) state.answerCards = [];
    try {
      for (let part = 0; part < segments.length; part += 1) {
        if (state.answerCards.some(entry => entry.part === part)) continue;
        const card = renderAnswerCard({
          answer: segments[part],
          summary: completedChatListSummary(output),
          part,
          totalParts: segments.length,
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
        state.answerCards.push({
          part,
          messageId,
          cardId: null,
          closed: true,
          rendered: card,
        });
        save(state);
      }
    } catch (error) {
      state.delivery.lastError = error.message;
      save(state);
      error.deliveredParts = state.answerCards.length;
      if (error.deliveryOutcome === 'rejected' && state.answerCards.length === 0) {
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
      parts: state.answerCards.length,
      messageId: terminalMessageId(state),
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
          if (state.delivery?.status === 'sent' && !state.terminalRenderPending) {
            return completedReplay(state);
          }
          if (!state.delivery && (state.cards.length > 0 || state.answerCards.length > 0 || state.plainMessageId)) {
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
            finalAnswerFingerprint: null,
            answerCards: [],
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
        if (!Array.isArray(state.answerCards)) state.answerCards = [];
        const part = state.delivery.part ?? state.answerCards.length;
        if (part !== state.answerCards.length) {
          const error = new Error('completed delivery part identity is inconsistent');
          error.code = 'ASSISTANT_TERMINAL_CONFLICT';
          throw error;
        }
        const segments = splitUtf8(output, answerBytesPerCard);
        const card = renderAnswerCard({
          answer: segments[part],
          summary: completedChatListSummary(output),
          part,
          totalParts: segments.length,
        });
        state.answerCards.push({
          part,
          messageId,
          cardId: null,
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
      const requestId = requireText(input.requestId, 'requestId');
      const target = normalizeTarget(input.target);
      const initialPhase = input.initialPhase === undefined || input.initialPhase === null
        ? '正在接收消息…'
        : requireText(input.initialPhase, 'initialPhase');
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

        const state = newOpeningState(requestId, target, initialPhase);
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
          await renderTerminal(state, 'terminal-repair');
          compactTerminalState(state);
          save(state);
          return {
            handled: true,
            replayed: false,
            repaired: true,
            status: state.status,
            parts: state.answerCards.length || state.cards.length || 1,
          };
        }
        await cleanupSuccessfulStatus(state);
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
          if (!Number.isSafeInteger(state.mainTimeoutObservedAt)) {
            state.mainTimeoutObservedAt = clock();
            logger.warn?.('Main response stream exceeded its observation window', {
              requestId,
              mainElapsed,
              mainTimeoutMs,
            });
          }
          save(state);
          return {
            handled: true,
            pending: true,
            replayed: true,
            status: state.status,
            reason: 'main_timeout_observed',
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
        if (!changed) {
          // A previous terminal render may have crashed mid-delivery (the
          // pending flag is persisted before rendering). Resume the close +
          // final-answer delivery; both are idempotent.
          if (state.terminalRenderPending === true
            && ['completed', 'failed'].includes(state.status)) {
            await renderTerminal(state, 'terminal-resume');
            compactTerminalState(state);
            save(state);
            return {
              handled: true,
              replayed: false,
              resumed: true,
              status: state.status,
              parts: state.answerCards.length || state.cards.length || 1,
            };
          }
          return { handled: true, replayed: true, status: state.status };
        }

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
        if (terminal) {
          await renderTerminal(state, `event-${state.lastEventSequence}`);
        } else {
          await render(state, { terminal, purpose: `event-${state.lastEventSequence}` });
        }
        if (terminal) compactTerminalState(state);
        save(state);
        return {
          handled: true,
          replayed: false,
          status: state.status,
          parts: terminal
            ? (state.answerCards.length || state.cards.length || 1)
            : (state.cards.length || 1),
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
        if (error?.code === 'ENOENT') {
          return { checked: 0, expired: 0, failed: 0, presenceCompletionRequestIds: [] };
        }
        throw error;
      }

      let checked = 0;
      let expired = 0;
      let failed = 0;
      const presenceCompletionRequestIds = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const state = readState(path.join(stateDirectory, entry.name));
        if (!state) continue;
        if (state.presenceCompletionPending === true) {
          presenceCompletionRequestIds.push(state.requestId);
        }
        if (!['queued', 'started'].includes(state.status)
          && !(state.status === 'completed' && state.statusCleanup?.status === 'pending'
            && state.statusCleanup.retryAt <= clock())) continue;
        checked += 1;
        try {
          const result = await stream.apply({ requestId: state.requestId, events: [] });
          if (
            result?.reason === 'queued_timeout_observed'
            || result?.reason === 'main_timeout_observed'
          ) expired += 1;
        } catch (error) {
          failed += 1;
          logger.warn?.('Response stream timeout sweep failed', {
            requestId: state.requestId,
            error: error.message,
          });
        }
      }
      return {
        checked,
        expired,
        failed,
        presenceCompletionRequestIds: [...new Set(presenceCompletionRequestIds)].sort(),
      };
    },

    async acknowledgePresenceCompletion(requestId) {
      const id = requireText(requestId, 'requestId');
      const release = await acquireRequestLock(id);
      try {
        const state = load(id);
        if (!state?.presenceCompletionPending) return false;
        delete state.presenceCompletionPending;
        save(state);
        return true;
      } finally {
        release();
      }
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
          retryable ? RETRYABLE_FAILURE_PHASE : NON_RETRYABLE_FAILURE_PHASE,
        );
      } finally {
        release();
      }
    },
  });
  return stream;
}
