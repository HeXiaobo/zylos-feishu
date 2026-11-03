import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../scripts/send.js', import.meta.url));
const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Synthetic report' }] } };

// Run the actual CLI with its environment, filesystem reads and platform calls
// replaced at the import boundary. No production credentials or network are used.
function runMedia({ endpoint = 'oc_test|type:p2p|root:om_old|parent:om_parent|msg:om_trigger',
  type = 'card', contents = JSON.stringify(card), replies = [], sendSuccess = true,
  sendThrows = false, missing = false } = {}) {
  const options = { contents, replies, sendSuccess, sendThrows, missing };
  const preload = `
    import { register } from 'node:module';
    globalThis.calls = [];
    globalThis.options = ${JSON.stringify(options)};
    globalThis.record = (method, ...args) => globalThis.calls.push({ method, args });
    globalThis.fetch = async (...args) => { record('recordOutgoing', ...args); return {}; };
    process.on('exit', () => console.log('TEST_CALLS:' + JSON.stringify(globalThis.calls)));
    const mock = (source) => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });
    function resolve(specifier, context, nextResolve) {
      if (specifier === 'dotenv') return mock('export default { config() {} };');
      if (specifier === 'fs') return mock(\`
        export default { readFileSync(file) {
          record('readFile', file);
          if (file.endsWith('/.internal-token')) return 'synthetic-internal-token';
          if (options.missing) throw new Error('ENOENT: synthetic card missing');
          return options.contents;
        } };
      \`);
      if (specifier.endsWith('/config.js')) return mock(\`
        export const DATA_DIR = '/synthetic-data';
        export const getConfig = () => ({ enabled: true, message: { useMarkdownCard: false } });
        export const getResponseStreamMainTimeoutMs = () => 1000;
        export const getStreamProcessDisplay = () => null;
        export const getCredentials = () => { throw new Error('Unexpected credentials access'); };
      \`);
      if (specifier.endsWith('/message.js')) return mock(\`
        export async function sendMessage(...args) {
          record('sendMessage', ...args);
          if (options.sendThrows) throw new Error('synthetic send error');
          return { success: options.sendSuccess, message: 'synthetic send rejected' };
        }
        export async function replyToMessage(...args) {
          record('replyToMessage', ...args);
          const outcome = options.replies.shift() ?? true;
          if (outcome === 'throw') throw new Error('synthetic reply error');
          return { success: outcome, message: 'synthetic reply rejected' };
        }
        export const sendToGroup = async (...args) => { throw new Error('Unexpected text send'); };
        export const uploadImage = async (...args) => { record('uploadImage', ...args); return { success: true, imageKey: 'img_synthetic' }; };
        export const sendImage = async (...args) => { record('sendImage', ...args); return { success: true }; };
        export const uploadFile = async (...args) => { record('uploadFile', ...args); return { success: true, fileKey: 'file_synthetic' }; };
        export const sendFile = async (...args) => { record('sendFile', ...args); return { success: true }; };
      \`);
      if (specifier.endsWith('/mention.js')) return mock(\`
        export function initMention() {}
        export const buildMentionContent = () => { throw new Error('Unexpected text conversion'); };
        export const buildMentionMarkdown = () => { throw new Error('Unexpected card conversion'); };
        export const resolveMentionMapForChat = () => { throw new Error('Unexpected member lookup'); };
      \`);
      if (specifier.endsWith('/at-mention.js')) return mock('export const convertAtMentionsForCard = () => { throw new Error("Unexpected conversion"); };');
      if (specifier.endsWith('/client.js')) return mock('export const getClient = () => { throw new Error("Unexpected SDK access"); };');
      if (specifier.endsWith('/conversation-response-stream.js')) return mock('export const createConversationResponseStream = () => { throw new Error("Unexpected response stream"); };');
      if (specifier.endsWith('/c4-delivery-policy.js')) return mock('export const completedCardFailureAction = () => "fail"; export const requestIdForC4Delivery = () => null;');
      if (specifier.endsWith('/task-comment-production.js')) return mock('export const parseTaskCommentReplyEndpoint = () => null;');
      if (specifier.endsWith('/task-comment-reply-production.js')) return mock('export const createTaskCommentReplyProduction = () => { throw new Error("Unexpected task reply"); };');
      if (specifier.endsWith('/task-comment-runtime-policy.js')) return mock('export const isTaskCommentsEnabled = () => false;');
      if (specifier.endsWith('/typing-done-marker.js')) return mock(\`
        export const settlementMessageIdFromEndpoint = () => 'om_trigger';
        export const openTypingDoneMarkerStore = () => ({ mark(id) { record('typingDone', id); } });
      \`);
      return nextResolve(specifier, context);
    }
    register('data:text/javascript,' + encodeURIComponent(
      'const mock = ' + mock.toString() + '; export const resolve = ' + resolve.toString()
    ));
  `;
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(FEISHU_|LARK_|C4_)/.test(name)) delete env[name];
  }
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    entrypoint, endpoint, `[MEDIA:${type}]/synthetic/report.json`,
  ], { encoding: 'utf8', env, timeout: 10_000 });
  assert.equal(result.error, undefined);
  const trace = result.stdout.split('\n').find(line => line.startsWith('TEST_CALLS:'));
  assert.ok(trace, result.stderr);
  return { ...result, calls: JSON.parse(trace.slice('TEST_CALLS:'.length)) };
}

const platformCalls = (result) => result.calls.filter(call =>
  ['sendMessage', 'replyToMessage', 'uploadImage', 'sendImage', 'uploadFile', 'sendFile'].includes(call.method));

test('C4 card media sends Card 2.0 unchanged to the p2p main chat, never its inherited thread', () => {
  const result = runMedia();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(platformCalls(result), [{ method: 'sendMessage', args: ['oc_test', JSON.stringify(card), 'chat_id', 'interactive'] }]);
  assert.equal(result.calls.some(call => call.method === 'typingDone'), true);
  const history = result.calls.find(call => call.method === 'recordOutgoing');
  assert.equal(JSON.parse(history.args[1].body).text, '[sent card]');
});

test('C4 card media stays in a group topic and falls back from parent to root', () => {
  const result = runMedia({ endpoint: 'oc_test|type:topic_group|root:om_root|parent:om_parent|msg:om_trigger', replies: [false, true] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(platformCalls(result), [
    { method: 'replyToMessage', args: ['om_parent', JSON.stringify(card), 'interactive'] },
    { method: 'replyToMessage', args: ['om_root', JSON.stringify(card), 'interactive'] },
  ]);
});

test('C4 card media uses the group mention target when no topic exists', () => {
  const result = runMedia({ endpoint: 'oc_test|type:group|msg:om_trigger' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(platformCalls(result), [{ method: 'replyToMessage', args: ['om_trigger', JSON.stringify(card), 'interactive'] }]);
});

test('C4 card media keeps the existing base-send fallback after parent and root failure', () => {
  const result = runMedia({ endpoint: 'oc_test|type:group|root:om_root|parent:om_parent|msg:om_trigger', replies: ['throw', false] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(platformCalls(result).map(call => [call.method, call.args[0]]), [
    ['replyToMessage', 'om_parent'], ['replyToMessage', 'om_root'], ['sendMessage', 'oc_test'],
  ]);
});

for (const [name, options] of [
  ['invalid JSON', { contents: '{private synthetic content' }],
  ['missing file', { missing: true }],
  ['null', { contents: 'null' }],
  ['array', { contents: '[]' }],
  ['wrong schema', { contents: JSON.stringify({ schema: '1.0', body: { elements: [] } }) }],
  ['missing elements', { contents: JSON.stringify({ schema: '2.0', body: {} }) }],
]) {
  test(`C4 card media rejects ${name} before platform calls or success records`, () => {
    const result = runMedia(options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, name === 'invalid JSON' ? /Invalid card JSON file/
      : name === 'missing file' ? /ENOENT/ : /Expected a Feishu Card 2.0 JSON file/);
    assert.doesNotMatch(result.stderr, /private synthetic content/);
    assert.deepEqual(platformCalls(result), []);
    assert.equal(result.calls.some(call => ['typingDone', 'recordOutgoing'].includes(call.method)), false);
    assert.doesNotMatch(result.stdout, /Message sent successfully/);
  });
}

for (const options of [{ sendSuccess: false }, { sendThrows: true }]) {
  test(`C4 card media propagates platform ${options.sendThrows ? 'exceptions' : 'rejections'} without recording success`, () => {
    const result = runMedia(options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /synthetic send/);
    assert.equal(result.calls.some(call => ['typingDone', 'recordOutgoing'].includes(call.method)), false);
    assert.doesNotMatch(result.stdout, /Message sent successfully/);
  });
}

for (const [type, key] of [['image', 'img_synthetic'], ['file', 'file_synthetic']]) {
  test(`existing ${type} media keeps its upload, p2p routing and history marker`, () => {
    const result = runMedia({ type });
    assert.equal(result.status, 0, result.stderr);
    const title = type[0].toUpperCase() + type.slice(1);
    assert.deepEqual(platformCalls(result), [
      { method: `upload${title}`, args: ['/synthetic/report.json'] },
      { method: `send${title}`, args: ['oc_test', key] },
    ]);
    const history = result.calls.find(call => call.method === 'recordOutgoing');
    assert.equal(JSON.parse(history.args[1].body).text, `[sent ${type}]`);
  });
}
