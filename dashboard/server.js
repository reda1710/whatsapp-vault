'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const db = require('../bot/database');
// Get the manager from the shared instance module (avoids circular require with bot/index)
const { getManager } = require('../bot/manager-instance');
const manager = getManager();

const PORT    = parseInt(process.env.PORT || '3001', 10);
const API_KEY = process.env.DASHBOARD_API_KEY;

if (!API_KEY) {
  console.error('❌ DASHBOARD_API_KEY is not set. Add it to your .env file.');
  console.error('   Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

if (API_KEY === 'REPLACE_WITH_YOUR_OWN_KEY') {
  console.error('❌ DASHBOARD_API_KEY is still the placeholder. Generate a real key:');
  console.error('   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// Log a fingerprint of the key (first 4 + last 4 chars) so you can verify
// it matches what you typed into the dashboard, without exposing the full key.
const keyFingerprint = API_KEY.length >= 12
  ? `${API_KEY.slice(0, 4)}...${API_KEY.slice(-4)} (${API_KEY.length} chars)`
  : '(too short — should be 64 chars)';
console.log(`🔑 API key loaded: ${keyFingerprint}`);

const app = express();
// cors({ origin: false }) — intentional: dashboard is always same-origin.
// For local dev on a different port, change to cors({ origin: 'http://localhost:PORT' })
app.use(cors({ origin: false }));
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // No build step / asset hashing — disable the browser cache for our
    // HTML/CSS/JS so deploys don't strand users on stale code.
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  }
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use('/api', (req, res, next) => {
  // SSE uses query string key since EventSource can't send custom headers
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── SSE — real-time events to dashboard ──────────────────────────────────────
const sseClients = new Set();

// ── Rate limiting ────────────────────────────────────────────────────────────
const searchRateLimitMap = new Map(); // userId → [timestamps...]
const SEARCH_LIMIT = 30; // max searches
const SEARCH_WINDOW_MS = 60000; // per 60 seconds

function checkSearchRateLimit(userId) {
  const now = Date.now();
  let timestamps = searchRateLimitMap.get(userId) || [];
  timestamps = timestamps.filter(t => now - t < SEARCH_WINDOW_MS);
  if (timestamps.length >= SEARCH_LIMIT) return false;
  timestamps.push(now);
  searchRateLimitMap.set(userId, timestamps);
  return true;
}

// Purge entries for users who have had no searches in the last window
setInterval(() => {
  const cutoff = Date.now() - SEARCH_WINDOW_MS;
  for (const [userId, timestamps] of searchRateLimitMap) {
    if (timestamps.every(t => t < cutoff)) searchRateLimitMap.delete(userId);
  }
}, SEARCH_WINDOW_MS);

function sendSSE(client, event, data) {
  try { client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch (err) { console.warn(`⚠️  SSE write failed (${event}):`, err.message); }
}

function broadcast(event, data) {
  for (const c of sseClients) sendSSE(c, event, data);
}

// Wire manager events → SSE broadcast
manager.on('qr',         data => broadcast('qr',         data));
manager.on('ready',      data => broadcast('ready',      data));
manager.on('status',     data => broadcast('status',     data));
manager.on('message',    data => broadcast('message',    data));
manager.on('qr_timeout', data => broadcast('qr_timeout', data));

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send current user statuses immediately on connect
  const users = db.getAllUsers();
  for (const u of users) {
    sendSSE(res, 'status', { userId: u.id, status: manager.getStatus(u.id) });
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Keep-alive ping every 25s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch (err) { console.warn(`⚠️  SSE ping failed:`, err.message); clearInterval(ping); }
  }, 25000);
  req.on('close', () => clearInterval(ping));
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  try {
    const users = db.getAllUsers().map(u => ({
      ...u,
      status: manager.getStatus(u.id),
    }));
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/users', async (req, res) => {
  try {
    const name = (req.body?.name || 'User').trim().slice(0, 50);
    const user = await manager.addUser(name);
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// Lazy reconnect — start Chrome and let WhatsApp Web fire 'qr' or go straight
// to 'authenticated' (if cached auth is still valid). Used when the user clicks
// the Reconnect banner for an account in the 'qr' (red dot) state.
app.post('/api/users/:id/connect', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const session = await manager.startSession(id);
    if (!session) return res.status(404).json({ error: 'not found' });
    res.json({ status: 'starting' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stop Chrome but keep the user record. Called when the user closes the QR
// modal without scanning — we want the dropdown dot to stay red ('qr'),
// not gray ('offline'), so the Reconnect banner remains visible.
app.post('/api/users/:id/disconnect', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await manager.disconnectSession(id);
    res.json({ status: 'disconnected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel a pending QR session — only removes the user if they never authenticated.
// Safe to call when the user dismisses the QR modal before scanning.
app.post('/api/users/:id/cancel', async (req, res) => {
  try {
    const id      = parseInt(req.params.id, 10);
    const session = manager.getSession(id);
    if (!session) return res.json({ removed: false, reason: 'not_found' });

    // If the session has already authenticated (i.e. this is a reconnect),
    // just leave it running — the user dismissed the modal but is still tracked.
    if (session.authenticated || session.status === 'online') {
      return res.json({ removed: false, reason: 'already_authenticated' });
    }

    // Brand-new user who never scanned — stop Chrome and clean up.
    await manager.removeUser(id);
    res.json({ removed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await manager.removeUser(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id/qr', (req, res) => {
  try {
    const id  = parseInt(req.params.id, 10);
    const qr  = manager.getQR(id);
    const status = manager.getStatus(id);
    res.json({ qr, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot status ────────────────────────────────────────────────────────────────
app.get('/api/bot-status', (req, res) => {
  try { res.json(db.getBotStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    res.json(userId ? db.getStats(userId) : db.getGlobalStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chats ─────────────────────────────────────────────────────────────────────
app.get('/api/chats', (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(db.getChats(userId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/chats/:chatId/messages', (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const limit  = parseInt(req.query.limit || '50', 10) || 50;
    const offset = parseInt(req.query.offset || '0', 10);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(db.getMessages(userId, decodeURIComponent(req.params.chatId), limit, offset));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Contact profile ───────────────────────────────────────────────────────────
// Latest stored snapshot. No WhatsApp call.
app.get('/api/chats/:chatId/profile', (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const chatId = decodeURIComponent(req.params.chatId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(db.getLatestProfile(userId, chatId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Active fetch from WhatsApp. Dedupes against the last stored row — only writes
// a new version (and a new file on disk) if something actually changed.
app.post('/api/chats/:chatId/profile/refresh', async (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const chatId = decodeURIComponent(req.params.chatId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const session = manager.getSession(userId);
    if (!session?.client) return res.status(503).json({ error: 'Session offline' });
    const row = await session.refreshProfile(chatId);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full version timeline for the modal's history view.
app.get('/api/chats/:chatId/profile/history', (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const chatId = decodeURIComponent(req.params.chatId);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(db.getProfileHistory(userId, chatId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    const q      = (req.query.q || '').trim();
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Rate limit: max 30 searches per 60s per user
    if (!checkSearchRateLimit(userId)) {
      return res.status(429).json({ error: 'Search rate limit exceeded (30 per 60s)' });
    }

    res.json(q ? db.searchMessages(userId, q) : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Media ─────────────────────────────────────────────────────────────────────
// Express's default Content-Type detection mis-maps .ogg as application/ogg
// and treats some audio files as octet-stream, both of which break <audio>
// playback in the browser. We set Content-Type explicitly per extension.
const MIME_MAP = {
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.wav':  'audio/wav',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.pdf':  'application/pdf',
};

app.get('/api/media/:filename', (req, res) => {
  const p = db.getMediaPath(req.params.filename);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File not found' });

  // Try DB-stored mimetype first (most accurate), fall back to extension lookup.
  let mime = db.getMimetypeForFile(req.params.filename);
  if (mime) mime = String(mime).split(';')[0].trim();
  if (!mime) {
    const ext = path.extname(p).toLowerCase();
    mime = MIME_MAP[ext];
  }
  if (mime) res.setHeader('Content-Type', mime);

  // Get file size for range support
  const stat = fs.statSync(p);
  const fileSize = stat.size;

  // Handle HTTP range requests (for seeking in media players, resumable downloads)
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Validate range
    if (isNaN(start) || start < 0 || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Range not satisfiable' });
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', end - start + 1);
    res.setHeader('Accept-Ranges', 'bytes');
    const stream = fs.createReadStream(p, { start, end });
    stream.pipe(res);
  } else {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', fileSize);
    res.sendFile(p);
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────
app.delete('/api/messages', (req, res) => {
  try {
    const userId = parseInt(req.body?.userId, 10);
    const ids    = req.body?.ids;
    if (!userId || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'userId and ids required' });
    res.json(db.deleteMessages(userId, ids));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/chats/:chatId', (req, res) => {
  try {
    const userId = parseInt(req.query.userId, 10);
    if (!userId) return res.status(400).json({ error: 'userId required' });
    res.json(db.deleteChat(userId, decodeURIComponent(req.params.chatId)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, '0.0.0.0', () => console.log(`\n🌐 Dashboard: http://0.0.0.0:${PORT}\n`));
