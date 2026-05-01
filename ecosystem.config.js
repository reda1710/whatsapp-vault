'use strict';

const path = require('path');
const fs   = require('fs');

// Read .env manually so PM2 can inject variables reliably across all Node versions.
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
      // Single unified app — bot AND dashboard run in this process so they
      // share the SessionManager instance and one Chrome session per user.
      name:                      'vault',
      script:                    'bot/index.js',
      cwd:                       __dirname,
      env:                       env,
      max_memory_restart:        '900M',
      restart_delay:             5000,
      exp_backoff_restart_delay: 100,
      log_date_format:           'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
