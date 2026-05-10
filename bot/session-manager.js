'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode               = require('qrcode-terminal');
const qrcodeLib            = require('qrcode');
const https                = require('https');
const path                 = require('path');
const fs                   = require('fs');
const { execSync, spawnSync } = require('child_process');
const { EventEmitter }     = require('events');
const db                   = require('./database');

const AUTH_BASE     = path.join(__dirname, '..', '.wwebjs_auth');
const QR_TIMEOUT    = 5 * 60 * 1000;
const READY_TIMEOUT = 160 * 1000;
const RECONNECT_DELAY = 8 * 1000;
const PROFILE_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const PROFILE_REFRESH_DELAY_MS    = 60 * 1000;      // first sweep after ready (let WA finish syncing)
const PROFILE_REFRESH_THROTTLE_MS = 500;            // between individual chat refreshes

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

// Cap to keep an unexpectedly large response from blowing up memory; profile
// pics are normally < 100 KB, but the URL could in theory point anywhere.
const MAX_PROFILE_PIC_BYTES = 5 * 1024 * 1024;

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      // Follow simple 3xx redirects (WhatsApp's CDN rarely uses them, but cheap to handle).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadBuffer(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > MAX_PROFILE_PIC_BYTES) {
          req.destroy(new Error('profile pic too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('profile pic fetch timeout')));
  });
}

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
    this.status        = 'offline'; // 'offline' | 'qr' | 'authenticated' | 'online'
    this.qrData        = null;      // latest QR as base64 PNG data URL
    this.lateMediaQueue       = []; // Sequential queue for late media fetches. Sending several stickers in quick succession would otherwise schedule N parallel retry chains.
    this.processingLateMedia  = false;
    this._profileInflight     = new Map(); // chatId → Promise — dedupes concurrent refreshProfile calls
    this.profileRefreshTimer  = null;      // recurring sweep timer (setTimeout, recursive)
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
        console.warn(`⏰ [${this.userName}] QR timeout — stopping Chrome (lazy: waiting for user to reconnect)\n`);
        await this._destroy();
        // status stays 'qr' (red dot); emit so any open modal closes
        this.emit('qr_timeout', { userId: this.userId });
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

      this._setStatus('authenticated');
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

      // Kick off the recurring profile sweep. First run after a short delay so
      // WA finishes the initial chat sync before we start hammering it.
      this._scheduleProfileRefresh();
    });

    client.on('auth_failure', async msg => {
      if (!isActive()) return;
      console.error(`❌ [${this.userName}] Auth failed:`, msg);
      await this._destroy();
      try { fs.rmSync(path.join(AUTH_BASE, `session-${this.userId}`), { recursive: true, force: true }); }
      catch (err) { console.warn(`⚠️  Failed to remove session files for user ${this.userId}:`, err.message); }
      // Lazy: stay in 'qr' (red dot), wait for user to click Reconnect
      this._setStatus('qr');
      db.updateUser(this.userId, this.userName, null, 'qr');
    });

    client.on('disconnected', async reason => {
      if (!isActive() || this.stopping) return;
      console.log(`🔌 [${this.userName}] Disconnected (${reason})\n`);
      // Lazy: red dot in dropdown, no Chrome until user clicks Reconnect
      this._setStatus('qr');
      db.setBotOffline();
      await this._destroy();
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
    clearTimeout(this.profileRefreshTimer);
    this.qrTimer             = null;
    this.readyTimer          = null;
    this.profileRefreshTimer = null;
    this.booting             = false;
    this.authenticated       = false;
    this._qrPrinted          = false;
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

  // Pull the contact/group profile from WhatsApp Web, dedupe against the last
  // stored snapshot, and return the latest version row. Concurrent calls for
  // the same chat share one in-flight promise so a click-spam can't fan out.
  async refreshProfile(chatId) {
    if (!this.client) throw new Error('Session offline');
    if (this._profileInflight.has(chatId)) return this._profileInflight.get(chatId);
    const promise = this._doRefreshProfile(chatId)
      .finally(() => this._profileInflight.delete(chatId));
    this._profileInflight.set(chatId, promise);
    return promise;
  }

  async _doRefreshProfile(chatId) {
    const chat = await this._retry(() => this.client.getChatById(chatId));

    let picUrl = null;
    try { picUrl = await this.client.getProfilePicUrl(chatId); }
    catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] getProfilePicUrl(${chatId}) failed:`, e.message.split('\n')[0]); }

    let about = null, description = null, isBusiness = false, phone = null, participants = null;
    if (chat.isGroup) {
      description = chat.description || chat.groupMetadata?.desc || null;
      const raw = chat.participants || chat.groupMetadata?.participants;
      if (Array.isArray(raw)) {
        const base = raw.map(p => ({
          id:           p?.id?._serialized || (typeof p?.id === 'string' ? p.id : null),
          isAdmin:      !!p?.isAdmin,
          isSuperAdmin: !!p?.isSuperAdmin,
        })).filter(p => p.id);

        // Resolve the real E.164 phone for each participant. Required because
        // WhatsApp Web increasingly hands out @lid ids whose user-part is NOT
        // the phone number — only Contact.number gives the real one. These
        // are local-store lookups, so parallel fan-out is fine.
        participants = await Promise.all(base.map(async p => {
          let number = null;
          try {
            const c = await this.client.getContactById(p.id);
            try {
              const fmt = await c.getFormattedNumber();
              if (fmt) number = fmt.replace(/[\s()\-]/g, '') || null;
            } catch {}
            if (!number) {
              number = (c?.id?.server === 'c.us' ? c?.number || c?.id?.user : null) || null;
            }
          } catch {/* contact not in store yet — leave null */}
          return { ...p, number };
        }));
      }
    } else {
      try {
        const contact = await chat.getContact();
        isBusiness = !!contact?.isBusiness;
        // getFormattedNumber() does a real WA API lookup — it returns the actual
        // phone (e.g. "+1 (234) 5678-901") regardless of id format, so use it first.
        // contact.number for @lid contacts returns the lid user-part (NOT a
        // phone), so only trust it when the contact's own server is 'c.us'.
        try {
          const fmt = await contact.getFormattedNumber();
          if (fmt) phone = fmt.replace(/[\s()\-]/g, '') || null;
        } catch { /* not available in this wwebjs build */ }
        if (!phone) {
          phone = (contact?.id?.server === 'c.us' ? contact?.number || contact?.id?.user : null)
               || (chat?.id?.server    === 'c.us' ? chat?.id?.user : null)
               || null;
        }
        try { about = await contact.getAbout(); }
        catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] getAbout(${chatId}) failed:`, e.message.split('\n')[0]); }
      } catch (e) {
        if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] getContact(${chatId}) failed:`, e.message.split('\n')[0]);
      }
    }

    let picBytes = null;
    if (picUrl) {
      try { picBytes = await downloadBuffer(picUrl); }
      catch (e) { console.warn(`⚠️  [${this.userName}] profile-pic download failed:`, e.message); }
    }

    return db.saveProfileVersion(this.userId, chatId, {
      picBytes,
      name: chat.name || null,
      phone,
      about,
      description,
      isBusiness,
      participants,
    });
  }

  // ── Background profile-refresh scheduler ────────────────────────────────
  // setTimeout-recursive (not setInterval) so a slow sweep can't overlap
  // with the next tick. Idempotent — calling again replaces any existing timer.
  _scheduleProfileRefresh() {
    if (this.profileRefreshTimer) clearTimeout(this.profileRefreshTimer);
    const tick = async () => {
      if (this.stopping || !this.client) return;
      try { await this._refreshAllProfiles(); }
      catch (e) { console.warn(`⚠️  [${this.userName}] profile sweep failed:`, e.message.split('\n')[0]); }
      if (this.stopping || !this.client) return;
      this.profileRefreshTimer = setTimeout(tick, PROFILE_REFRESH_INTERVAL_MS);
    };
    this.profileRefreshTimer = setTimeout(tick, PROFILE_REFRESH_DELAY_MS);
  }

  // Two-phase sweep: refresh every chat, then refresh every unique group
  // participant that wasn't already a top-level chat. refreshProfile dedupes
  // both content-wise (no rewrite if unchanged) and in-flight-wise (shares the
  // outstanding Promise with any concurrent user click).
  async _refreshAllProfiles() {
    const chats = db.getChats(this.userId);
    if (chats.length === 0) return;
    console.log(`🔄 [${this.userName}] Profile sweep: ${chats.length} chats`);

    const refreshedIds = new Set();

    for (const c of chats) {
      if (this.stopping || !this.client) return;
      try { await this.refreshProfile(c.chat_id); refreshedIds.add(c.chat_id); }
      catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] profile refresh ${c.chat_id} failed:`, e.message.split('\n')[0]); }
      await sleep(PROFILE_REFRESH_THROTTLE_MS);
    }

    const memberIds = new Set();
    for (const c of chats) {
      if (!c.is_group) continue;
      const latest = db.getLatestProfile(this.userId, c.chat_id);
      if (!latest?.participants) continue;
      try {
        const arr = JSON.parse(latest.participants);
        for (const p of arr) {
          if (p?.id && !refreshedIds.has(p.id)) memberIds.add(p.id);
        }
      } catch { /* malformed JSON — skip */ }
    }

    if (memberIds.size > 0) {
      console.log(`🔄 [${this.userName}] Member sweep: ${memberIds.size} unique participants`);
      for (const mid of memberIds) {
        if (this.stopping || !this.client) return;
        try { await this.refreshProfile(mid); }
        catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] member refresh ${mid} failed:`, e.message.split('\n')[0]); }
        await sleep(PROFILE_REFRESH_THROTTLE_MS);
      }
    }

    console.log(`✅ [${this.userName}] Profile sweep done (${refreshedIds.size} chats + ${memberIds.size} members)`);
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
    let session = this.sessions.get(userId);
    if (session && session.client) return session; // already running with live Chrome
    if (!session) {
      // userName is required for brand-new sessions; for reconnects we can fall back to DB
      if (!userName) {
        const u = db.getAllUsers().find(x => x.id === userId);
        if (!u) return null;
        userName = u.name;
      }
      session = new Session(userId, userName);
      this.sessions.set(userId, session);

      // Bubble up events to the manager
      session.on('qr',         e => this.emit('qr',         e));
      session.on('ready',      e => this.emit('ready',      e));
      session.on('status',     e => this.emit('status',     e));
      session.on('message',    e => this.emit('message',    e));
      session.on('qr_timeout', e => this.emit('qr_timeout', e));
    }
    session.start(); // async — don't await, returns immediately
    return session;
  }

  // Stop Chrome but keep the user record. Used when the user closes the QR
  // modal without scanning — we want the dropdown to stay red ('qr'), not
  // gray ('offline'), so the Reconnect banner remains visible.
  async disconnectSession(userId) {
    const s = this.sessions.get(userId);
    if (!s) return;
    s.stopping = true;
    s._setStatus('qr');
    await s._destroy();
    s.stopping = false;
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