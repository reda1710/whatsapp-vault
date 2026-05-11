'use strict';

const path = require('path');
const fs   = require('fs');

// PM2's built-in env loading is inconsistent across Node versions — parse manually.
const envFile = path.join(__dirname, '.env');
const env     = {};

if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8')
    .split('\n')
    .forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq < 1) return;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    });
} else {
  console.warn('[ecosystem] Warning: .env file not found at', envFile);
}

module.exports = {
  apps: [
    {
      // One app — bot and dashboard share the SessionManager in this process.
      name:                      'vault',
      script:                    'bot/index.js',
      cwd:                       __dirname,
      env:                       env,
      max_memory_restart:        '800M',
      restart_delay:             5000,
      exp_backoff_restart_delay: 100,
      kill_timeout:              20000,
      log_date_format:           'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
