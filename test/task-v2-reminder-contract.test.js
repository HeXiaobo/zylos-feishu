import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createTaskV2MemberMapper } from '../src/lib/task-v2-member-mapper.js';
import {
  createTaskV2Projection,
  TASK_V2_LINK_BACKEND,
  TASK_V2_PROJECTION,
} from '../src/lib/task-v2-projection.js';
import { createSdkTaskV2Gateway } from '../src/lib/task-v2-sdk-adapter.js';

const REAL_CORE_MODULE = process.env.COMMITMENT_CORE_CONTRACT_MODULE ?? '';

test('real Core reminder projects once and is confirmed by native Task readback', async (context) => {
  if (!REAL_CORE_MODULE || !existsSync(REAL_CORE_MODULE)) {
    context.skip('COMMITMENT_CORE_CONTRACT_MODULE is unavailable');
    return;
  }
  const { openCommitmentCore } = await import(pathToFileURL(REAL_CORE_MODULE).href);
  const core = openCommitmentCore({
    dbPath: ':memory:',
    clock: () => '2026-08-26T10:00:00.000Z',
    idGenerator: () => 'core-reminder-contract',
    eventIdGenerator: () => 'event-reminder-contract',
    externalLinkIdGenerator: () => 'link-reminder-contract',
  });
  const calls = [];
  let remoteTask;
  const response = task => ({ code: 0, data: { task } });
  const client = {
    task: { v2: { task: {
      async list(payload) {
        calls.push(['list', payload]);
        return { code: 0, data: { items: [], has_more: false } };
      },
      async create(payload) {
        calls.push(['create', payload]);
        remoteTask = {
          guid: 'native-reminder-contract',
          url: 'https://applink.feishu.cn/task/native-reminder-contract',
          summary: payload.data.summary,
          description: payload.data.description,
          due: payload.data.due,
          completed_at: payload.data.completed_at,
          members: payload.data.members,
          extra: payload.data.extra,
          reminders: [],
        };
        return response(remoteTask);
      },
      async addReminders(payload) {
        calls.push(['addReminders', payload]);
        remoteTask = {
          ...remoteTask,
          reminders: payload.data.reminders.map(reminder => ({
            id: 'native-reminder-60',
            ...reminder,
          })),
        };
        return response(remoteTask);
      },
      async get(payload) {
        calls.push(['get', payload]);
        return response(remoteTask);
      },
      async patch() { throw new Error('unexpected patch'); },
      async addMembers() { throw new Error('unexpected addMembers'); },
      async removeMembers() { throw new Error('unexpected removeMembers'); },
      async removeReminders() { throw new Error('unexpected removeReminders'); },
    } } },
  };

  try {
    const ingested = core.ingest({
      idempotencyKey: 'feishu:om_reminder_contract:task-intent',
      source: {
        channel: 'feishu',
        externalId: 'om_reminder_contract',
        senderId: 'ou_requester',
      },
      task: {
        title: 'Reminder contract',
        ownerId: 'ou_requester',
        acceptorId: 'ou_requester',
        assigneeId: 'agent:mylos',
        dueAt: '2026-08-27T18:00:00+08:00',
        reminderMinutesBeforeDue: 60,
      },
    });
    const projection = createTaskV2Projection({
      core,
      gateway: createSdkTaskV2Gateway({ client }),
      memberMapper: createTaskV2MemberMapper({
        appId: 'cli_mylos',
        agentId: 'agent:mylos',
      }),
    });

    const [receipt] = await projection.publishBatch({
      deliveries: [{
        projection: TASK_V2_PROJECTION,
        eventId: 'event-reminder-contract',
        event: { taskId: ingested.task.id },
      }],
    });

    assert.equal(core.query({ taskId: ingested.task.id }).reminderMinutesBeforeDue, 60);
    assert.equal(calls.filter(([operation]) => operation === 'create').length, 1);
    assert.equal(calls.filter(([operation]) => operation === 'addReminders').length, 1);
    assert.equal(receipt.reminderMinutesBeforeDue, 60);
    assert.equal(remoteTask.reminders[0].relative_fire_minute, 60);
    assert.deepEqual(core.externalLinks.query({
      taskId: ingested.task.id,
      backend: TASK_V2_LINK_BACKEND,
    }).map(link => link.externalId), ['native-reminder-contract']);
  } finally {
    core.close();
  }
});
