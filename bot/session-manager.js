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
const PROFILE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
// Delay before the first sweep so WA finishes its initial chat sync.
const PROFILE_REFRESH_DELAY_MS    = 60 * 1000;
const PROFILE_REFRESH_THROTTLE_MS = 500;

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

// Cap on response size — pic URLs are signed but could in theory point anywhere.
const MAX_PROFILE_PIC_BYTES = 5 * 1024 * 1024;

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
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
  // No shell wrapper: pkill excludes its own PID so it can't self-match.
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
    this.qrData        = null;
    // Serialized so a burst of stickers can't spawn N parallel retry chains.
    this.lateMediaQueue       = [];
    this.processingLateMedia  = false;
    this._profileInflight     = new Map(); // chatId → in-flight refresh promise
    this.profileRefreshTimer  = null;
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
      // Cache the WA Web bundle locally so a CDN blip can't strand boot.
      webVersionCache: { type: 'local' },
      // Pin a known-good WA Web build here if upgrades start breaking.
      // webVersion: '2.3000.x',
      // Reclaim a session that's been opened in another tab. Pair with takeoverTimeoutMs.
      // takeoverOnConflict: true,
      // takeoverTimeoutMs: 10_000,
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

      try {
        this.qrData = await qrcodeLib.toDataURL(qr);
      } catch (err) { console.warn(`⚠️  Failed to generate QR data URL:`, err.message); this.qrData = null; }

      this._setStatus('qr');
      this.emit('qr', { userId: this.userId, qr: this.qrData });

      // WA regenerates the QR every ~20s; print only the first one — the
      // dashboard always shows the latest.
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
        // Status stays 'qr' (red dot); emit so any open modal closes.
        this.emit('qr_timeout', { userId: this.userId });
      }, QR_TIMEOUT);
    });

    client.on('authenticated', () => {
      if (!isActive()) return;

      // WA fires 'authenticated' 5+ times within a second; ignore duplicates.
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

      // Set status before any awaits so a duplicate 'ready' aborts.
      this._setStatus('online');
      clearTimeout(this.qrTimer);
      clearTimeout(this.readyTimer);
      this.qrTimer = null; this.readyTimer = null;

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

      this._scheduleProfileRefresh();
    });

    client.on('auth_failure', async msg => {
      if (!isActive()) return;
      console.error(`❌ [${this.userName}] Auth failed:`, msg);
      await this._destroy();
      try { fs.rmSync(path.join(AUTH_BASE, `session-${this.userId}`), { recursive: true, force: true }); }
      catch (err) { console.warn(`⚠️  Failed to remove session files for user ${this.userId}:`, err.message); }
      // Stay in 'qr' so the Reconnect banner stays visible until the user acts.
      this._setStatus('qr');
      db.updateUser(this.userId, this.userName, null, 'qr');
    });

    client.on('disconnected', async reason => {
      if (!isActive() || this.stopping) return;
      console.log(`🔌 [${this.userName}] Disconnected (${reason})\n`);
      this._setStatus('qr');
      db.setBotOffline();
      await this._destroy();
    });

    client.on('message',        msg => { if (isActive()) this._handleMessage(msg); });
    client.on('message_create', msg => { if (isActive() && msg.fromMe) this._handleMessage(msg); });

    // recordEdit/recordRevoke no-op if the original wasn't captured (e.g. it
    // arrived before the bot started).
    client.on('message_edit', (msg, newBody, prevBody) => {
      if (!isActive()) return;
      const waId = msg?.id?.id || null;
      if (!waId) return;
      try {
        const r = db.recordEdit(this.userId, waId, prevBody, newBody, msg.timestamp || Math.floor(Date.now()/1000));
        if (r.found) this.emit('message_edit', { userId: this.userId, waId, newBody, prevBody });
      } catch (e) { console.warn(`⚠️  [${this.userName}] edit capture failed:`, e.message.split('\n')[0]); }
    });

    client.on('message_revoke_everyone', (after, before) => {
      if (!isActive()) return;
      const waId = before?.id?.id || after?.id?.id || null;
      if (!waId) return;
      try {
        const r = db.recordRevoke(this.userId, waId, Math.floor(Date.now()/1000));
        if (r.found) this.emit('message_revoke', { userId: this.userId, waId });
      } catch (e) { console.warn(`⚠️  [${this.userName}] revoke capture failed:`, e.message.split('\n')[0]); }
    });

    // reaction === '' means the user removed their reaction; we still upsert
    // so the row reflects the current state.
    client.on('message_reaction', r => {
      if (!isActive() || !r) return;
      const msgWaId = r.msgId?.id || r.msgId?._serialized?.split('_').pop() || null;
      const senderId = r.senderId || (r.id?.fromMe ? 'me' : r.id?.remote) || null;
      if (!msgWaId || !senderId) return;
      try {
        db.recordReaction(this.userId, msgWaId, senderId, r.reaction || '', r.timestamp);
        this.emit('reaction', { userId: this.userId, msgWaId });
      } catch (e) { console.warn(`⚠️  [${this.userName}] reaction capture failed:`, e.message.split('\n')[0]); }
    });

    // ack: -1=err, 0=pending, 1=server, 2=device, 3=read, 4=played.
    client.on('message_ack', (msg, ack) => {
      if (!isActive()) return;
      const waId = msg?.id?.id || null;
      if (!waId) return;
      try { db.recordAck(this.userId, waId, ack); }
      catch (e) { /* ack churn isn't worth log noise */ }
    });

    client.on('vote_update', vote => {
      if (!isActive() || !vote) return;
      const pollWaId = vote.parentMsgKey?.id || vote.parentMessage?.id?.id || null;
      const voterId  = vote.voter || null;
      if (!pollWaId || !voterId) return;
      try {
        db.recordPollVote(this.userId, pollWaId, voterId, vote.selectedOptions || [], vote.interractedAtTs || Math.floor(Date.now()/1000));
        this.emit('vote_update', { userId: this.userId, pollWaId });
      } catch (e) { console.warn(`⚠️  [${this.userName}] vote capture failed:`, e.message.split('\n')[0]); }
    });

    const onGroupNotif = (type) => (n) => {
      if (!isActive() || !n) return;
      try {
        db.recordGroupEvent(this.userId, {
          chat_id:    n.chatId || n.id?.remote || null,
          event_type: type,
          actor_id:   n.author || n.id?.participant || null,
          target_ids: Array.isArray(n.recipientIds) ? n.recipientIds : null,
          body:       n.body || null,
          timestamp:  n.timestamp || Math.floor(Date.now()/1000),
        });
      } catch (e) { console.warn(`⚠️  [${this.userName}] group_${type} capture failed:`, e.message.split('\n')[0]); }
    };
    client.on('group_join',                onGroupNotif('join'));
    client.on('group_leave',               onGroupNotif('leave'));
    client.on('group_update',              onGroupNotif('update'));
    client.on('group_admin_changed',       onGroupNotif('admin_change'));
    client.on('group_membership_request',  onGroupNotif('membership_request'));

    client.on('contact_changed', (msg, oldId, newId, isContact) => {
      if (!isActive()) return;
      try { db.recordContactChange(this.userId, oldId, newId, isContact, msg?.timestamp); }
      catch (e) { console.warn(`⚠️  [${this.userName}] contact_changed capture failed:`, e.message.split('\n')[0]); }
    });

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

  // Archive the message to the DB. Reused by both live events and the
  // fetchMessages-driven sweep. Skips live-only side effects (SSE toast,
  // late-media retry queue) when source !== 'live'.
  async _archiveMessage(msg, opts = {}) {
    const isLive = opts.source !== 'backfill';
    try {
      const chat    = await this._retry(() => msg.getChat());
      let   contact = null;
      try { contact = await this._retry(() => msg.getContact()); }
      catch (e) { if (e.message.includes('getAlternateUserWid') || e.message.includes('Invalid get call')) return null; throw e; }

      const sender = contact?.pushname || contact?.name || contact?.number || msg.from?.split('@')[0] || 'Unknown';

      const entry = {
        wa_id:         msg.id?.id          || null,
        wa_serialized: msg.id?._serialized || null,
        chat_id:       chat.id._serialized,
        from_me:       msg.fromMe,
        sender,
        body:          msg.body            || null,
        type:          msg.type,
        timestamp:     msg.timestamp,
        mediaData: null, mimetype: null,
        lat:           msg.location?.latitude  || null,
        lng:           msg.location?.longitude || null,
        // Bare id of the parent message — joins back to messages.wa_id.
        quoted_wa_id:  msg.hasQuotedMsg ? (msg.rawData?.quotedStanzaID || null) : null,
        mentions:      (msg.mentionedIds && msg.mentionedIds.length) ? JSON.stringify(msg.mentionedIds) : null,
        is_forwarded:  msg.isForwarded ? 1 : 0,
        forward_score: msg.forwardingScore || null,
        is_ephemeral:  msg.isEphemeral ? 1 : 0,
        is_status:     msg.isStatus ? 1 : 0,
        vcards:        (msg.vCards && msg.vCards.length) ? JSON.stringify(msg.vCards) : null,
        loc_name:      msg.location?.name        || msg.location?.options?.name    || null,
        loc_address:   msg.location?.address     || msg.location?.options?.address || null,
        loc_url:       msg.location?.url         || msg.location?.options?.url     || null,
      };
      const chatInfo = { name: chat.name || sender, isGroup: chat.isGroup };

      // Call-log fields mirror the Call class (https://docs.wwebjs.dev/Call.html).
      // msg.duration is documented; the rawData fields are best-effort.
      if (msg.type === 'call_log') {
        const d = msg.rawData || {};
        entry.call_is_video     = (d.isVideoCall || d.callIsVideo) ? 1 : 0;
        const docDuration = msg.duration != null ? parseInt(msg.duration, 10) : NaN;
        entry.call_duration_sec = Number.isFinite(docDuration) ? docDuration
                                : typeof d.callDuration === 'number' ? d.callDuration
                                : null;
        entry.call_participants = Array.isArray(d.callParticipants) && d.callParticipants.length
                                ? JSON.stringify(d.callParticipants) : null;
      }

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

      // Live-only: schedule a late-media retry. For backfill the CDN URL is
      // almost certainly expired — retries would just waste time.
      if (isLive && msg.hasMedia && !mediaFile && messageId) {
        this._enqueueLateMediaFetch(msg, messageId, chatInfo);
      }

      if (msg.type === 'poll_creation' && entry.wa_id) {
        const opts = (msg.pollOptions || msg.options || []).map(o => o?.name || o?.localId?.toString() || String(o));
        if (opts.length) db.recordPollOptions(this.userId, entry.wa_id, opts);
      }

      const ICONS = { chat:'💬',ptt:'🎙️',audio:'🎵',image:'🖼️',video:'🎬',document:'📄',sticker:'🎭',location:'📍',vcard:'👤',call_log:'📞' };
      const tag = isLive ? '' : ' [backfill]';
      console.log(`${ICONS[msg.type]||'📨'} [${this.userName}/${chatInfo.name}]${tag} ${sender}: ${(entry.body||'<'+msg.type+'>').substring(0,60)}${mediaFile?' [saved]':''}`);

      return { messageId, mediaFile, entry, chatInfo, sender };
    } catch (e) {
      if (e.message.includes('getAlternateUserWid') || e.message.includes('Invalid get call') || isHarmless(e.message)) return null;
      console.error(`❌ [${this.userName}] Archive error:`, e.message.split('\n')[0]);
      return null;
    }
  }

  async _processMessage(msg) {
    const result = await this._archiveMessage(msg, { source: 'live' });
    if (!result) return;
    const { entry, chatInfo, sender } = result;
    this.emit('message', {
      userId:   this.userId,
      userName: this.userName,
      chatName: chatInfo.name,
      sender,
      body:     entry.body,
      type:     msg.type,
      fromMe:   msg.fromMe,
    });
  }

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

  // Concurrent calls for the same chat share one in-flight promise so a
  // click-spam can't fan out.
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
    // '0@c.us' and similar all-zero placeholders hang the WA Web JS call
    // until Puppeteer's protocolTimeout fires. Skip those only.
    const userPart = String(chatId || '').split('@')[0];
    if (userPart && !/^0+$/.test(userPart)) {
      try { picUrl = await this.client.getProfilePicUrl(chatId); }
      catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] getProfilePicUrl(${chatId}) failed:`, e.message.split('\n')[0]); }
    }

    let about = null, description = null, isBusiness = false, phone = null, participants = null;
    let pushname = null, shortName = null, businessProfile = null;
    if (chat.isGroup) {
      description = chat.description || chat.groupMetadata?.desc || null;
      const raw = chat.participants || chat.groupMetadata?.participants;
      if (Array.isArray(raw)) {
        const base = raw.map(p => ({
          id:           p?.id?._serialized || (typeof p?.id === 'string' ? p.id : null),
          isAdmin:      !!p?.isAdmin,
          isSuperAdmin: !!p?.isSuperAdmin,
        })).filter(p => p.id);

        // @lid ids' user-part is not the phone number — only the Contact
        // record carries the real one. Local-store lookups, fan out freely.
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
          } catch {/* contact not in store yet */}
          return { ...p, number };
        }));
      }
    } else {
      try {
        const contact = await chat.getContact();
        isBusiness = !!contact?.isBusiness;
        pushname   = contact?.pushname  || null;
        shortName  = contact?.shortName || null;
        if (contact?.businessProfile) businessProfile = contact.businessProfile;
        // getFormattedNumber returns the real phone regardless of id format;
        // contact.number for @lid contacts returns the lid user-part instead,
        // so only fall back to it when the server is 'c.us'.
        try {
          const fmt = await contact.getFormattedNumber();
          if (fmt) phone = fmt.replace(/[\s()\-]/g, '') || null;
        } catch { /* not in this wwebjs build */ }
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
      catch (e) { console.warn(`⚠️  [${this.userName}] profile-pic download failed:`, e.code || e.errno || e.message || String(e)); }
    }

    return db.saveProfileVersion(this.userId, chatId, {
      picBytes,
      name: chat.name || null,
      phone,
      about,
      description,
      isBusiness,
      participants,
      pushname,
      shortName,
      businessProfile,
    });
  }

  // ── Background profile-refresh scheduler ────────────────────────────────
  // Recursive setTimeout (not setInterval) so a slow sweep can't overlap
  // the next tick. Idempotent — calling again replaces any pending timer.
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

  // Diff what wwebjs holds for this chat against our DB. Backfills new
  // messages, records edits (body change), and flags revokes for any DB row
  // inside the fetched window that's missing from the fetch.
  //
  // fetchMessages only returns wwebjs's local cache — WA doesn't backfill
  // linked devices automatically. We call syncHistory() first to nudge it,
  // but it's best-effort.
  async _reconcileChatMessages(chatId) {
    if (!this.client) return;
    const chat = await this._retry(() => this.client.getChatById(chatId));
    if (!chat) return;
    // syncHistory is async on WA's side (peer-data-operation request) — fire
    // and forget so the next sweep cycle benefits, not this one.
    if (typeof chat.syncHistory === 'function') {
      chat.syncHistory().catch(() => {});
    }
    // wwebjs's fetchMessages bails on loadEarlierMsgs once
    // chat.endOfHistoryTransferType !== 0, which WA flips almost immediately
    // for linked devices. Reach past the wrapper and call the Store's loader
    // directly in a loop. If WA refuses to push more, this is a no-op.
    try {
      await this.client.pupPage.evaluate(async (cid) => {
        const c = window.Store?.Chat?.get(cid);
        if (!c) return 0;
        const loader = window.Store?.ConversationMsgs?.loadEarlierMsgs;
        if (typeof loader !== 'function') return 0;
        for (let i = 0; i < 50; i++) {
          let loaded;
          try { loaded = await loader(c); }
          catch { break; }
          if (!loaded || !loaded.length) break;
        }
      }, chatId);
    } catch (e) { /* internal Store API may not exist on this build */ }
    let fetched;
    try {
      // Number.MAX_SAFE_INTEGER, not Infinity — Infinity is serialised to
      // null by Puppeteer's JSON arg encoding, so wwebjs's pagination loop
      // (gated by `searchOptions.limit > 0`) would never run.
      fetched = await this._retry(() => chat.fetchMessages({ limit: Number.MAX_SAFE_INTEGER }));
    } catch (e) {
      if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] fetchMessages(${chatId}) failed:`, e.message.split('\n')[0]);
      return;
    }
    if (!fetched?.length) return;

    // Don't archive these noise types (mirrors the live path's _shouldSkip),
    // but still let their timestamps anchor the window for revoke detection.
    const SKIP_TYPES = new Set(['e2e_notification','notification_template','notification','gp2','broadcast','protocol','undefined']);

    const fetchedIds = new Set();
    let oldestTs = Infinity;
    for (const m of fetched) {
      const waId = m.id?.id;
      if (!waId) continue;
      fetchedIds.add(waId);
      if (typeof m.timestamp === 'number' && m.timestamp < oldestTs) oldestTs = m.timestamp;
    }
    if (!Number.isFinite(oldestTs)) return;

    let added = 0, edited = 0, revoked = 0;
    for (const m of fetched) {
      if (this.stopping || !this.client) return;
      const waId = m.id?.id;
      if (!waId) continue;
      if (SKIP_TYPES.has(m.type)) continue;
      const existing = db.findMessageByWaId(this.userId, waId);
      // wwebjs surfaces a deleted-for-everyone message with type='revoked'
      // and an empty body. Don't mistake that for an edit of our preserved
      // body, and don't re-revoke something we already know about.
      const isRevokedStub = m.type === 'revoked';

      if (!existing) {
        // Don't backfill bare revoked stubs — we never had the original.
        if (isRevokedStub) continue;
        const r = await this._archiveMessage(m, { source: 'backfill' });
        if (r?.messageId) added++;
        continue;
      }
      if (existing.revoked_at) continue;
      if (isRevokedStub) {
        db.recordRevoke(this.userId, waId, m.timestamp || Math.floor(Date.now()/1000));
        revoked++;
        continue;
      }
      if ((existing.body || null) !== (m.body || null)) {
        db.recordEdit(this.userId, waId, existing.body, m.body, m.timestamp || Math.floor(Date.now()/1000));
        edited++;
      }
    }

    // Anything in our DB inside the fetched window but absent from the fetch
    // is a delete-for-everyone we missed live. Older rows are out of wwebjs's
    // range — leave them alone.
    const localInWindow = db.getMessagesInWindow(this.userId, chatId, oldestTs);
    for (const row of localInWindow) {
      if (!row.wa_id || row.revoked_at || fetchedIds.has(row.wa_id)) continue;
      db.recordRevoke(this.userId, row.wa_id, Math.floor(Date.now()/1000));
      revoked++;
    }

    console.log(`🪡  [${this.userName}/${chatId}] reconcile: fetched=${fetched.length} +${added} ~${edited} -${revoked}`);
  }

  // Two-phase: every chat (profile + message reconcile), then every unique
  // group participant not already a top-level chat (profile only).
  async _refreshAllProfiles() {
    const chats = db.getChats(this.userId);
    if (chats.length === 0) return;
    console.log(`🔄 [${this.userName}] Sweep: ${chats.length} chats`);

    const refreshedIds = new Set();

    for (const c of chats) {
      if (this.stopping || !this.client) return;
      try { await this.refreshProfile(c.chat_id); refreshedIds.add(c.chat_id); }
      catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] profile refresh ${c.chat_id} failed:`, e.message.split('\n')[0]); }
      try { await this._reconcileChatMessages(c.chat_id); }
      catch (e) { if (!isHarmless(e.message)) console.warn(`⚠️  [${this.userName}] reconcile ${c.chat_id} failed:`, e.message.split('\n')[0]); }
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
      } catch { /* malformed JSON */ }
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
      await sleep(3000); // stagger to avoid a RAM spike
    }
    if (users.length === 0) {
      console.log('ℹ️  No users yet — add one from the dashboard\n');
    }
  }

  async startSession(userId, userName) {
    let session = this.sessions.get(userId);
    if (session && session.client) return session;
    if (!session) {
      // userName is required on first start; reconnects can fall back to DB.
      if (!userName) {
        const u = db.getAllUsers().find(x => x.id === userId);
        if (!u) return null;
        userName = u.name;
      }
      session = new Session(userId, userName);
      this.sessions.set(userId, session);

      session.on('qr',              e => this.emit('qr',              e));
      session.on('ready',           e => this.emit('ready',           e));
      session.on('status',          e => this.emit('status',          e));
      session.on('message',         e => this.emit('message',         e));
      session.on('qr_timeout',      e => this.emit('qr_timeout',      e));
      session.on('message_edit',    e => this.emit('message_edit',    e));
      session.on('message_revoke',  e => this.emit('message_revoke',  e));
      session.on('reaction',        e => this.emit('reaction',        e));
      session.on('vote_update',     e => this.emit('vote_update',     e));
    }
    session.start(); // async, fire-and-forget
    return session;
  }

  // Stop Chrome but keep the user in 'qr' so the Reconnect banner stays up
  // — used when the user dismisses the QR modal without scanning.
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