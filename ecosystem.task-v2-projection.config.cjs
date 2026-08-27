const path = require('path');
const os = require('os');

const ZYLOS_DIR = path.join(os.homedir(), 'zylos');
const FEISHU_DIR = path.join(ZYLOS_DIR, '.claude/skills/feishu');
const LOG_DIR = path.join(ZYLOS_DIR, 'components/feishu/logs');

// Task v2 is a separate opt-in projection. Register its explicit history
// policy, set COMMITMENT_FEISHU_TASK_V2_ENABLED=1 in ~/zylos/.env, and run a
// one-shot fake/canary before starting this process. The shared .env flag also
// gates reverse Task events in the ordinary Feishu service.
module.exports = {
  apps: [{
    name: 'zylos-feishu-task-v2-projection',
    script: path.join(FEISHU_DIR, 'src/lib/task-v2-projection-worker.js'),
    args: ['run'],
    cwd: FEISHU_DIR,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      ZYLOS_DIR,
      COMMITMENT_FEISHU_TASK_V2_PROJECTION_AUTOSTART: '1',
    },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(LOG_DIR, 'task-v2-projection-error.log'),
    out_file: path.join(LOG_DIR, 'task-v2-projection-out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
