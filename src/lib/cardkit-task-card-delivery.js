import { createHash } from 'node:crypto';

const ELEMENT_ID = 'zylos_task_progress';
const DEFAULT_PHASE_DELAY_MS = 450;
const MAX_CARDKIT_SEQUENCE = 2_147_483_647;
const MAX_ID_LENGTH = 512;
const MAX_CARD_BYTES = 30_000;
const RECEIVE_ID_TYPES = new Set(['chat_id', 'open_id', 'user_id', 'union_id']);
const OPTION_FIELDS = new Set(['client', 'pause', 'logger']);
const SEND_FIELDS = Object.freeze(['target', 'card', 'idempotencyKey', 'taskVersion']);
const TARGET_FIELDS = Object.freeze(['receiveId', 'receiveIdType']);
const PROGRESS = Object.freeze([
  '⏳ 正在创建飞书任务卡…',
  '⏳ 正在创建飞书任务卡…\n\n✅ 任务已登记到 Zylos Core',
  '⏳ 正在创建飞书任务卡…\n\n✅ 任务已登记到 Zylos Core\n\n✅ 飞书任务卡已就绪',
]);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field, maxLength = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return value;
}

function stableFeishuUuid(idempotencyKey) {
  const key = requireText(idempotencyKey, 'idempotencyKey');
  return `ztc_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

function normalizeTarget(value) {
  const target = requireRecord(value, 'target');
  requireExactFields(target, TARGET_FIELDS, 'target');
  const receiveId = requireText(target.receiveId, 'target.receiveId');
  if (!RECEIVE_ID_TYPES.has(target.receiveIdType)) {
    throw new TypeError('target.receiveIdType is unsupported');
  }
  return { receiveId, receiveIdType: target.receiveIdType };
}

function cardSequence(taskVersion, offset) {
  if (
    !Number.isSafeInteger(taskVersion)
    || taskVersion < 1
    || taskVersion > Math.floor((MAX_CARDKIT_SEQUENCE - offset) / 10)
  ) {
    throw new TypeError('taskVersion cannot produce a positive 32-bit CardKit sequence');
  }
  return taskVersion * 10 + offset;
}

function requireFeishuSuccess(response, operation) {
  if (response?.code !== 0) {
    const error = new Error(response?.msg || `${operation} failed`);
    error.code = response?.code;
    throw error;
  }
  return response;
}

function createStreamingCard() {
  const streamingCard = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
      streaming_mode: true,
      summary: { content: 'Zylos 正在创建任务卡…' },
      streaming_config: {
        print_frequency_ms: { default: 45 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: ELEMENT_ID, content: PROGRESS[0] },
      ],
    },
  };
  if (Buffer.byteLength(JSON.stringify(streamingCard), 'utf8') > MAX_CARD_BYTES) {
    throw new TypeError('streaming task card exceeds the size limit');
  }
  return streamingCard;
}

function defaultPause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function patchOrdinaryCard(client, messageId, card) {
  requireFeishuSuccess(
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }),
    'Feishu fallback task card patch',
  );
  return { success: true, messageId };
}

/**
 * Create the Feishu-owned delivery Adapter for native CardKit task-card
 * streaming. The caller supplies one canonical task card; this Module owns
 * the stable placeholder, Card Entity resolution, native typewriter updates,
 * monotonic sequencing, terminal close, and ordinary-card fallback.
 */
export function createCardKitTaskCardDelivery(input) {
  const options = requireRecord(input, 'CardKit task card delivery options');
  if (Object.keys(options).some(key => !OPTION_FIELDS.has(key))) {
    throw new TypeError('CardKit task card delivery options contain unsupported fields');
  }
  const client = requireRecord(options.client, 'client');
  const pause = options.pause ?? defaultPause;
  if (typeof pause !== 'function') {
    throw new TypeError('pause must be a function');
  }
  const logger = options.logger ?? console;
  if (!logger || typeof logger.warn !== 'function') {
    throw new TypeError('logger.warn must be a function');
  }

  return Object.freeze({
    async send(input) {
      const request = requireRecord(input, 'task card delivery request');
      requireExactFields(request, SEND_FIELDS, 'task card delivery request');
      const target = normalizeTarget(request.target);
      const card = requireRecord(request.card, 'card');
      cardSequence(request.taskVersion, 4);
      const uuid = stableFeishuUuid(request.idempotencyKey);
      const streamingCard = createStreamingCard();

      const sent = requireFeishuSuccess(await client.im.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: {
          receive_id: target.receiveId,
          msg_type: 'interactive',
          content: JSON.stringify(streamingCard),
          uuid,
        },
      }), 'Feishu task card placeholder send');
      const messageId = requireText(sent.data?.message_id, 'Feishu task card messageId');
      let converted = null;
      try {
        converted = await client.cardkit.v1.card.idConvert({
          data: { message_id: messageId },
        });
      } catch (error) {
        logger.warn(
          'Feishu CardKit conversion failed; falling back to an ordinary card',
          { error: error.message },
        );
      }
      if (converted?.code !== 0 || typeof converted.data?.card_id !== 'string') {
        logger.warn(
          'Feishu CardKit conversion unavailable; falling back to an ordinary card',
          { code: converted?.code, message: converted?.msg },
        );
        return patchOrdinaryCard(client, messageId, card);
      }
      const cardId = requireText(converted.data.card_id, 'Feishu CardKit cardId');

      try {
        for (const [index, content] of PROGRESS.slice(1).entries()) {
          await pause(DEFAULT_PHASE_DELAY_MS);
          requireFeishuSuccess(
            await client.cardkit.v1.cardElement.content({
              path: { card_id: cardId, element_id: ELEMENT_ID },
              data: {
                content,
                sequence: cardSequence(request.taskVersion, index + 1),
                uuid: `${uuid}_p${index + 1}`,
              },
            }),
            'Feishu task card stream update',
          );
        }
      } catch (error) {
        logger.warn('Feishu task card stream update failed after send; finalizing in place', error);
      }

      let terminalError = null;
      try {
        await pause(DEFAULT_PHASE_DELAY_MS);
        requireFeishuSuccess(
          await client.cardkit.v1.card.update({
            path: { card_id: cardId },
            data: {
              card: { type: 'card_json', data: JSON.stringify(card) },
              sequence: cardSequence(request.taskVersion, 3),
              uuid: `${uuid}_final`,
            },
          }),
          'Feishu task card final update',
        );
      } catch (error) {
        terminalError = error;
        logger.warn('Feishu task card final update failed after send', error);
      }

      if (!terminalError) {
        try {
          requireFeishuSuccess(
            await client.cardkit.v1.card.settings({
              path: { card_id: cardId },
              data: {
                settings: JSON.stringify({
                  config: {
                    streaming_mode: false,
                    summary: { content: 'Zylos 任务卡已就绪' },
                  },
                }),
                sequence: cardSequence(request.taskVersion, 4),
                uuid: `${uuid}_finish`,
              },
            }),
            'Feishu task card stream finish',
          );
        } catch (error) {
          terminalError = error;
          logger.warn('Feishu task card stream finish failed after send', error);
        }
      }

      if (terminalError) {
        logger.warn('Feishu task card finalization failed; falling back to an ordinary card', terminalError);
        try {
          return await patchOrdinaryCard(client, messageId, card);
        } catch (fallbackError) {
          terminalError.cause = fallbackError;
          throw terminalError;
        }
      }
      return { success: true, messageId };
    },
  });
}
