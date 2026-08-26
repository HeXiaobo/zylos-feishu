export const TASK_V2_STATUS_EVENT = 'task.task.update_user_access_v2';
export const TASK_V2_LEGACY_STATUS_EVENT = 'task.task.updated_v1';

export function isTaskV2Enabled(env = process.env) {
  return env?.COMMITMENT_FEISHU_TASK_V2_ENABLED === '1';
}

export function createTaskV2EventHandlerEntries({ enabled, handle } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (typeof handle !== 'function') throw new TypeError('handle must be a function');
  return enabled ? {
    [TASK_V2_STATUS_EVENT]: handle,
    [TASK_V2_LEGACY_STATUS_EVENT]: handle,
  } : {};
}
