import assert from 'node:assert/strict';
import test from 'node:test';

import { createConversationLaneCoordinator } from '../src/lib/conversation-lane-coordinator.js';

test('keeps same-lane FIFO while another lane obtains a durable receipt', async () => {
  const coordinator = createConversationLaneCoordinator({ concurrency: 2 });
  const starts = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  const firstAccepted = new Promise((resolve) => { releaseFirst = resolve; });

  const run = (name, waitFor = null) => async () => {
    starts.push(name);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (waitFor) await waitFor;
    active -= 1;
    return { name, durable: true };
  };

  const first = coordinator.submit({ conversationLaneKey: 'lane-a', laneSequence: 1 }, run('a1', firstAccepted));
  const second = coordinator.submit({ conversationLaneKey: 'lane-a', laneSequence: 2 }, run('a2'));
  const otherLane = coordinator.submit({ conversationLaneKey: 'lane-b', laneSequence: 1 }, run('b1'));

  assert.deepEqual(await otherLane, { name: 'b1', durable: true });
  assert.deepEqual(starts, ['a1', 'b1']);
  assert.equal(maximumActive, 2);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [
    { name: 'a1', durable: true },
    { name: 'a2', durable: true },
  ]);
  assert.deepEqual(starts, ['a1', 'b1', 'a2']);
});
