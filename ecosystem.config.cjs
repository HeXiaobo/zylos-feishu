const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ZYLOS_DIR = path.join(HOME, 'zylos');
const FEISHU_SKILL_DIR = path.join(ZYLOS_DIR, '.claude/skills/feishu');
const COMMITMENT_CORE_DIR = path.join(ZYLOS_DIR, '.claude/skills/commitment-core');
const FEISHU_LOG_DIR = path.join(ZYLOS_DIR, 'components/feishu/logs');

module.exports = {
  apps: [
    {
      name: 'zylos-feishu',
      script: 'src/index.js',
      cwd: FEISHU_SKILL_DIR,
      env: {
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      error_file: path.join(FEISHU_LOG_DIR, 'error.log'),
      out_file: path.join(FEISHU_LOG_DIR, 'out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    },
    {
      name: 'zylos-feishu-task-projection',
      script: path.join(COMMITMENT_CORE_DIR, 'scripts/feishu-projection-worker.js'),
      args: [
        'run',
        '--runtime-module',
        path.join(FEISHU_SKILL_DIR, 'src/lib/feishu-projection-runtime.js'),
      ],
      cwd: path.join(COMMITMENT_CORE_DIR, 'scripts'),
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        ZYLOS_DIR,
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      kill_timeout: 5000,
      error_file: path.join(FEISHU_LOG_DIR, 'task-projection-error.log'),
      out_file: path.join(FEISHU_LOG_DIR, 'task-projection-out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ]
};
