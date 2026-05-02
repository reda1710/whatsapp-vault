'use strict';

// ── Single-process entry point ──────────────────────────────────────────────
// We run the bot and the dashboard in ONE Node process so they share the same
// SessionManager instance (PM2 with two separate apps would create two managers
// fighting over the same Chrome session folders, plus the dashboard server
// would never receive bot events because they live in different processes).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { SessionManager } = require('./session-manager');
const db = require('./database');

const CHROME_BIN =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
    .find(p => fs.existsSync(p));

if (!CHROME_BIN) {
  console.error('❌ Chrome/Chromium not found. Run: sudo apt install -y google-chrome-stable');
  process.exit(1);
}

console.log('\n╔════════════════════════════════╗');
console.log('║    WhatsApp Vault Bot v2.0     ║');
console.log('╚════════════════════════════════╝');
console.log(`🌍 Chrome: ${CHROME_BIN}\n`);

const manager = new SessionManager();
require('./manager-instance').setManager(manager);
module.exports = { manager };

// Boot the dashboard server in the same process
require('../dashboard/server');

function logRam() {
  const nodeMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  let chromeMB = 0;
  try {
    const out = execSync(
      'ps -eo rss,comm | grep -i "chrome\\|chromium" | awk \'{s+=$1} END {print s+0}\'',
      { encoding: 'utf8', shell: true }
    );
    chromeMB = Math.round((parseInt(out.trim()) || 0) / 1024);
  } catch (_) {}

  const totalMB = nodeMB + chromeMB;
  console.log(`🧠 RAM — node: ${nodeMB} MB  chrome: ${chromeMB} MB  total: ${totalMB} MB\n`);
}

// Start all existing sessions (after the dashboard is listening)
manager.startAll().catch(e => console.error('Startup error:', e));
const ramInterval = setInterval(logRam, 300_000);

// ── Graceful shutdown ────────────────────────────────────────────────────────
let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`\n👋 ${sig} — shutting down...`);
  clearInterval(ramInterval);
  db.setBotOffline();
  await manager.stopAll();
  console.log('✅ Done.\n');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', reason => {
  const m = reason?.message || String(reason);
  const harmless = ['Execution context was destroyed','Could not load response body','ProtocolError','Session closed','Target closed'].some(s => m.includes(s));
  if (!harmless) console.error('⚠️  Unhandled rejection:', m.split('\n')[0]);
});
