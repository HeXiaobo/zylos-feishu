import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/lib/message.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

test('every Feishu create/reply API payload contains the supplied uuid', async () => {
  const calls = [];
  const seen = new Map();
  const api = async args => {
    calls.push(args);
    if (!seen.has(args.data.uuid)) seen.set(args.data.uuid, 'om_stub');
    return { code: 0, data: { message_id: seen.get(args.data.uuid) } };
  };
  const context = { getClient: () => ({ im: { message: { create: api, reply: api } } }), Buffer, console };
  vm.createContext(context);
  vm.runInContext(source, context);
  for (const expression of [
    "sendMessage('oc','hi','chat_id','text',{uuid:'42'})",
    "replyToMessage('om','hi','text',{uuid:'42'})",
    "sendToGroup('oc','hi','text',{uuid:'42'})",
    "sendImage('oc','img','chat_id',{uuid:'42'})",
    "sendFile('oc','file','chat_id',{uuid:'42'})",
    "sendMarkdownCard('oc','hi','chat_id',{uuid:'42'})",
    "replyMarkdownCard('om','hi',{uuid:'42'})",
  ]) {
    const result = await vm.runInContext(expression, context);
    assert.equal(result.messageId, 'om_stub');
    assert.equal(calls.at(-1).data.uuid, '42');
  }
  assert.equal(calls.length, 7);
  const replay = await vm.runInContext("sendMessage('oc','hi','chat_id','text',{uuid:'42'})", context);
  assert.equal(replay.messageId, 'om_stub');
  assert.equal(seen.size, 1, 'fake Feishu creates only one message for a replayed uuid');
});
