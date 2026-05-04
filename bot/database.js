'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH   = path.join(__dirname, '..', 'vault.db');
const MEDIA_DIR = path.join(__dirname, '..', 'media');
const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB cap per file

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('wal_autocheckpoint = 100');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -8000');
db.pragma('temp_store = MEMORY');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    phone      TEXT,
    status     TEXT    DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wa_id       TEXT,
    chat_id     TEXT NOT NULL,
    chat_name   TEXT,
    from_me     INTEGER DEFAULT 0,
    sender      TEXT,
    body        TEXT,
    type        TEXT DEFAULT 'chat',
    timestamp   INTEGER NOT NULL,
    media_file  TEXT,
    mimetype    TEXT,
    filename    TEXT,
    lat         REAL,
    lng         REAL,
    created_at  INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, wa_id)
  );

  CREATE TABLE IF NOT EXISTS chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id     TEXT NOT NULL,
    name        TEXT,
    is_group    INTEGER DEFAULT 0,
    last_msg_at INTEGER,
    last_body   TEXT,
    last_type   TEXT,
    msg_count   INTEGER DEFAULT 0,
    updated_at  INTEGER DEFAULT (strftime('%s','now')),
    UNIQUE(user_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS bot_status (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    state   TEXT    DEFAULT 'offline',
    beat_at INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO bot_status (id, state, beat_at) VALUES (1, 'offline', 0);

  CREATE INDEX IF NOT EXISTS idx_messages_user     ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_chat     ON messages(user_id, chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_type     ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_chats_user        ON chats(user_id);
`);

// ── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  insertUser:    db.prepare(`INSERT INTO users (name) VALUES (?) RETURNING *`),
  updateUser:    db.prepare(`UPDATE users SET name = ?, phone = ?, status = ? WHERE id = ?`),
  getUserById:   db.prepare(`SELECT * FROM users WHERE id = ?`),
  getAllUsers:   db.prepare(`SELECT * FROM users ORDER BY id ASC`),
  deleteUser:    db.prepare(`DELETE FROM users WHERE id = ?`),

  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages
      (user_id, wa_id, chat_id, chat_name, from_me, sender, body, type, timestamp, media_file, mimetype, filename, lat, lng)
    VALUES
      (@user_id, @wa_id, @chat_id, @chat_name, @from_me, @sender, @body, @type, @timestamp, @media_file, @mimetype, @filename, @lat, @lng)
  `),

  upsertChat: db.prepare(`
    INSERT INTO chats (user_id, chat_id, name, is_group, last_msg_at, last_body, last_type, msg_count)
    VALUES (@user_id, @chat_id, @name, @is_group, @last_msg_at, @last_body, @last_type, 1)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET
      name        = excluded.name,
      last_msg_at = excluded.last_msg_at,
      last_body   = excluded.last_body,
      last_type   = excluded.last_type,
      msg_count   = msg_count + 1,
      updated_at  = strftime('%s','now')
  `),

  getChats: db.prepare(`SELECT * FROM chats WHERE user_id = ? ORDER BY last_msg_at DESC`),

  getMessages: db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages WHERE user_id = ? AND chat_id = ?
      ORDER BY timestamp DESC LIMIT ? OFFSET ?
    ) ORDER BY timestamp ASC
  `),

  searchMessages: db.prepare(`
    SELECT * FROM messages WHERE user_id = ? AND body LIKE ? ORDER BY timestamp DESC LIMIT 100
  `),

  getStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages WHERE user_id = ?)                                                                  AS total_messages,
      (SELECT COUNT(*) FROM messages WHERE user_id = ? AND type IN ('ptt','audio'))                                      AS voice_notes,
      (SELECT COUNT(*) FROM messages WHERE user_id = ? AND type IN ('image','video'))                                    AS media_files,
      (SELECT COUNT(*) FROM chats   WHERE user_id = ?)                                                                   AS total_chats,
      (SELECT COUNT(*) FROM messages WHERE user_id = ? AND from_me = 0 AND timestamp > strftime('%s','now') - 86400)    AS today_received
  `),

  getGlobalStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM messages)                                                                AS total_messages,
      (SELECT COUNT(*) FROM messages WHERE type IN ('ptt','audio'))                                  AS voice_notes,
      (SELECT COUNT(*) FROM messages WHERE type IN ('image','video'))                                AS media_files,
      (SELECT COUNT(*) FROM chats)                                                                   AS total_chats,
      (SELECT COUNT(*) FROM messages WHERE from_me = 0 AND timestamp > strftime('%s','now') - 86400) AS today_received
  `),

  setBotStatus: db.prepare(`UPDATE bot_status SET state = ?, beat_at = strftime('%s','now') WHERE id = 1`),
  getBotStatus: db.prepare(`SELECT state, beat_at FROM bot_status WHERE id = 1`),

  getMimetypeForFile: db.prepare(`SELECT mimetype FROM messages WHERE media_file = ? LIMIT 1`),
};

// ── Users ────────────────────────────────────────────────────────────────────
function createUser(name) {
  return stmts.insertUser.get(name || 'User');
}

function updateUser(id, name, phone, status) {
  stmts.updateUser.run(name, phone, status, id);
  return stmts.getUserById.get(id);
}

function getAllUsers() {
  return stmts.getAllUsers.all();
}

function deleteUser(id) {
  // CASCADE deletes messages and chats via FK
  stmts.deleteUser.run(id);
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
const HEARTBEAT_MS = 30000;
let heartbeatTimer = null;

function setBotOnline() {
  clearInterval(heartbeatTimer);
  stmts.setBotStatus.run('online');
  heartbeatTimer = setInterval(() => {
    try { stmts.setBotStatus.run('online'); }
    catch (err) { console.warn(`⚠️  Heartbeat write failed:`, err.message); }
  }, HEARTBEAT_MS);
}

function setBotOffline() {
  clearInterval(heartbeatTimer);
  try { stmts.setBotStatus.run('offline'); }
  catch (err) { console.warn(`⚠️  Failed to set bot offline:`, err.message); }
}

function getBotStatus() {
  const row = stmts.getBotStatus.get();
  if (!row) return { online: false };
  const stale = Math.floor(Date.now() / 1000) - row.beat_at > 90;
  return { online: row.state === 'online' && !stale, beat_at: row.beat_at };
}

// ── Save message ─────────────────────────────────────────────────────────────
function saveMessage(userId, msg, chatInfo) {
  chatInfo = chatInfo || {};
  let mediaBuf  = null;
  let mediaFile = null;
  let filename  = null;

  if (msg.mediaData && msg.mimetype) {
    mediaBuf = Buffer.from(msg.mediaData, 'base64');
    if (mediaBuf.length > MAX_MEDIA_BYTES) {
      console.warn(`⚠️  Skipped large media (${(mediaBuf.length / 1e6).toFixed(1)} MB)`);
      mediaBuf = null;
    }
  }
  
  let insertedId = null;

  db.transaction(() => {
    const ext = mediaBuf ? getExtension(msg.mimetype) : null;
    filename  = mediaBuf ? `${userId}_${msg.wa_id || Date.now()}.${ext}` : null;
    mediaFile = filename;

    const result = stmts.insertMessage.run({
      user_id:    userId,
      wa_id:      msg.wa_id     || null,
      chat_id:    msg.chat_id,
      chat_name:  chatInfo.name || msg.chat_id,
      from_me:    msg.from_me   ? 1 : 0,
      sender:     msg.sender    || null,
      body:       msg.body      || null,
      type:       msg.type      || 'chat',
      timestamp:  msg.timestamp || Math.floor(Date.now() / 1000),
      media_file: mediaFile,
      mimetype:   msg.mimetype  || null,
      filename:   filename,
      lat:        msg.lat       || null,
      lng:        msg.lng       || null,
    });
        insertedId = result.lastInsertRowid;

    stmts.upsertChat.run({
      user_id:     userId,
      chat_id:     msg.chat_id,
      name:        chatInfo.name    || msg.chat_id,
      is_group:    chatInfo.isGroup ? 1 : 0,
      last_msg_at: msg.timestamp    || Math.floor(Date.now() / 1000),
      last_body:   msg.body         || null,
      last_type:   msg.type         || 'chat',
    });
  })();

  if (mediaBuf && filename) {
    fs.writeFileSync(path.join(MEDIA_DIR, filename), mediaBuf);
  }

  return { mediaFile, filename, messageId: insertedId };
}

function attachMediaToMessage(messageId, base64Data, mimetype) {
  if (!messageId || !base64Data || !mimetype) return false;
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length > MAX_MEDIA_BYTES) return false;

  const row = db.prepare('SELECT user_id, wa_id, media_file FROM messages WHERE id = ?').get(messageId);
  if (!row) return false;
  if (row.media_file) return true; // already has media — nothing to do

  const ext      = getExtension(mimetype);
  const filename = `${row.user_id}_${row.wa_id || messageId}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, filename), buf);

  db.prepare('UPDATE messages SET media_file = ?, mimetype = ?, filename = ? WHERE id = ?')
    .run(filename, mimetype, filename, messageId);
  return true;
}

// ── Delete messages ──────────────────────────────────────────────────────────
function deleteMessages(userId, ids) {
  const safeIds = ids.filter(id => Number.isInteger(id) && id > 0);
  if (!safeIds.length) return { deleted: 0 };

  const ph = safeIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT media_file FROM messages WHERE user_id = ? AND id IN (${ph})`).all(userId, ...safeIds);
  rows.forEach(r => { 
    if (r.media_file) { 
      try { fs.unlinkSync(path.join(MEDIA_DIR, r.media_file)); }
      catch (err) { console.warn(`⚠️  Failed to delete media file ${r.media_file}:`, err.message); } 
    }
  });

  const result = db.prepare(`DELETE FROM messages WHERE user_id = ? AND id IN (${ph})`).run(userId, ...safeIds);

  db.prepare(`
    UPDATE chats SET
      msg_count   = (SELECT COUNT(*)   FROM messages WHERE user_id = chats.user_id AND chat_id = chats.chat_id),
      last_body   = (SELECT body       FROM messages WHERE user_id = chats.user_id AND chat_id = chats.chat_id ORDER BY timestamp DESC LIMIT 1),
      last_type   = (SELECT type       FROM messages WHERE user_id = chats.user_id AND chat_id = chats.chat_id ORDER BY timestamp DESC LIMIT 1),
      last_msg_at = COALESCE((SELECT timestamp FROM messages WHERE user_id = chats.user_id AND chat_id = chats.chat_id ORDER BY timestamp DESC LIMIT 1), last_msg_at)
    WHERE user_id = ?
  `).run(userId);
  db.prepare(`DELETE FROM chats WHERE user_id = ? AND msg_count = 0`).run(userId);

  return { deleted: result.changes };
}

// ── Delete chat ──────────────────────────────────────────────────────────────
function deleteChat(userId, chatId) {
  const rows = db.prepare('SELECT media_file FROM messages WHERE user_id = ? AND chat_id = ?').all(userId, chatId);
  rows.forEach(r => { 
    if (r.media_file) { 
      try { fs.unlinkSync(path.join(MEDIA_DIR, r.media_file)); }
      catch (err) { console.warn(`⚠️  Failed to delete media file ${r.media_file}:`, err.message); } 
    }
  });
  const result = db.prepare('DELETE FROM messages WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  db.prepare('DELETE FROM chats WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  return { deleted: result.changes };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getExtension(mime) {
  if (!mime) return 'bin';
  // WhatsApp sends MIMEs like 'audio/ogg; codecs=opus' — strip the codec so
  // the lookup actually finds 'audio/ogg' in the map below.
  const base = String(mime).toLowerCase().split(';')[0].trim();
  const map = {
    'audio/ogg':       'ogg',
    'audio/mpeg':      'mp3',
    'audio/mp4':       'm4a',
    'audio/aac':       'aac',
    'audio/wav':       'wav',
    'audio/x-wav':     'wav',
    'image/jpeg':      'jpg',
    'image/png':       'png',
    'image/webp':      'webp',
    'image/gif':       'gif',
    'video/mp4':       'mp4',
    'video/webm':      'webm',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'text/plain':      'txt',
  };
  return map[base] || 'bin';
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  createUser, updateUser, getAllUsers, deleteUser,
  saveMessage, attachMediaToMessage, deleteMessages, deleteChat,
  setBotOnline, setBotOffline, getBotStatus,
  getChats:       (userId) => stmts.getChats.all(userId),
  getMessages:    (userId, chatId, limit = 100, offset = 0) => stmts.getMessages.all(userId, chatId, limit, offset),
  searchMessages: (userId, q) => stmts.searchMessages.all(userId, '%' + q + '%'),
  getStats:       (userId) => stmts.getStats.get(userId, userId, userId, userId, userId),
  getGlobalStats: () => stmts.getGlobalStats.get(),
  getMediaPath:        (filename) => path.join(MEDIA_DIR, path.basename(filename)),
  getMimetypeForFile:  (filename) => stmts.getMimetypeForFile.get(filename)?.mimetype || null,
};
