const path = require('path');
const os = require('os');

const ZYLOS_DIR = path.join(os.homedir(), 'zylos');
const FEISHU_DIR = path.join(ZYLOS_DIR, '.claude/skills/feishu');
const LOG_DIR = path.join(ZYLOS_DIR, 'components/feishu/logs');

// Start only after Task v2 projection has passed its one-shot canary and the
// task.task.comment.updated_v1 event subscription is published and authorized.
module.exports = {
  apps: [{
    name: 'zylos-feishu-task-comments',
    script: path.join(FEISHU_DIR, 'src/lib/task-comment-worker.js'),
    args: ['run'],
    cwd: FEISHU_DIR,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      ZYLOS_DIR,
      FEISHU_TASK_COMMENTS_ENABLED: '1',
      FEISHU_TASK_COMMENTS_WORKER_AUTOSTART: '1',
    },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(LOG_DIR, 'task-comments-error.log'),
    out_file: path.join(LOG_DIR, 'task-comments-out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
