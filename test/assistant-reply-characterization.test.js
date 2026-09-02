import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { chooseReplyTarget } from '../src/lib/reply-target.js';
import { loadContractFixture } from './helpers/assistant-reply-contract.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function gitObjectExists(object) {
  return spawnSync('git', ['cat-file', '-e', object], { cwd: REPO_ROOT }).status === 0;
}

test('official Feishu control preserves the narrow c4-receive/c4-send channel seam', () => {
  const fixture = loadContractFixture('official-control.json');
  assert.equal(
    git('merge-base', fixture.controlSha, fixture.forkBaselineSha),
    fixture.expectedMergeBase,
  );
  assert.equal(
    Number(git('rev-list', '--count', `${fixture.controlSha}..${fixture.forkBaselineSha}`)),
    fixture.expectedForkCommitsAhead,
  );
  for (const responsibility of fixture.responsibilities) {
    const source = git('show', `${fixture.controlSha}:${responsibility.path}`);
    for (const pattern of responsibility.patterns) {
      assert.match(source, new RegExp(pattern), `${responsibility.flow} is missing ${pattern}`);
    }
  }
  const design = git('show', `${fixture.controlSha}:DESIGN.md`);
  assert.match(design, /index\.js[\s\S]*c4-receive[\s\S]*Claude/);
  assert.match(design, /c4-send[\s\S]*scripts\/send\.js[\s\S]*Feishu/);
});

test('Inbox, response/CardKit, WorkIntake, and Task v2 assets are fork-only extensions', () => {
  const fixture = loadContractFixture('official-control.json');
  for (const file of fixture.forkExtensions) {
    assert.equal(gitObjectExists(`${fixture.controlSha}:${file}`), false, `${file} unexpectedly exists upstream`);
    assert.equal(gitObjectExists(`${fixture.forkBaselineSha}:${file}`), true, `${file} is missing from fork baseline`);
  }
  assert.deepEqual(fixture.classification.retainBehindAdapterSeams, [
    'durable inbound inbox and lease recovery',
    'CardKit projection and fallback assets',
    'WorkIntake and Task v2 durability/reconciliation assets',
  ]);
  assert.ok(fixture.classification.replaceAccidentalCoupling.includes(
    'projection timeout manufacturing a failed run',
  ));
});

test('legacy history key remains available while composition closes the topic_group gap', () => {
  const fixture = loadContractFixture('current-behavior.json');
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');
  assert.match(
    source,
    /function getHistoryKey\(chatId, threadId = null\) \{\s*return threadId \? `\$\{chatId\}:\$\{threadId\}` : chatId;\s*\}/,
  );
  assert.equal(source.includes("['group', 'topic_group']"), true);
  const rootGap = fixture.observations.find((entry) => entry.name === 'history-key-thread-only');
  assert.match(rootGap.gap, /root_id/);
  const topicGap = fixture.observations.find((entry) => entry.name === 'topic-group-compatibility');
  assert.match(topicGap.gap, /topic_group/);
});

test('current parent/root reply target changes presentation target, not the target lane contract', () => {
  assert.equal(
    chooseReplyTarget({ type: 'group', root: 'om_root', parent: 'om_parent', msg: 'om_message' }),
    'om_parent',
  );
  assert.equal(
    chooseReplyTarget({ type: 'group', root: 'om_root', msg: 'om_message' }),
    'om_root',
  );
  assert.equal(
    chooseReplyTarget({ type: 'p2p', root: 'om_root', parent: 'om_parent', msg: 'om_message' }),
    null,
  );
  const intake = loadContractFixture('accept-message.json');
  const replies = intake.conversationLanes.filter((vector) => vector.name.startsWith('group-reply-tree'));
  assert.equal(replies[0].laneKey, replies[1].laneKey);
  assert.notEqual(replies[0].replyTargetRef, replies[1].replyTargetRef);
});

test('p2p and group card opening keep reaction until a delivered terminal marker', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/index.js'), 'utf8');
  const sendSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/send.js'), 'utf8');
  const streamSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts/stream.js'), 'utf8');
  assert.match(source, /const TYPING_TIMEOUT = 120 \* 1000/);
  assert.doesNotMatch(
    source,
    /const timer = setTimeout\(\(\) => \{\s*removeTypingIndicator\(messageId\);\s*\}, TYPING_TIMEOUT\)/,
  );
  assert.doesNotMatch(
    source,
    /assistantRequest = await openConversationResponse\([\s\S]*?if \(assistantRequest\) removeTypingIndicator\(messageId\)/,
  );
  assert.doesNotMatch(
    source,
    /\? await openConversationResponse\([\s\S]*?if \(assistantRequest\) removeTypingIndicator\(messageId\)/,
  );
  assert.match(source, /Typing indicator remains active after/);
  assert.match(
    source,
    /async function settleTypingIndicator\(messageId\) \{\s*typingDoneMarkers\.mark\(messageId\);\s*await typingDoneMarkerConsumer\.drain\(\);\s*\}/,
  );
  assert.equal(
    [...source.matchAll(/removeTypingIndicator\(/g)].length,
    3,
    'production callers must settle through the durable marker consumer',
  );
  assert.equal(
    [...source.matchAll(/if \(\['create_task', 'confirm'\]\.includes\(response\?\.workIntake\?\.decision\)\)/g)].length,
    2,
    'p2p and group WorkIntake must leave chat_only presence to the assistant terminal',
  );
  assert.match(source, /async function handleMessage\(data, metadata = \{\}\)/);
  assert.equal(
    [...source.matchAll(/deliveryAttempt: metadata\.attempt \?\? 1/g)].length,
    2,
    'p2p and group task actions must receive the durable inbox attempt',
  );
  assert.match(
    source,
    /let settled = false;[\s\S]*decideTaskActionFailure\([\s\S]*if \(failure\.atAttemptLimit\) settled = true;[\s\S]*if \(failure\.retryTask\) throw error;[\s\S]*if \(settled\) await settleTypingIndicator\(messageId\);/,
  );
  assert.match(
    sendSource,
    /function settleAssistantReplyPresence\(\) \{\s*if \(taskCommentReplyEndpoint\) return false;\s*markTypingDone\(parsedEndpoint\.msg\);\s*return true;\s*\}/,
  );
  assert.equal(
    [...sendSource.matchAll(/markTypingDone\(parsedEndpoint\.msg\)/g)].length,
    1,
    'task-comment delivery must never be turned into an assistant presence settlement',
  );
  assert.match(streamSource, /createConversationResponseRuntimeAdapter/);
  assert.match(streamSource, /openTypingDoneMarkerStore/);
  const fixture = loadContractFixture('current-behavior.json');
  assert.match(
    fixture.observations.find((entry) => entry.name === 'reaction-card-open').gap,
    /projection state/,
  );
});

test('queued timeout stays observational while the legacy main timeout remains projection evidence', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src/lib/conversation-response-stream.js'),
    'utf8',
  );
  assert.match(source, /Queued response stream exceeded its observation window/);
  assert.match(source, /state\.queuedTimeoutObservedAt = clock\(\)/);
  assert.match(source, /reason: 'queued_timeout_observed'/);
  assert.doesNotMatch(source, /Queued response stream timed out; projecting a retry terminal/);
  assert.doesNotMatch(source, /排队超时/);
  assert.match(source, /Main response stream timed out; projecting a retry terminal/);
  assert.match(source, /state\.status = 'failed'/);
  assert.match(source, /本次回复未生成/);
  const observation = loadContractFixture('current-behavior.json').observations
    .find((entry) => entry.name === 'projection-timeout-terminalization');
  assert.match(observation.gap, /Runtime evidence/);
  assert.equal(observation.target, 'projection timeout never generates RunFailed');
});

test('durable inbox retains replay assets and adds namespaced identities plus lane sequence', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src/lib/inbound-event-inbox.js'), 'utf8');
  assert.match(source, /request_fingerprint TEXT NOT NULL/);
  assert.match(source, /kind TEXT NOT NULL CHECK \(kind IN \('event', 'message'\)\)/);
  assert.match(source, /feishu_inbound_source_identities/);
  assert.match(source, /account_ref TEXT/);
  assert.match(source, /event_type TEXT/);
  assert.match(source, /lane_sequence INTEGER/);
  assert.match(source, /feishu_conversation_lanes/);
  const observation = loadContractFixture('current-behavior.json').observations
    .find((entry) => entry.name === 'durable-inbound-dedupe');
  assert.match(observation.current, /deduplicate durably/);
  assert.match(observation.target, /namespaced dual identity/);
});
