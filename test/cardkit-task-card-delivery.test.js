import assert from 'node:assert/strict';
import test from 'node:test';

import { createCardKitTaskCardDelivery } from '../src/lib/cardkit-task-card-delivery.js';

const FINAL_CARD = Object.freeze({
  schema: '2.0',
  config: Object.freeze({ update_multi: true, width_mode: 'fill' }),
  header: Object.freeze({
    template: 'blue',
    title: Object.freeze({ tag: 'plain_text', content: '任务待开始' }),
  }),
  body: Object.freeze({
    elements: Object.freeze([
      Object.freeze({
        tag: 'div',
        text: Object.freeze({ tag: 'plain_text', content: '任务：测试任务' }),
      }),
    ]),
  }),
});

test('creates one CardKit entity, streams append-only progress, and finalizes the same card', async () => {
  const calls = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          calls.push(['send', payload]);
          return { code: 0, data: { message_id: 'om_streamed_task' } };
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert(payload) {
            calls.push(['id-convert', payload]);
            return { code: 0, data: { card_id: 'AA-streamed-task' } };
          },
          async update(payload) {
            calls.push(['final-card', payload]);
            return { code: 0, data: {} };
          },
          async settings(payload) {
            calls.push(['finish', payload]);
            return { code: 0, data: {} };
          },
        },
        cardElement: {
          async content(payload) {
            calls.push(['progress', payload]);
            return { code: 0, data: {} };
          },
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
  });

  const result = await delivery.send({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    card: FINAL_CARD,
    idempotencyKey: 'feishu:create:task-streamed-1',
    taskVersion: 1,
  });

  assert.deepEqual(result, { success: true, messageId: 'om_streamed_task' });
  assert.deepEqual(calls.map(([name]) => name), [
    'send',
    'id-convert',
    'progress',
    'progress',
    'final-card',
    'finish',
  ]);

  const initial = JSON.parse(calls[0][1].data.content);
  assert.equal(initial.config.streaming_mode, true);
  assert.equal(initial.config.update_multi, true);
  assert.equal(initial.body.elements[0].tag, 'markdown');
  assert.equal(initial.body.elements[0].element_id, 'zylos_task_progress');
  assert.ok(
    initial.body.elements[0].element_id.length <= 20,
    'Feishu CardKit element_id must not exceed 20 characters',
  );

  assert.equal(calls[0][1].params.receive_id_type, 'open_id');
  assert.equal(calls[0][1].data.receive_id, 'ou_acceptor');
  assert.equal(calls[0][1].data.msg_type, 'interactive');
  assert.match(calls[0][1].data.uuid, /^ztc_[a-f0-9]{40}$/);
  assert.deepEqual(calls[1][1], { data: { message_id: 'om_streamed_task' } });

  const progress = calls
    .filter(([name]) => name === 'progress')
    .map(([, payload]) => payload);
  assert.deepEqual(progress.map(item => item.data.sequence), [11, 12]);
  assert.equal(progress[1].data.content.startsWith(progress[0].data.content), true);
  assert.deepEqual(progress.map(item => item.path), [
    { card_id: 'AA-streamed-task', element_id: 'zylos_task_progress' },
    { card_id: 'AA-streamed-task', element_id: 'zylos_task_progress' },
  ]);

  assert.equal(calls[4][1].data.sequence, 13);
  assert.deepEqual(JSON.parse(calls[4][1].data.card.data), FINAL_CARD);
  assert.equal(calls[5][1].data.sequence, 14);
  assert.deepEqual(JSON.parse(calls[5][1].data.settings), {
    config: {
      streaming_mode: false,
      summary: { content: 'Zylos 任务卡已就绪' },
    },
  });
});

test('patches the placeholder to an ordinary card when CardKit conversion is unavailable', async () => {
  const sends = [];
  const patches = [];
  const warnings = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          sends.push(payload);
          return { code: 0, data: { message_id: 'om_fallback_task' } };
        },
      },
      v1: {
        message: {
          async patch(payload) {
            patches.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            return { code: 230001, msg: 'CardKit permission unavailable' };
          },
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });

  const result = await delivery.send({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    card: FINAL_CARD,
    idempotencyKey: 'feishu:create:task-fallback-1',
    taskVersion: 1,
  });

  assert.deepEqual(result, { success: true, messageId: 'om_fallback_task' });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].data.msg_type, 'interactive');
  assert.equal(JSON.parse(sends[0].data.content).config.streaming_mode, true);
  assert.match(sends[0].data.uuid, /^ztc_[a-f0-9]{40}$/);
  assert.deepEqual(patches, [{
    path: { message_id: 'om_fallback_task' },
    data: { content: JSON.stringify(FINAL_CARD) },
  }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /falling back to an ordinary card/);
});

test('patches a nested mixed card when CardKit conversion throws', async () => {
  const patches = [];
  const nestedCard = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    body: {
      elements: [{
        tag: 'column_set',
        columns: [{
          tag: 'column',
          elements: [{
            tag: 'column_set',
            columns: [{
              tag: 'column',
              elements: [
                { tag: 'markdown', content: '深层文本' },
                { tag: 'img', img_key: 'img_nested' },
                { tag: 'file', file_key: 'file_nested', name: 'report.pdf' },
                { tag: 'table', columns: [{ name: '状态' }], rows: [{ cells: [{ text: '完成' }] }] },
              ],
            }],
          }],
        }],
      }],
    },
  };
  const client = {
    im: {
      message: {
        async create() {
          return { code: 0, data: { message_id: 'om_deep_conversion_failure' } };
        },
      },
      v1: {
        message: {
          async patch(payload) {
            patches.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            throw new Error('nested card conversion failed');
          },
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
    logger: { warn() {} },
  });

  const result = await delivery.send({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    card: nestedCard,
    idempotencyKey: 'feishu:create:task-deep-conversion-failure',
    taskVersion: 1,
  });

  assert.deepEqual(result, { success: true, messageId: 'om_deep_conversion_failure' });
  assert.deepEqual(patches, [{
    path: { message_id: 'om_deep_conversion_failure' },
    data: { content: JSON.stringify(nestedCard) },
  }]);
});

test('never sends a duplicate after the native card message exists, even if streaming fails', async () => {
  const sends = [];
  const finalUpdates = [];
  const finishes = [];
  const warnings = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          sends.push(payload);
          return { code: 0, data: { message_id: 'om_native_already_sent' } };
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            return { code: 0, data: { card_id: 'AA-native-already-sent' } };
          },
          async update(payload) {
            finalUpdates.push(payload);
            return { code: 0, data: {} };
          },
          async settings(payload) {
            finishes.push(payload);
            return { code: 0, data: {} };
          },
        },
        cardElement: {
          async content() {
            return { code: 230099, msg: 'stream update unavailable' };
          },
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
    logger: { warn: (...args) => warnings.push(args) },
  });

  const result = await delivery.send({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    card: FINAL_CARD,
    idempotencyKey: 'feishu:create:task-native-sent',
    taskVersion: 2,
  });

  assert.deepEqual(result, { success: true, messageId: 'om_native_already_sent' });
  assert.equal(sends.length, 1);
  assert.equal(finalUpdates.length, 1);
  assert.equal(finalUpdates[0].data.sequence, 23);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].data.sequence, 24);
  assert.equal(warnings.length, 1);
});

test('falls back to an ordinary card when a deep CardKit final update fails', async () => {
  let sends = 0;
  let finishes = 0;
  const patches = [];
  const client = {
    im: {
      message: {
        async create() {
          sends += 1;
          return { code: 0, data: { message_id: 'om_terminal_repair' } };
        },
      },
      v1: {
        message: {
          async patch(payload) {
            patches.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert() {
            return { code: 0, data: { card_id: 'AA-terminal-repair' } };
          },
          async update() {
            return { code: 230099, msg: 'final update unavailable' };
          },
          async settings() {
            finishes += 1;
            return { code: 0, data: {} };
          },
        },
        cardElement: {
          async content() {
            return { code: 0, data: {} };
          },
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
    logger: { warn() {} },
  });

  const result = await delivery.send({
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    card: FINAL_CARD,
    idempotencyKey: 'feishu:create:task-terminal-repair',
    taskVersion: 3,
  });
  assert.deepEqual(result, { success: true, messageId: 'om_terminal_repair' });
  assert.equal(sends, 1);
  assert.equal(finishes, 0);
  assert.deepEqual(patches, [{
    path: { message_id: 'om_terminal_repair' },
    data: { content: JSON.stringify(FINAL_CARD) },
  }]);
});

test('retries the identical placeholder and repairs the card bound to the deduplicated message', async () => {
  const sends = [];
  const converts = [];
  const cardIds = [];
  let finalAttempts = 0;
  let lastSequence = 0;
  const client = {
    im: {
      message: {
        async create(payload) {
          sends.push(payload);
          return { code: 0, data: { message_id: 'om_deduplicated_task' } };
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          async idConvert(payload) {
            converts.push(payload);
            return { code: 0, data: { card_id: 'AA-card-bound-to-message' } };
          },
          async update(payload) {
            cardIds.push(payload.path.card_id);
            finalAttempts += 1;
            if (finalAttempts === 1) {
              return { code: 230099, msg: 'transient final update failure' };
            }
            if (payload.data.sequence <= lastSequence) {
              return { code: 300317, msg: 'sequence is not increasing' };
            }
            lastSequence = payload.data.sequence;
            return { code: 0, data: {} };
          },
          async settings(payload) {
            cardIds.push(payload.path.card_id);
            if (payload.data.sequence <= lastSequence) {
              return { code: 300317, msg: 'sequence is not increasing' };
            }
            lastSequence = payload.data.sequence;
            return { code: 0, data: {} };
          },
        },
        cardElement: {
          async content(payload) {
            cardIds.push(payload.path.card_id);
            if (payload.data.sequence <= lastSequence) {
              return { code: 300317, msg: 'sequence is not increasing' };
            }
            lastSequence = payload.data.sequence;
            return { code: 0, data: {} };
          },
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
    logger: { warn() {} },
  });
  const request = {
    target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
    card: FINAL_CARD,
    idempotencyKey: 'feishu:create:task-deduplicated-repair',
    taskVersion: 4,
  };

  await assert.rejects(delivery.send(request), /transient final update failure/);
  const result = await delivery.send(request);

  assert.deepEqual(result, { success: true, messageId: 'om_deduplicated_task' });
  assert.equal(sends.length, 2);
  assert.equal(sends[1].data.uuid, sends[0].data.uuid);
  assert.equal(sends[1].data.content, sends[0].data.content);
  assert.deepEqual(converts, [
    { data: { message_id: 'om_deduplicated_task' } },
    { data: { message_id: 'om_deduplicated_task' } },
  ]);
  assert.equal(cardIds.every(cardId => cardId === 'AA-card-bound-to-message'), true);
  assert.equal(lastSequence, 44);
});

test('surfaces an explicit placeholder rejection without sending different content', async () => {
  const sends = [];
  const client = {
    im: {
      message: {
        async create(payload) {
          sends.push(payload);
          return { code: 230001, msg: 'interactive card is unsupported' };
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
  });

  await assert.rejects(
    delivery.send({
      target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
      card: FINAL_CARD,
      idempotencyKey: 'feishu:create:task-placeholder-rejected',
      taskVersion: 1,
    }),
    /interactive card is unsupported/,
  );
  assert.equal(sends.length, 1);
});

test('does not send again when the placeholder has an ambiguous transport failure', async () => {
  let sends = 0;
  const timeout = new Error('request timed out');
  const client = {
    im: {
      message: {
        async create() {
          sends += 1;
          throw timeout;
        },
      },
    },
  };
  const delivery = createCardKitTaskCardDelivery({
    client,
    pause: async () => {},
  });

  await assert.rejects(
    delivery.send({
      target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
      card: FINAL_CARD,
      idempotencyKey: 'feishu:create:task-ambiguous-send',
      taskVersion: 1,
    }),
    error => error === timeout,
  );
  assert.equal(sends, 1);
});

test('rejects task versions that cannot fit the Feishu int32 sequence before sending', async () => {
  let sends = 0;
  const delivery = createCardKitTaskCardDelivery({
    client: {
      im: {
        message: {
          async create() {
            sends += 1;
            return { code: 0, data: { message_id: 'om_must_not_send' } };
          },
        },
      },
    },
    pause: async () => {},
  });

  await assert.rejects(
    delivery.send({
      target: { receiveId: 'ou_acceptor', receiveIdType: 'open_id' },
      card: FINAL_CARD,
      idempotencyKey: 'feishu:create:task-version-too-large',
      taskVersion: 214_748_365,
    }),
    /32-bit CardKit sequence/,
  );
  assert.equal(sends, 0);
});
