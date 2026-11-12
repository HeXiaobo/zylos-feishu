import assert from 'node:assert/strict';
import test from 'node:test';
import { readInteractiveCard } from '../src/lib/interactive-card-inbound.js';

test('reads card text and image keys using the configured client', async () => {
  const client = { im: { message: { get: async request => {
    assert.equal(request.path.message_id, 'om_card');
    assert.equal(request.params.card_msg_content_type, 'user_card_content');
    return { code: 0, data: { items: [{ body: { content: JSON.stringify({
      schema: '2.0', body: { elements: [
        { tag: 'markdown', content: 'Hello' },
        { tag: 'img', image_key: 'img_one' },
      ] },
    }) } }] } };
  } } } };
  assert.deepEqual(await readInteractiveCard('om_card', client), {
    text: 'Hello', imageKeys: ['img_one'],
  });
});

test('failed card reads are reported without attempting image downloads', async () => {
  const client = { im: { message: { get: async () => ({ code: 230002, msg: 'unavailable' }) } } };
  const eventContent = { body: { elements: [{ tag: 'markdown', content: 'Existing event text' }] } };
  assert.deepEqual(await readInteractiveCard('om_card', client, eventContent), {
    text: 'Existing event text', imageKeys: [],
  });
});
