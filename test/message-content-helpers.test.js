import assert from 'node:assert/strict';
import test from 'node:test';

import { getInteractiveCardContent } from '../src/lib/message.js';

test('getInteractiveCardContent reads the original card through the public message seam', async () => {
  const calls = [];
  const result = await getInteractiveCardContent('om_card', {
    getToken: async () => 'tenant-token',
    request: async request => {
      calls.push(request);
      return {
        data: {
          code: 0,
          data: {
            items: [{
              body: { content: JSON.stringify({
                schema: '2.0',
                body: { elements: [{ tag: 'markdown', content: '卡片正文' }] },
              }) },
              mentions: [{ key: '@_user_1', name: '小明' }],
            }],
          },
        },
      };
    },
  });

  assert.deepEqual(result, {
    success: true,
    content: {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: '卡片正文' }] },
    },
    mentions: [{ key: '@_user_1', name: '小明' }],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/messages\/om_card\?/);
  assert.match(calls[0].url, /card_msg_content_type=user_card_content/);
  assert.match(calls[0].url, /user_id_type=open_id/);
  assert.equal(calls[0].headers.Authorization, 'Bearer tenant-token');
});

test('message read-back helpers preserve explicit API failures', async () => {
  const result = await getInteractiveCardContent('om_forbidden', {
    client: {
      im: { message: {
        async get(request) {
          assert.deepEqual(request.path, { message_id: 'om_forbidden' });
          return { code: 230002, msg: 'Bot/User can NOT be out of the chat.' };
        },
      } },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 230002);
  assert.match(result.message, /out of the chat/);
});
