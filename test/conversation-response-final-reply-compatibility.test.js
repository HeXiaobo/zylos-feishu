import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createConversationResponseFinalReplyCompatibility,
} from '../src/lib/conversation-response-final-reply-compatibility.js';
import { createConversationResponseStream } from '../src/lib/conversation-response-stream.js';
import { createFeishuFinalReplyPort } from '../src/lib/feishu-final-reply-port.js';
import { assertDeliveryReceipt } from './helpers/assistant-reply-contract.js';

function contentHash(payload) {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function intent({ text = '兼容层最终答案', suffix = 'route-a' } = {}) {
  const payload = { format: 'text', text };
  return {
    schemaVersion: 1,
    type: 'ReplyIntent',
    intentId: `reply:req-compat:${suffix}`,
    requestId: 'req-compat',
    traceId: 'trace-compat',
    cause: { kind: 'run_terminal', eventId: 'evt-compat' },
    route: { adapterId: 'feishu', targetRef: 'opaque:compat-route-a' },
    disposition: 'send',
    payload,
    contentHash: contentHash(payload),
    idempotencyKey: `reply:req-compat:${suffix}`,
  };
}

function claim({ action = 'send', attemptId = 'attempt:compat:1', reply = intent() } = {}) {
  return {
    replayed: false,
    action,
    intent: reply,
    deliveryId: `delivery:${reply.intentId}`,
    attemptId,
    claimEpoch: 1,
    leaseOwner: 'worker-a',
    leaseToken: 'lease-a',
    leaseExpiresAt: 1_788_000_030,
  };
}

function target() {
  return { chatId: 'oc-compat', chatType: 'group', replyToMessageId: 'om-source' };
}

function createClient({
  loseFirstResponse = false,
  loseResponseAt = null,
  rejectInteractive = false,
} = {}) {
  const calls = [];
  let messages = 0;
  const lostResponseAttempt = loseResponseAt ?? (loseFirstResponse ? 1 : null);
  let deliveryAttempts = 0;
  const send = async (kind, payload) => {
    calls.push([kind, structuredClone(payload)]);
    deliveryAttempts += 1;
    messages += 1;
    if (deliveryAttempts === lostResponseAttempt) {
      throw new Error('socket closed after platform acceptance');
    }
    const content = JSON.parse(payload.data.content);
    if (rejectInteractive && content.schema === '2.0') {
      return { code: 230001, msg: 'interactive unavailable' };
    }
    return { code: 0, data: { message_id: `om-compat-${messages}` } };
  };
  return {
    calls,
    client: {
      im: {
        message: {
          create: payload => send('send', payload),
          reply: payload => send('reply', payload),
        },
      },
      cardkit: { v1: { card: {} } },
    },
  };
}

function withState(testFn) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-final-compat-'));
  return Promise.resolve(testFn(stateDirectory))
    .finally(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
}

test('binds every attempt and redrive generation to the stable ReplyIntent identity', async () => {
  const calls = [];
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream: {
      async sendCompleted(input) {
        calls.push(['send', structuredClone(input)]);
        return { handled: true, replayed: calls.length > 1, messageId: 'om-stable' };
      },
      async reconcileCompleted(input) {
        calls.push(['reconcile', structuredClone(input)]);
        return { outcome: 'reconciled', messageId: 'om-stable' };
      },
    },
    resolveTarget(targetRef) {
      calls.push(['resolve', targetRef]);
      return target();
    },
  });

  assert.deepEqual(await compatibility.send(claim()), {
    outcome: 'platform_accepted',
    externalRef: 'om-stable',
  });
  assert.deepEqual(await compatibility.send(claim({ attemptId: 'attempt:compat:redrive:2' })), {
    outcome: 'platform_accepted',
    externalRef: 'om-stable',
  });
  const sends = calls.filter(([operation]) => operation === 'send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends.map(([, input]) => input), [
    { requestId: intent().intentId, target: target(), output: intent().payload.text },
    { requestId: intent().intentId, target: target(), output: intent().payload.text },
  ]);
});

test('uses the real stream store to replay a redrive without a duplicate Feishu message', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  const stream = createConversationResponseStream({ client, stateDirectory, throttleMs: 0 });
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream,
    resolveTarget: target,
  });

  const first = await compatibility.send(claim());
  const redrive = await compatibility.send(claim({ attemptId: 'attempt:compat:redrive:2' }));
  assert.equal(first.outcome, 'platform_accepted');
  assert.equal(redrive.outcome, 'platform_accepted');
  assert.equal(first.externalRef, redrive.externalRef);
  assert.equal(calls.filter(([operation]) => operation === 'reply').length, 1);
}));

test('unknown delivery reconciles through the real persisted stream before any resend', () => withState(async stateDirectory => {
  const firstClient = createClient({ loseFirstResponse: true });
  const firstStream = createConversationResponseStream({
    client: firstClient.client,
    stateDirectory,
    throttleMs: 0,
  });
  const firstCompatibility = createConversationResponseFinalReplyCompatibility({
    stream: firstStream,
    resolveTarget: target,
  });
  assert.deepEqual(await firstCompatibility.send(claim()), {
    outcome: 'unknown',
    externalRef: null,
  });

  const restartedClient = createClient();
  const secondStream = createConversationResponseStream({
    client: restartedClient.client,
    stateDirectory,
    throttleMs: 0,
    completedDeliveryReconciler: async operation => {
      assert.equal(operation.requestId, intent().intentId);
      assert.equal(operation.uuid, firstClient.calls[0][1].data.uuid);
      return { outcome: 'reconciled', messageId: 'om-lost-response' };
    },
  });
  const secondCompatibility = createConversationResponseFinalReplyCompatibility({
    stream: secondStream,
    resolveTarget: target,
  });
  assert.deepEqual(await secondCompatibility.reconcile(claim({ action: 'reconcile' })), {
    outcome: 'reconciled',
    externalRef: 'om-lost-response',
  });
  assert.equal(restartedClient.calls.filter(([operation]) => operation === 'reply').length, 0);

  const replay = await secondCompatibility.send(claim({ attemptId: 'attempt:compat:redrive:2' }));
  assert.equal(replay.externalRef, 'om-lost-response');
  assert.equal(restartedClient.calls.filter(([operation]) => operation === 'reply').length, 0);
}));

test('does not misclassify a local identity conflict as an unknown platform delivery', async () => {
  const conflict = new Error('stable stream key already owns different content');
  conflict.code = 'ASSISTANT_TERMINAL_CONFLICT';
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream: {
      async sendCompleted() { throw conflict; },
      async reconcileCompleted() { throw new Error('not reached'); },
    },
    resolveTarget: target,
  });

  await assert.rejects(
    compatibility.send(claim()),
    error => error === conflict,
  );
});

test('an inconclusive reconciliation never falls through to a second send', async () => {
  const calls = [];
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream: {
      async sendCompleted() {
        calls.push('send');
        throw new Error('not reached');
      },
      async reconcileCompleted() {
        calls.push('reconcile');
        return { outcome: 'unknown', messageId: null };
      },
    },
    resolveTarget: target,
  });

  await assert.rejects(
    compatibility.reconcile(claim({ action: 'reconcile' })),
    error => error?.code === 'FEISHU_RECONCILIATION_INCONCLUSIVE',
  );
  assert.deepEqual(calls, ['reconcile']);
});

test('reconciles an unknown middle card and resumes later parts without duplicating prior cards', () => withState(async stateDirectory => {
  const reply = intent({ text: 'x'.repeat(600), suffix: 'multi-part' });
  const sendClaim = claim({ reply, attemptId: 'attempt:compat:multi:1' });
  const firstClient = createClient({ loseResponseAt: 2 });
  const firstStream = createConversationResponseStream({
    client: firstClient.client,
    stateDirectory,
    throttleMs: 0,
    answerBytesPerCard: 256,
  });
  const firstCompatibility = createConversationResponseFinalReplyCompatibility({
    stream: firstStream,
    resolveTarget: target,
  });

  assert.deepEqual(await firstCompatibility.send(sendClaim), {
    outcome: 'unknown',
    externalRef: null,
  });
  assert.equal(firstClient.calls.filter(([operation]) => operation === 'reply').length, 2);
  const unknownUuid = firstClient.calls[1][1].data.uuid;

  const restartedClient = createClient();
  const secondStream = createConversationResponseStream({
    client: restartedClient.client,
    stateDirectory,
    throttleMs: 0,
    answerBytesPerCard: 256,
    completedDeliveryReconciler: async operation => {
      assert.equal(operation.part, 1);
      assert.equal(operation.uuid, unknownUuid);
      return { outcome: 'reconciled', messageId: 'om-reconciled-part-2' };
    },
  });
  const secondCompatibility = createConversationResponseFinalReplyCompatibility({
    stream: secondStream,
    resolveTarget: target,
  });
  const reconciled = await secondCompatibility.reconcile(claim({
    action: 'reconcile',
    reply,
    attemptId: sendClaim.attemptId,
  }));
  assert.equal(reconciled.outcome, 'reconciled');
  assert.equal(reconciled.externalRef, 'om-compat-1');
  assert.equal(restartedClient.calls.filter(([operation]) => operation === 'reply').length, 1);
  assert.notEqual(restartedClient.calls[0][1].data.uuid, unknownUuid);

  const replay = await secondCompatibility.send(claim({
    reply,
    attemptId: 'attempt:compat:multi:redrive',
  }));
  assert.equal(replay.externalRef, 'om-compat-1');
  assert.equal(restartedClient.calls.filter(([operation]) => operation === 'reply').length, 1);
}));

test('the real compatibility entry produces the exact receipt consumed by Core', () => withState(async stateDirectory => {
  const { client } = createClient();
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream: createConversationResponseStream({ client, stateDirectory, throttleMs: 0 }),
    resolveTarget: target,
  });
  const port = createFeishuFinalReplyPort({
    delivery: compatibility,
    presentation: { settlePresence() {} },
    clock: () => Date.parse('2026-09-01T09:00:00.000Z'),
  });

  const receipt = await port.deliver(claim());
  assertDeliveryReceipt(receipt);
  assert.equal(receipt.outcome, 'platform_accepted');
  assert.equal(receipt.intentId, intent().intentId);
  assert.equal(receipt.attemptId, 'attempt:compat:1');
  assert.equal(receipt.externalRef, 'om-compat-1');
}));

test('the real compatibility entry keeps one plain fallback identity across redrive', () => withState(async stateDirectory => {
  const { client, calls } = createClient({ rejectInteractive: true });
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream: createConversationResponseStream({
      client,
      stateDirectory,
      throttleMs: 0,
      logger: { warn() {} },
    }),
    resolveTarget: target,
  });

  const first = await compatibility.send(claim());
  const redrive = await compatibility.send(claim({ attemptId: 'attempt:compat:redrive:2' }));
  assert.equal(first.outcome, 'platform_accepted');
  assert.equal(first.externalRef, 'om-compat-2');
  assert.equal(redrive.externalRef, first.externalRef);
  assert.equal(calls.filter(([operation]) => operation === 'reply').length, 2);
  assert.equal(JSON.parse(calls[1][1].data.content).text, intent().payload.text);
}));

test('a redrive cannot rebind the stable reply to a newly resolved target', () => withState(async stateDirectory => {
  const { client, calls } = createClient();
  let resolvedTarget = target();
  const compatibility = createConversationResponseFinalReplyCompatibility({
    stream: createConversationResponseStream({ client, stateDirectory, throttleMs: 0 }),
    resolveTarget: () => resolvedTarget,
  });

  await compatibility.send(claim());
  resolvedTarget = { ...target(), replyToMessageId: 'om-different-source' };
  await assert.rejects(
    compatibility.send(claim({ attemptId: 'attempt:compat:redrive:2' })),
    error => error?.code === 'ASSISTANT_TERMINAL_CONFLICT',
  );
  assert.equal(calls.filter(([operation]) => operation === 'reply').length, 1);
}));
