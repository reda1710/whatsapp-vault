'use strict';

const Database = require('better-sqlite3');
const crypto   = require('crypto');
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

  CREATE TABLE IF NOT EXISTS chat_profile_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id       TEXT    NOT NULL,
    pic_filename  TEXT,
    pic_hash      TEXT,
    name          TEXT,
    phone         TEXT,
    about         TEXT,
    description   TEXT,
    is_business   INTEGER DEFAULT 0,
    participants  TEXT,
    fetched_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user     ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_chat     ON messages(user_id, chat_id);
  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts  ON messages(user_id, chat_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_type     ON messages(type);
  CREATE INDEX IF NOT EXISTS idx_chats_user        ON chats(user_id);
  CREATE INDEX IF NOT EXISTS idx_profile_versions_chat
    ON chat_profile_versions(user_id, chat_id, fetched_at DESC);
`);

// SQLite has no `ADD COLUMN IF NOT EXISTS` — swallow the duplicate-column
// error to make ALTER idempotent across runs and on fresh installs.
function ensureColumn(table, column, type) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
  catch (e) { if (!String(e.message || '').includes('duplicate column')) throw e; }
}
ensureColumn('chat_profile_versions', 'participants', 'TEXT');
ensureColumn('chat_profile_versions', 'phone',        'TEXT');

ensureColumn('messages', 'wa_serialized',  'TEXT');
ensureColumn('messages', 'quoted_wa_id',   'TEXT');
ensureColumn('messages', 'mentions',       'TEXT');
ensureColumn('messages', 'is_forwarded',   'INTEGER DEFAULT 0');
ensureColumn('messages', 'forward_score',  'INTEGER');
ensureColumn('messages', 'is_ephemeral',   'INTEGER DEFAULT 0');
ensureColumn('messages', 'is_status',      'INTEGER DEFAULT 0');
ensureColumn('messages', 'vcards',         'TEXT');
ensureColumn('messages', 'loc_name',       'TEXT');
ensureColumn('messages', 'loc_address',    'TEXT');
ensureColumn('messages', 'loc_url',        'TEXT');

ensureColumn('chat_profile_versions', 'pushname',         'TEXT');
ensureColumn('chat_profile_versions', 'short_name',       'TEXT');
ensureColumn('chat_profile_versions', 'business_profile', 'TEXT');

ensureColumn('messages', 'edited_at',  'INTEGER');
ensureColumn('messages', 'revoked_at', 'INTEGER');

db.exec(`
  CREATE TABLE IF NOT EXISTS message_edits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    prev_body   TEXT,
    new_body    TEXT,
    edited_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_message_edits_msg ON message_edits(message_id);

  CREATE TABLE IF NOT EXISTS reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    msg_wa_id   TEXT    NOT NULL,
    sender_id   TEXT    NOT NULL,
    emoji       TEXT,
    timestamp   INTEGER NOT NULL,
    UNIQUE(user_id, msg_wa_id, sender_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(user_id, msg_wa_id);

  CREATE TABLE IF NOT EXISTS poll_votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    poll_wa_id  TEXT    NOT NULL,
    voter_id    TEXT    NOT NULL,
    selected    TEXT,
    timestamp   INTEGER NOT NULL,
    UNIQUE(user_id, poll_wa_id, voter_id)
  );
  CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(user_id, poll_wa_id);

  CREATE TABLE IF NOT EXISTS group_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id     TEXT    NOT NULL,
    event_type  TEXT    NOT NULL,
    actor_id    TEXT,
    target_ids  TEXT,
    body        TEXT,
    timestamp   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_group_events_chat ON group_events(user_id, chat_id, timestamp);

  CREATE TABLE IF NOT EXISTS contact_changes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    old_id      TEXT    NOT NULL,
    new_id      TEXT    NOT NULL,
    is_contact  INTEGER,
    timestamp   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contact_changes_new ON contact_changes(user_id, new_id);
`);

// 1=server, 2=device, 3=read, 4=played, -1=error.
ensureColumn('messages', 'ack', 'INTEGER');
ensureColumn('messages', 'poll_options', 'TEXT');

// Call-log metadata (mirrors Call class fields; populated only for type='call_log').
ensureColumn('messages', 'call_is_video',     'INTEGER');
ensureColumn('messages', 'call_duration_sec', 'INTEGER');
ensureColumn('messages', 'call_participants', 'TEXT');

// ── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  insertUser:    db.prepare(`INSERT INTO users (name) VALUES (?) RETURNING *`),
  updateUser:    db.prepare(`UPDATE users SET name = ?, phone = ?, status = ? WHERE id = ?`),
  getUserById:   db.prepare(`SELECT * FROM users WHERE id = ?`),
  getAllUsers:   db.prepare(`SELECT * FROM users ORDER BY id ASC`),
  deleteUser:    db.prepare(`DELETE FROM users WHERE id = ?`),

  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages
      (user_id, wa_id, wa_serialized, chat_id, chat_name, from_me, sender, body, type, timestamp,
       media_file, mimetype, filename, lat, lng,
       quoted_wa_id, mentions, is_forwarded, forward_score, is_ephemeral, is_status, vcards,
       loc_name, loc_address, loc_url,
       call_is_video, call_duration_sec, call_participants)
    VALUES
      (@user_id, @wa_id, @wa_serialized, @chat_id, @chat_name, @from_me, @sender, @body, @type, @timestamp,
       @media_file, @mimetype, @filename, @lat, @lng,
       @quoted_wa_id, @mentions, @is_forwarded, @forward_score, @is_ephemeral, @is_status, @vcards,
       @loc_name, @loc_address, @loc_url,
       @call_is_video, @call_duration_sec, @call_participants)
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

  // Joins the latest pic_filename per chat via correlated subquery —
  // one indexed seek per row through idx_profile_versions_chat.
  getChats: db.prepare(`
    SELECT c.*,
      (SELECT pic_filename FROM chat_profile_versions
       WHERE user_id = c.user_id AND chat_id = c.chat_id
       ORDER BY fetched_at DESC LIMIT 1) AS pic_filename
    FROM chats c
    WHERE c.user_id = ?
    ORDER BY c.last_msg_at DESC
  `),

  getLatestProfile: db.prepare(`
    SELECT * FROM chat_profile_versions
    WHERE user_id = ? AND chat_id = ?
    ORDER BY fetched_at DESC LIMIT 1
  `),

  getProfileHistory: db.prepare(`
    SELECT * FROM chat_profile_versions
    WHERE user_id = ? AND chat_id = ?
    ORDER BY fetched_at DESC
  `),

  insertProfileVersion: db.prepare(`
    INSERT INTO chat_profile_versions
      (user_id, chat_id, pic_filename, pic_hash, name, phone, about, description, is_business, participants,
       pushname, short_name, business_profile)
    VALUES
      (@user_id, @chat_id, @pic_filename, @pic_hash, @name, @phone, @about, @description, @is_business, @participants,
       @pushname, @short_name, @business_profile)
  `),

  deleteChatProfileHistory: db.prepare(`
    DELETE FROM chat_profile_versions WHERE user_id = ? AND chat_id = ?
  `),

  selectProfilePicsForChat: db.prepare(`
    SELECT DISTINCT pic_filename FROM chat_profile_versions
    WHERE user_id = ? AND chat_id = ? AND pic_filename IS NOT NULL
  `),

  selectProfilePicsForUser: db.prepare(`
    SELECT DISTINCT pic_filename FROM chat_profile_versions
    WHERE user_id = ? AND pic_filename IS NOT NULL
  `),

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

  findMessageByWaId: db.prepare(`SELECT id, body FROM messages WHERE user_id = ? AND wa_id = ? LIMIT 1`),
  // For the sweep's revoke pass — scope to a chat + minimum timestamp.
  getMessagesInWindow: db.prepare(`
    SELECT id, wa_id, revoked_at FROM messages
    WHERE user_id = ? AND chat_id = ? AND timestamp >= ? AND wa_id IS NOT NULL
  `),
  insertMessageEdit: db.prepare(`
    INSERT INTO message_edits (user_id, message_id, prev_body, new_body, edited_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  updateMessageBody: db.prepare(`UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`),
  markMessageRevoked: db.prepare(`UPDATE messages SET revoked_at = ? WHERE user_id = ? AND wa_id = ?`),
  getEditsForMessage: db.prepare(`
    SELECT prev_body, new_body, edited_at FROM message_edits
    WHERE message_id = ? ORDER BY edited_at ASC
  `),

  upsertReaction: db.prepare(`
    INSERT INTO reactions (user_id, msg_wa_id, sender_id, emoji, timestamp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, msg_wa_id, sender_id) DO UPDATE SET
      emoji = excluded.emoji, timestamp = excluded.timestamp
  `),
  // emoji='' = removal — exclude from the count.
  getReactionsForChat: db.prepare(`
    SELECT msg_wa_id, emoji, COUNT(*) AS count
    FROM reactions
    WHERE user_id = ? AND msg_wa_id IN (
      SELECT wa_id FROM messages WHERE user_id = ? AND chat_id = ? AND wa_id IS NOT NULL
    ) AND emoji IS NOT NULL AND emoji <> ''
    GROUP BY msg_wa_id, emoji
  `),

  updateMessageAck: db.prepare(`UPDATE messages SET ack = ? WHERE user_id = ? AND wa_id = ?`),

  setPollOptions: db.prepare(`UPDATE messages SET poll_options = ? WHERE id = ?`),
  upsertPollVote: db.prepare(`
    INSERT INTO poll_votes (user_id, poll_wa_id, voter_id, selected, timestamp)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, poll_wa_id, voter_id) DO UPDATE SET
      selected = excluded.selected, timestamp = excluded.timestamp
  `),
  getPollVotes: db.prepare(`
    SELECT voter_id, selected, timestamp FROM poll_votes
    WHERE user_id = ? AND poll_wa_id = ?
  `),

  insertGroupEvent: db.prepare(`
    INSERT INTO group_events (user_id, chat_id, event_type, actor_id, target_ids, body, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getGroupEventsForChat: db.prepare(`
    SELECT * FROM group_events WHERE user_id = ? AND chat_id = ? ORDER BY timestamp ASC
  `),

  insertContactChange: db.prepare(`
    INSERT INTO contact_changes (user_id, old_id, new_id, is_contact, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `),
  getContactChangesFor: db.prepare(`
    SELECT * FROM contact_changes WHERE user_id = ? AND (new_id = ? OR old_id = ?) ORDER BY timestamp DESC
  `),
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
  // Sweep pic files before the FK cascade removes the rows that name them.
  try {
    const pics = stmts.selectProfilePicsForUser.all(id);
    for (const { pic_filename } of pics) {
      try { fs.unlinkSync(path.join(MEDIA_DIR, pic_filename)); }
      catch (err) { if (err.code !== 'ENOENT') console.warn(`⚠️  Failed to delete profile pic ${pic_filename}:`, err.message); }
    }
  } catch (err) { console.warn(`⚠️  Profile pic sweep failed for user ${id}:`, err.message); }

  // FK cascade wipes messages, chats, and chat_profile_versions.
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
      user_id:       userId,
      wa_id:         msg.wa_id        || null,
      wa_serialized: msg.wa_serialized || null,
      chat_id:       msg.chat_id,
      chat_name:     chatInfo.name    || msg.chat_id,
      from_me:       msg.from_me      ? 1 : 0,
      sender:        msg.sender       || null,
      body:          msg.body         || null,
      type:          msg.type         || 'chat',
      timestamp:     msg.timestamp    || Math.floor(Date.now() / 1000),
      media_file:    mediaFile,
      mimetype:      msg.mimetype     || null,
      filename:      filename,
      lat:           msg.lat          || null,
      lng:           msg.lng          || null,
      quoted_wa_id:  msg.quoted_wa_id || null,
      mentions:      msg.mentions     || null,
      is_forwarded:  msg.is_forwarded ? 1 : 0,
      forward_score: msg.forward_score || null,
      is_ephemeral:  msg.is_ephemeral ? 1 : 0,
      is_status:     msg.is_status    ? 1 : 0,
      vcards:        msg.vcards       || null,
      loc_name:      msg.loc_name     || null,
      loc_address:   msg.loc_address  || null,
      loc_url:       msg.loc_url      || null,
      call_is_video:     msg.call_is_video     ?? null,
      call_duration_sec: msg.call_duration_sec ?? null,
      call_participants: msg.call_participants || null,
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

  // Pic filenames embed the chatId so there's no overlap with other chats.
  const pics = stmts.selectProfilePicsForChat.all(userId, chatId);
  for (const { pic_filename } of pics) {
    try { fs.unlinkSync(path.join(MEDIA_DIR, pic_filename)); }
    catch (err) { if (err.code !== 'ENOENT') console.warn(`⚠️  Failed to delete profile pic ${pic_filename}:`, err.message); }
  }
  stmts.deleteChatProfileHistory.run(userId, chatId);

  const result = db.prepare('DELETE FROM messages WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  db.prepare('DELETE FROM chats WHERE user_id = ? AND chat_id = ?').run(userId, chatId);
  return { deleted: result.changes };
}

// ── Profile versions ─────────────────────────────────────────────────────────
// Append-only timeline of profile snapshots. If nothing changed since the
// last snapshot we return that row instead of writing a duplicate.
function saveProfileVersion(userId, chatId, { picBytes, name, phone, about, description, isBusiness, participants, pushname, shortName, businessProfile }) {
  const picHash = picBytes ? crypto.createHash('sha256').update(picBytes).digest('hex') : null;

  const safeChat = String(chatId).replace(/[@.]/g, '_');
  const picFilename = picBytes ? `${userId}_pic_${safeChat}_${picHash.slice(0, 16)}.jpg` : null;

  // Sort by id so a server-side reorder doesn't trigger a phantom version.
  // Phone number is kept alongside so @lid ids still display a real number.
  let participantsJson = null;
  if (Array.isArray(participants)) {
    const canon = participants
      .filter(p => p && p.id)
      .map(p => ({
        id:           p.id,
        number:       p.number       || null,
        isAdmin:      !!p.isAdmin,
        isSuperAdmin: !!p.isSuperAdmin,
      }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    participantsJson = JSON.stringify(canon);
  }

  const businessProfileJson = businessProfile
    ? (typeof businessProfile === 'string' ? businessProfile : JSON.stringify(businessProfile))
    : null;

  const latest = stmts.getLatestProfile.get(userId, chatId);
  const same = latest
    && (latest.pic_hash         || null) === picHash
    && (latest.name             || null) === (name        || null)
    && (latest.phone            || null) === (phone       || null)
    && (latest.about            || null) === (about       || null)
    && (latest.description      || null) === (description || null)
    && !!latest.is_business              === !!isBusiness
    && (latest.participants     || null) === participantsJson
    && (latest.pushname         || null) === (pushname    || null)
    && (latest.short_name       || null) === (shortName   || null)
    && (latest.business_profile || null) === businessProfileJson;
  if (same) return latest;

  if (picBytes && picFilename) {
    const fp = path.join(MEDIA_DIR, picFilename);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, picBytes);
  }

  stmts.insertProfileVersion.run({
    user_id:          userId,
    chat_id:          chatId,
    pic_filename:     picFilename,
    pic_hash:         picHash,
    name:             name        || null,
    phone:            phone       || null,
    about:            about       || null,
    description:      description || null,
    is_business:      isBusiness ? 1 : 0,
    participants:     participantsJson,
    pushname:         pushname    || null,
    short_name:       shortName   || null,
    business_profile: businessProfileJson,
  });
  return stmts.getLatestProfile.get(userId, chatId);
}

// ── Edits + revokes ──────────────────────────────────────────────────────────
// Append to the history table AND mutate the live row so the chat view
// reflects the latest state without an extra join. Revokes do NOT clear the
// body — the vault is the canonical record of what was sent.
function recordEdit(userId, waId, prevBody, newBody, editedAt) {
  if (!waId) return { found: false };
  const row = stmts.findMessageByWaId.get(userId, waId);
  if (!row) return { found: false };
  const ts = editedAt || Math.floor(Date.now() / 1000);
  db.transaction(() => {
    stmts.insertMessageEdit.run(userId, row.id, prevBody ?? row.body ?? null, newBody ?? null, ts);
    stmts.updateMessageBody.run(newBody ?? null, ts, row.id);
  })();
  return { found: true, messageId: row.id };
}

function recordRevoke(userId, waId, revokedAt) {
  if (!waId) return { found: false };
  const ts = revokedAt || Math.floor(Date.now() / 1000);
  const r = stmts.markMessageRevoked.run(ts, userId, waId);
  return { found: r.changes > 0 };
}

function getEditHistory(userId, messageId) {
  // Confirm ownership before returning history rows from another user's msg.
  const owns = db.prepare('SELECT 1 FROM messages WHERE id = ? AND user_id = ?').get(messageId, userId);
  if (!owns) return [];
  return stmts.getEditsForMessage.all(messageId);
}

// ── Reactions, acks, polls, calls, group events, contact changes ─────────────
function recordReaction(userId, msgWaId, senderId, emoji, timestamp) {
  if (!msgWaId || !senderId) return;
  stmts.upsertReaction.run(userId, msgWaId, senderId, emoji ?? '', timestamp || Math.floor(Date.now()/1000));
}

// Returns Map<msg_wa_id, [{emoji, count}]>.
function getReactionsForChat(userId, chatId) {
  const rows = stmts.getReactionsForChat.all(userId, userId, chatId);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.msg_wa_id)) out.set(r.msg_wa_id, []);
    out.get(r.msg_wa_id).push({ emoji: r.emoji, count: r.count });
  }
  return out;
}

function recordAck(userId, waId, ack) {
  if (!waId || ack == null) return;
  stmts.updateMessageAck.run(ack, userId, waId);
}

function recordPollOptions(userId, waId, options) {
  if (!waId || !Array.isArray(options) || !options.length) return;
  const row = stmts.findMessageByWaId.get(userId, waId);
  if (!row) return;
  stmts.setPollOptions.run(JSON.stringify(options), row.id);
}

function recordPollVote(userId, pollWaId, voterId, selected, timestamp) {
  if (!pollWaId || !voterId) return;
  const sel = Array.isArray(selected) ? JSON.stringify(selected) : (selected || null);
  stmts.upsertPollVote.run(userId, pollWaId, voterId, sel, timestamp || Math.floor(Date.now()/1000));
}

function getPollVotes(userId, pollWaId) {
  return stmts.getPollVotes.all(userId, pollWaId);
}

function recordGroupEvent(userId, { chat_id, event_type, actor_id, target_ids, body, timestamp }) {
  if (!chat_id || !event_type) return;
  const targets = Array.isArray(target_ids) ? JSON.stringify(target_ids) : (target_ids || null);
  stmts.insertGroupEvent.run(userId, chat_id, event_type, actor_id || null, targets, body || null, timestamp || Math.floor(Date.now()/1000));
}

function getGroupEventsForChat(userId, chatId) {
  return stmts.getGroupEventsForChat.all(userId, chatId);
}

function recordContactChange(userId, oldId, newId, isContact, timestamp) {
  if (!oldId || !newId) return;
  stmts.insertContactChange.run(userId, oldId, newId, isContact ? 1 : 0, timestamp || Math.floor(Date.now()/1000));
}

function getContactChanges(userId, contactId) {
  return stmts.getContactChangesFor.all(userId, contactId, contactId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getExtension(mime) {
  if (!mime) return 'bin';
  // Strip codec params — WA sends e.g. 'audio/ogg; codecs=opus'.
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
  recordEdit, recordRevoke, getEditHistory,
  findMessageByWaId:   (userId, waId) => stmts.findMessageByWaId.get(userId, waId) || null,
  getMessagesInWindow: (userId, chatId, sinceTs) => stmts.getMessagesInWindow.all(userId, chatId, sinceTs),
  recordReaction, getReactionsForChat,
  recordAck,
  recordPollOptions, recordPollVote, getPollVotes,
  recordGroupEvent, getGroupEventsForChat,
  recordContactChange, getContactChanges,
  setBotOnline, setBotOffline, getBotStatus,
  saveProfileVersion,
  getChats:           (userId) => stmts.getChats.all(userId),
  // Attaches aggregated reactions per row (one extra indexed query per chat).
  getMessages:        (userId, chatId, limit = 100, offset = 0) => {
    const rows = stmts.getMessages.all(userId, chatId, limit, offset);
    const reactionMap = getReactionsForChat(userId, chatId);
    for (const r of rows) {
      if (r.wa_id && reactionMap.has(r.wa_id)) {
        r.reactions = JSON.stringify(reactionMap.get(r.wa_id));
      }
    }
    return rows;
  },
  searchMessages:     (userId, q) => stmts.searchMessages.all(userId, '%' + q + '%'),
  getStats:           (userId) => stmts.getStats.get(userId, userId, userId, userId, userId),
  getGlobalStats:     () => stmts.getGlobalStats.get(),
  getLatestProfile:   (userId, chatId) => stmts.getLatestProfile.get(userId, chatId) || null,
  getProfileHistory:  (userId, chatId) => stmts.getProfileHistory.all(userId, chatId),
  // Returns Map<chatId, { pic_filename, name }>. MAX(id) picks the latest row
  // per group (id is monotonic).
  getLatestProfilesForChatIds: (userId, chatIds) => {
    if (!Array.isArray(chatIds) || chatIds.length === 0) return new Map();
    const placeholders = chatIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT chat_id, pic_filename, name FROM chat_profile_versions
      WHERE id IN (
        SELECT MAX(id) FROM chat_profile_versions
        WHERE user_id = ? AND chat_id IN (${placeholders})
        GROUP BY chat_id
      )
    `).all(userId, ...chatIds);
    const map = new Map();
    for (const r of rows) map.set(r.chat_id, r);
    return map;
  },
  getMediaPath:       (filename) => path.join(MEDIA_DIR, path.basename(filename)),
  getMimetypeForFile: (filename) => stmts.getMimetypeForFile.get(filename)?.mimetype || null,
};
