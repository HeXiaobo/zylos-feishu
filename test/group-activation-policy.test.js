import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideGroupActivation } from '../src/lib/group-activation-policy.js';

describe('group activation policy', () => {
  it('processes an exact bot mention and permits task intake', () => {
    assert.deepEqual(decideGroupActivation({
      chatType: 'group',
      mentionedBot: true,
      smartMode: false,
    }), {
      process: true,
      smartMode: false,
      allowTaskIntake: true,
    });
  });

  it('ignores an ordinary message in a mention-only group', () => {
    assert.deepEqual(decideGroupActivation({
      chatType: 'group',
      mentionedBot: false,
      smartMode: false,
    }), {
      process: false,
      smartMode: false,
      allowTaskIntake: false,
    });
  });

  it('preserves explicit smart-group chat without permitting task intake', () => {
    assert.deepEqual(decideGroupActivation({
      chatType: 'group',
      mentionedBot: false,
      smartMode: true,
    }), {
      process: true,
      smartMode: true,
      allowTaskIntake: false,
    });
  });

  it('does not apply group activation rules to direct messages', () => {
    assert.deepEqual(decideGroupActivation({
      chatType: 'p2p',
      mentionedBot: false,
      smartMode: false,
    }), {
      process: true,
      smartMode: false,
      allowTaskIntake: true,
    });
  });
});
