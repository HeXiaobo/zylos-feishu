const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ZYLOS_DIR = path.join(HOME, 'zylos');
const FEISHU_SKILL_DIR = path.join(ZYLOS_DIR, '.claude/skills/feishu');
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
  ]
};
