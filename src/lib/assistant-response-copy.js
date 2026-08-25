import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

const ACTION = 'assistant_response_copy';
const OPTION_FIELDS = Object.freeze(['stateDirectory', 'sendText', 'maxChunkCharacters']);
const DEFAULT_MAX_CHUNK_CHARACTERS = 1_800;

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

function statePath(directory, requestId) {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return path.join(directory, `${digest}.json`);
}

function normalizeEvent(input) {
  const raw = requireRecord(input, 'Feishu assistant copy event');
  const event = raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event)
    ? raw.event
    : raw;
  const isV2 = Object.hasOwn(event, 'operator') || Object.hasOwn(event, 'context');
  const messageId = requireText(
    isV2 ? event.context?.open_message_id : event.open_message_id,
    'Feishu assistant copy message ID',
  );
  const chatId = isV2
    ? requireText(event.context?.open_chat_id, 'Feishu assistant copy chat ID')
    : null;
  const actorId = requireText(
    isV2 ? event.operator?.open_id : event.open_id,
    'Feishu assistant copy operator open ID',
  );
  const action = requireRecord(event.action, 'Feishu assistant copy action');
  if (action.tag !== 'button') throw new TypeError('Feishu assistant copy action must be a button');
  const value = requireRecord(action.value, 'Feishu assistant copy action value');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'action' || keys[1] !== 'requestId') {
    throw new TypeError('Feishu assistant copy action contains unsupported fields');
  }
  if (value.action !== ACTION) throw new TypeError('Feishu assistant copy action is unsupported');
  return {
    messageId,
    chatId,
    actorId,
    requestId: requireText(value.requestId, 'Feishu assistant copy request ID'),
  };
}

function splitExact(text, maxCharacters) {
  const characters = Array.from(text);
  const chunks = [];
  for (let index = 0; index < characters.length; index += maxCharacters) {
    chunks.push(characters.slice(index, index + maxCharacters).join(''));
  }
  return chunks.length > 0 ? chunks : [''];
}

export function isAssistantResponseCopyAction(input) {
  const event = input?.event && typeof input.event === 'object' ? input.event : input;
  return event?.action?.tag === 'button' && event.action?.value?.action === ACTION;
}

export function createAssistantResponseCopyRuntime({
  stateDirectory = path.join(DATA_DIR, 'conversation-response-streams'),
  sendText,
  maxChunkCharacters = DEFAULT_MAX_CHUNK_CHARACTERS,
} = {}) {
  if (typeof stateDirectory !== 'string' || stateDirectory.trim() === '') {
    throw new TypeError('stateDirectory must be a non-empty string');
  }
  if (typeof sendText !== 'function') throw new TypeError('sendText must be a function');
  if (!Number.isSafeInteger(maxChunkCharacters) || maxChunkCharacters < 256) {
    throw new TypeError('maxChunkCharacters is invalid');
  }

  return Object.freeze({
    async handle(input) {
      const action = normalizeEvent(input);
      let state;
      try {
        state = JSON.parse(fs.readFileSync(statePath(stateDirectory, action.requestId), 'utf8'));
      } catch {
        throw new Error('assistant response is no longer available for copying');
      }
      if (state?.status !== 'completed' || typeof state.output !== 'string') {
        throw new Error('assistant response is not complete');
      }
      if (action.chatId && state.target?.chatId !== action.chatId) {
        throw new Error('assistant response does not belong to this chat');
      }
      if (!Array.isArray(state.cards)
        || !state.cards.some(card => card?.messageId === action.messageId)) {
        throw new Error('assistant response does not own the clicked card');
      }

      const chunks = splitExact(state.output, maxChunkCharacters);
      for (let index = 0; index < chunks.length; index += 1) {
        const uuid = `zac_${createHash('sha256')
          .update(`${action.requestId}:${action.messageId}:${action.actorId}:${index}`)
          .digest('hex')
          .slice(0, 40)}`;
        const result = await sendText({
          target: state.target,
          messageId: action.messageId,
          text: chunks[index],
          uuid,
        });
        if (!result?.success) throw new Error(result?.message || 'copy text delivery failed');
      }
      return {
        kind: 'assistant-response-copy',
        chunks: chunks.length,
        toast: { type: 'success', content: '已发送可复制文本' },
      };
    },
  });
}
