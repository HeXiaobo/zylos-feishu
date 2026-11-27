import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplyReceipt } from '../src/lib/c4-receipt.js';

function harness(token = 'tok-1') {
  const lines = [];
  const receipts = createReplyReceipt({ token, print: (line) => lines.push(line) });
  return { receipts, lines };
}

test('text reply prints C4_RECEIPT with the first message id', async () => {
  const { receipts, lines } = harness();
  const sendMessage = receipts.wrap(async () => ({ success: true, messageId: 'om_first' }));

  await sendMessage('oc_chat', 'hello');
  receipts.emit();

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice('C4_RECEIPT '.length)), {
    receiptToken: 'tok-1',
    platformMessageId: 'om_first',
  });
});

test('multi-chunk reply uses the first chunk message id', async () => {
  const { receipts, lines } = harness('tok-2');
  let n = 0;
  const sendMessage = receipts.wrap(async () => ({ success: true, messageId: `om_chunk_${++n}` }));

  await sendMessage('oc_chat', 'part one');
  await sendMessage('oc_chat', 'part two');
  receipts.emit();

  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0].slice('C4_RECEIPT '.length)).platformMessageId, 'om_chunk_1');
});

test('media send prints C4_RECEIPT', async () => {
  const { receipts, lines } = harness('tok-3');
  const sendImage = receipts.wrap(async () => ({ success: true, messageId: 'om_image' }));

  await sendImage('oc_chat', 'img_key');
  receipts.emit();

  assert.equal(JSON.parse(lines[0].slice('C4_RECEIPT '.length)).platformMessageId, 'om_image');
});

test('no receipt token prints no C4_RECEIPT', async () => {
  const { receipts, lines } = harness('');
  const sendMessage = receipts.wrap(async () => ({ success: true, messageId: 'om_first' }));

  await sendMessage('oc_chat', 'hello');
  const emitted = receipts.emit();

  assert.equal(emitted, null);
  assert.deepEqual(lines, []);
});

test('a failed send records no receipt', async () => {
  const { receipts, lines } = harness('tok-4');
  const sendMessage = receipts.wrap(async () => ({ success: false, message: 'nope' }));

  await sendMessage('oc_chat', 'hello');

  assert.equal(receipts.messageId, null);
  assert.deepEqual(lines, []);
});
