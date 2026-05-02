'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode               = require('qrcode-terminal');
const qrcodeLib            = require('qrcode');
const path                 = require('path');
const fs                   = require('fs');
const { execSync, spawnSync } = require('child_process');
const { EventEmitter }     = require('events');
const db                   = require('./database');

const AUTH_BASE     = path.join(__dirname, '..', '.wwebjs_auth');
const QR_TIMEOUT    = 5 * 60 * 1000;
const READY_TIMEOUT = 90 * 1000;
const RECONNECT_DELAY = 8 * 1000;

const CHROME_BIN =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
    .find(p => fs.existsSync(p));

const HARMLESS = [
  'Execution context was destroyed', 'Could not load response body',
  'ProtocolError', 'Target closed', 'Session closed',
];
const isHarmless = m => HARMLESS.some(s => m.includes(s));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function killChrome(userId) {
  // No shell wrapper: pkill is the only process containing the pattern, and
  // pkill excludes its own PID — so it can't self-match and kill its parent.
  // Exit codes: 0 = killed something, 1 = no match (both fine).
  const r = spawnSync('pkill', ['-9', '-f', `user-data-dir.*session-${userId}`], { stdio: 'ignore' });
  if (r.error) console.warn(`⚠️  pkill not available for user ${userId}: ${r.error.message}`);
  else if (r.status !== null && r.status > 1) console.warn(`⚠️  pkill exited ${r.status} for user ${userId}`);
}

function clearLock(userId) {
  try {
    const dir = path.join(AUTH_BASE, `session-${userId}`);
    if (!fs.existsSync(dir)) return;
    const scan = d => {
      for (const e of fs.readdirSync(d)) {
        const p = path.join(d, e);
        if (e === 'SingletonLock') { 
          try { fs.unlinkSync(p); } 
          catch (err) { console.warn(`⚠️  Failed to clear SingletonLock for user ${userId}:`, err.message); }
        }
        else { 
          try { if (fs.statSync(p).isDirectory()) scan(p); } 
          catch (err) { console.warn(`⚠️  Failed to scan directory for user ${userId}:`, err.message); }
        }
      }
    };
    scan(dir);
  } catch (err) { console.warn(`⚠️  Failed to clear lock for user ${userId}:`, err.message); }
}

// ── Session ──────────────────────────────────────────────────────────────────
class Session extends EventEmitter {
  constructor(userId, userName) {
    super();
    this.userId        = userId;
    this.userName      = userName;
    this.client        = null;
    this.qrTimer       = null;
    this.readyTimer    = null;
    this.booting       = false;
    this.stopping      = false;
    this.authenticated = false;
    this.status        = 'offline'; // 'offline' | 'qr' | 'online'
    this.qrData        = null;      // latest QR as base64 PNG data URL
    this.lateMediaQueue       = []; // Sequential queue for late media fetches. Sending several stickers in quick succession would otherwise schedule N parallel retry chains.
    this.processingLateMedia  = false;
  }

  async start() {
    if (this.booting || this.stopping) return;
    this.booting = true;

    killChrome(this.userId);
    await sleep(1500);
    clearLock(this.userId);

    const client = new Client({
      authStrategy: new LocalAuth({
        dataPath:  AUTH_BASE,
        clientId:  `session-${this.userId}`,
      }),
      puppeteer: {
        executablePath: CHROME_BIN,
        headless: true,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
          '--disable-gpu', '--disable-extensions', '--disable-background-networking',
          '--disable-default-apps', '--disable-sync', '--metrics-recording-only',
          '--mute-audio', '--no-default-browser-check', '--safebrowsing-disable-auto-update',
          '--js-flags=--max-old-space-size=500', '--memory-pressure-off',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        ],
      },
    });

    this.client = client;
    const isActive = () => this.client === client;

    client.on('qr', async qr => {
      if (!isActive() || this.status === 'online') return;
      clearTimeout(this.qrTimer);
      clearTimeout(this.readyTimer);
      this.readyTimer = null;

      // Convert QR string to base64 PNG for the dashboard
      try {
        this.qrData = await qrcodeLib.toDataURL(qr);
      } catch (err) { console.warn(`⚠️  Failed to generate QR data URL:`, err.message); this.qrData = null; }

      this._setStatus('qr');
      this.emit('qr', { userId: this.userId, qr: this.qrData });

      // Print full QR to terminal only on the first one. WhatsApp regenerates
      // the QR every ~20s and the dashboard always shows the latest, so spamming
      // the terminal with refreshes adds no value.
      if (!this._qrPrinted) {
        this._qrPrinted = true;
        qrcode.generate(qr, { small: true });
        console.log(`📱 [${this.userName}] Scan QR (5 min timeout)\n`);
      } else {
        console.log(`🔄 [${this.userName}] QR refreshed (use the dashboard, terminal only shows first one)\n`);
      }

      this.qrTimer = setTimeout(async () => {
        if (!isActive()) return;
        console.warn(`⏰ [${this.userName}] QR timeout — restarting\n`);
        await this._destroy();
        await sleep(RECONNECT_DELAY);
        setTimeout(() => this.start(), 0);
      }, QR_TIMEOUT);
    });

    client.on('authenticated', () => {
      if (!isActive()) return;

      // WhatsApp fires 'authenticated' multiple times in rapid succession
      // (often 5+ times within a second) — the flag below ensures we only
      // process the first one and ignore duplicates until reset.
      if (this.authenticated || this.status === 'online') return;
      this.authenticated = true;

      clearTimeout(this.qrTimer);
      clearTimeout(this.readyTimer);
      this.qrTimer    = null;
      this.readyTimer = null;
      this.qrData     = null;

      console.log(`🔐 [${this.userName}] Authenticated\n`);

      this.readyTimer = setTimeout(async () => {
        if (!isActive() || this.status === 'online') return;
        console.warn(`⏰ [${this.userName}] Ready timeout — restarting\n`);
        await this._destroy();
        await sleep(RECONNECT_DELAY);
        setTimeout(() => this.start(), 0);
      }, READY_TIMEOUT);
    });

    client.on('ready', async () => {
      if (!isActive() || this.status === 'online') return;

      // Set status FIRST so any pending readyTimer or duplicate 'ready' aborts
      this._setStatus('online');
      clearTimeout(this.qrTimer);
      clearTimeout(this.readyTimer);
      this.qrTimer = null; this.readyTimer = null;

      // Pull phone number from WhatsApp and update DB
      try {
        const info  = client.info;
        const phone = info?.wid?.user || null;
        const name  = info?.pushname  || this.userName;
        db.updateUser(this.userId, name, phone, 'online');
        this.userName = name;
      } catch (err) { console.warn(`⚠️  Failed to fetch WhatsApp info for user ${this.userId}:`, err.message); }

      db.setBotOnline();
      this.emit('ready', { userId: this.userId, name: this.userName });
      const s = db.getStats(this.userId);
      console.log(`✅ [${this.userName}] Live! ${s.total_messages} msgs\n`);
    });

    client.on('auth_failure', async msg => {
      if (!isActive()) return;
      console.error(`❌ [${this.userName}] Auth failed:`, msg);
      db.updateUser(this.userId, this.userName, null, 'offline');
      await this._destroy();
      try { fs.rmSync(path.join(AUTH_BASE, `session-${this.userId}`), { recursive: true, force: true }); } 
      catch (err) { console.warn(`⚠️  Failed to remove session files for user ${this.userId}:`, err.message); }
      await sleep(RECONNECT_DELAY);
      setTimeout(() => this.start(), 0);
    });

    client.on('disconnected', async reason => {
      if (!isActive() || this.stopping) return;
      console.log(`🔌 [${this.userName}] Disconnected (${reason})\n`);
      this._setStatus('offline');
      db.setBotOffline();
      await this._destroy();
      await sleep(RECONNECT_DELAY);
      setTimeout(() => this.start(), 0);
    });

    client.on('message',        msg => { if (isActive()) this._handleMessage(msg); });
    client.on('message_create', msg => { if (isActive() && msg.fromMe) this._handleMessage(msg); });

    console.log(`🚀 [${this.userName}] Starting...\n`);
    try {
      await client.initialize();
    } catch (err) {
      if (isHarmless(err.message)) {
        console.warn(`⚠️  [${this.userName}] Transient init error\n`);
        return;
      }
      const isOOM = err.message.includes('Failed to launch the browser process');
      console.error(`❌ [${this.userName}] Fatal init:`, err.message.split('\n')[0]);
      await this._destroy();
      await sleep(isOOM ? 30000 : RECONNECT_DELAY);
      setTimeout(() => this.start(), 0);
    }
  }

  async stop() {
    this.stopping = true;
    this._setStatus('offline');
    clearTimeout(this.qrTimer);
    clearTimeout(this.readyTimer);
    await this._destroy();
  }

  async _destroy() {
    clearTimeout(this.qrTimer);
    clearTimeout(this.readyTimer);
    this.qrTimer       = null;
    this.readyTimer    = null;
    this.booting       = false;
    this.authenticated = false;
    this._qrPrinted    = false;
    const c = this.client;
    this.client = null;
    if (!c) return;
    try { await c.destroy(); } catch (err) { console.warn(`⚠️  Failed to destroy client for user ${this.userId}:`, err.message); }
    await sleep(1500);
    killChrome(this.userId);
    clearLock(this.userId);
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', { userId: this.userId, status });
  }

  // ── Message handling ──────────────────────────────────────────────────────
  _handleMessage(msg) {
    if (this._shouldSkip(msg)) return;
    this._queue = this._queue || [];
    this._queue.push(msg);
    if (!this._processing) this._drain();
  }

  _shouldSkip(msg) {
    const SKIP = new Set(['e2e_notification','notification_template','notification','gp2','broadcast','protocol','undefined']);
    return SKIP.has(msg.type) || !msg.from || msg.from.includes('broadcast');
  }

  async _drain() {
    this._processing = true;
    while (this._queue && this._queue.length > 0) {
      await this._processMessage(this._queue.shift());
      if (this._queue.length > 0) await sleep(300);
    }
    this._processing = false;
  }

  async _processMessage(msg) {
    try {
      const chat    = await this._retry(() => msg.getChat());
      let   contact = null;
      try { contact = await this._retry(() => msg.getContact()); }
      catch (e) { if (e.message.includes('getAlternateUserWid') || e.message.includes('Invalid get call')) return; throw e; }

      const sender = contact?.pushname || contact?.name || contact?.number || msg.from?.split('@')[0] || 'Unknown';

      const entry = {
        wa_id:     msg.id?.id || null,
        chat_id:   chat.id._serialized,
        from_me:   msg.fromMe,
        sender,
        body:      msg.body      || null,
        type:      msg.type,
        timestamp: msg.timestamp,
        mediaData: null, mimetype: null,
        lat:       msg.location?.latitude  || null,
        lng:       msg.location?.longitude || null,
      };
      const chatInfo = { name: chat.name || sender, isGroup: chat.isGroup };

      if (msg.hasMedia) {
        try {
          const media = await this._retry(() => msg.downloadMedia(), 4, 1000);
          if (media) {
            entry.mediaData = media.data;
            entry.mimetype  = media.mimetype;
            console.log(`📦 [${this.userName}] Media downloaded: type=${msg.type} mime="${media.mimetype}" size=${(media.data||'').length} bytes`);
          }
        } catch (e) { console.warn(`⚠️  [${this.userName}] Media failed:`, e.message.split('\n')[0]); }
      }

      const { mediaFile, messageId } = db.saveMessage(this.userId, entry, chatInfo);
      // If message has media but it wasn't downloaded successfully
      // schedule retries to fetch it later.
      // This can happen when WhatsApp's CDN is slow to propagate media.
      if (msg.hasMedia && !mediaFile && messageId) {
        this._enqueueLateMediaFetch(msg, messageId, chatInfo);
      }
      const ICONS = { chat:'💬',ptt:'🎙️',audio:'🎵',image:'🖼️',video:'🎬',document:'📄',sticker:'🎭',location:'📍',vcard:'👤' };
      console.log(`${ICONS[msg.type]||'📨'} [${this.userName}/${chatInfo.name}] ${sender}: ${(entry.body||'<'+msg.type+'>').substring(0,60)}${mediaFile?' [saved]':''}`);

      // Emit for SSE notifications to dashboard
      this.emit('message', {
        userId:   this.userId,
        userName: this.userName,
        chatName: chatInfo.name,
        sender,
        body:     entry.body,
        type:     msg.type,
        fromMe:   msg.fromMe,
      });

    } catch (e) {
      if (e.message.includes('getAlternateUserWid') || e.message.includes('Invalid get call') || isHarmless(e.message)) return;
      console.error(`❌ [${this.userName}] Message error:`, e.message.split('\n')[0]);
    }
  }

  // Enqueue a message that needs a delayed media fetch. Bursts of stickers
  // pile up in this queue and are processed strictly one at a time.
  _enqueueLateMediaFetch(msg, messageId, chatInfo) {
    this.lateMediaQueue.push({ msg, messageId, chatInfo });
    if (!this.processingLateMedia) this._drainLateMediaQueue();
  }

  async _drainLateMediaQueue() {
    this.processingLateMedia = true;
    while (this.lateMediaQueue.length > 0) {
      if (this.stopping) break;
      const { msg, messageId, chatInfo } = this.lateMediaQueue.shift();
      const remaining = this.lateMediaQueue.length;
      if (remaining > 0) console.log(`⏳ [${this.userName}] Late-media queue: ${remaining + 1} pending`);

      // Try at increasing delays — covers fast CDN appearance and slow ones
      const delays = [3000, 8000, 20000];
      for (const delay of delays) {
        await sleep(delay);
        if (this.stopping) break;
        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            db.attachMediaToMessage(messageId, media.data, media.mimetype);
            console.log(`🔁 [${this.userName}] Late-fetched ${msg.type} for msg #${messageId}`);
            this.emit('message', {
              userId:   this.userId,
              userName: this.userName,
              chatName: chatInfo.name,
              sender:   chatInfo.name,
              body:     msg.body || null,
              type:     msg.type,
              fromMe:   msg.fromMe,
            });
            break;
          }
        } catch (err) { console.warn(`⚠️  Late-media retry failed (${delay}ms):`, err.message); }
      }
    }
    this.processingLateMedia = false;
  }

  async _retry(fn, attempts = 3, delay = 800) {
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) {
        const known = e.message.includes('getAlternateUserWid') || e.message.includes('Invalid get call');
        if (known) throw e;
        if (i < attempts - 1) { console.warn(`⚠️  Retry ${i+1}/${attempts}`); await sleep(delay * (i + 1)); }
        else throw e;
      }
    }
  }
}

// ── SessionManager ───────────────────────────────────────────────────────────
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // userId → Session
  }

  async startAll() {
    const users = db.getAllUsers();
    for (const user of users) {
      await this.startSession(user.id, user.name);
      await sleep(3000); // stagger startups to avoid RAM spike
    }
    if (users.length === 0) {
      console.log('ℹ️  No users yet — add one from the dashboard\n');
    }
  }

  async startSession(userId, userName) {
    if (this.sessions.has(userId)) return this.sessions.get(userId);
    const session = new Session(userId, userName);
    this.sessions.set(userId, session);

    // Bubble up events to the manager
    session.on('qr',      e => this.emit('qr',      e));
    session.on('ready',   e => this.emit('ready',   e));
    session.on('status',  e => this.emit('status',  e));
    session.on('message', e => this.emit('message', e));

    session.start(); // async — don't await, returns immediately
    return session;
  }

  async addUser(name) {
    const user    = db.createUser(name);
    const session = await this.startSession(user.id, user.name);
    return user;
  }

  async removeUser(userId) {
    const session = this.sessions.get(userId);
    if (session) {
      await session.stop();
      this.sessions.delete(userId);
    }
    // Remove session auth folder
    try { fs.rmSync(path.join(AUTH_BASE, `session-${userId}`), { recursive: true, force: true }); } 
    catch (err) { console.warn(`⚠️  Failed to remove session files for user ${userId}:`, err.message); }
    db.deleteUser(userId);
  }

  getSession(userId) { return this.sessions.get(userId); }

  getQR(userId) {
    const s = this.sessions.get(userId);
    return s ? s.qrData : null;
  }

  getStatus(userId) {
    const s = this.sessions.get(userId);
    return s ? s.status : 'offline';
  }

  async stopAll() {
    for (const session of this.sessions.values()) await session.stop();
    this.sessions.clear();
  }
}

module.exports = { SessionManager };