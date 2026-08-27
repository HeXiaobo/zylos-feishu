export function isTaskCommentsEnabled(env = process.env) {
  return env?.COMMITMENT_FEISHU_TASK_V2_ENABLED === '1'
    && env?.FEISHU_TASK_COMMENTS_ENABLED === '1';
}

export function requireTaskCommentsEnabled(env = process.env) {
  if (!isTaskCommentsEnabled(env)) {
    throw new Error(
      'COMMITMENT_FEISHU_TASK_V2_ENABLED=1 and FEISHU_TASK_COMMENTS_ENABLED=1 are required',
    );
  }
}
