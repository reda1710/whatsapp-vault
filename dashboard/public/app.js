const API = window.location.origin + '/api'; // dynamic — works on any host

// ── Media blob cache ────────────────────────────────────────────────────
// <img>, <audio>, <video> src= can't send custom headers, so we fetch media
// via apiFetch() (which injects the API key) and store blob URLs locally.
const blobCache = new Map(); // filename → blob URL

async function loadMediaBlob(filename) {
  if (!filename) return null;
  if (blobCache.has(filename)) return blobCache.get(filename);
  try {
    const r = await apiFetch(`${API}/media/${encodeURIComponent(filename)}`);
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    blobCache.set(filename, url);
    return url;
  } catch (e) {
    console.warn('Media load failed:', filename, e.message);
    return null;
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// FIX: API key is required. Stored in sessionStorage (cleared when tab closes).
let apiKey = sessionStorage.getItem('vault_api_key') || '';

async function doLogin() {
  const input = document.getElementById('login-key-input');
  const err   = document.getElementById('login-err');
  const key   = input.value.trim();
  if (!key) return;

  // Probe /api/stats to validate the key before storing it
  try {
    const r = await apiFetch(`${API}/stats`, { headers: { 'X-API-Key': key } });
    if (r.status === 401) {
      err.classList.add('visible');
      input.value = '';
      return;
    }
    apiKey = key;
    sessionStorage.setItem('vault_api_key', key);
    document.getElementById('login-overlay').classList.remove('open');
    err.classList.remove('visible');
    await loadStats();
    await loadChats();
  } catch {
    err.textContent = 'Could not reach the server.';
    err.classList.add('visible');
  }
}

// Authenticated fetch wrapper — all API calls go through this
async function apiFetch(url, opts = {}) {
  const headers = { 'X-API-Key': apiKey, ...(opts.headers || {}) };
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    // Key expired or invalid — show login again
    sessionStorage.removeItem('vault_api_key');
    apiKey = '';
    document.getElementById('login-overlay').classList.add('open');
    throw new Error('Unauthorized');
  }
  return r;
}

let currentChatId = null;
let currentFilter = 'all';
let allMessages = [];
let refreshTimer = null;

// ── Colours for avatars ─────────────────────────────────────────────────
const AVATAR_COLORS = [
  ['#1a3329','#25d366'],['#1a2233','#4a9eff'],['#2e1a33','#a855f7'],
  ['#2e1a1a','#ff6b6b'],['#1a2a1a','#86efac'],['#2a2011','#f5a623'],
];

function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name) {
  return name.split(/[\s@_-]+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
}

// Render an avatar — real profile pic if we have one, otherwise the colored
// letter circle. The img falls back to a letter circle if the file is gone.
function renderAvatar(name, picFilename, extraClass = '') {
  const safe = name || '?';
  const [bg, fg] = avatarColor(safe);
  if (picFilename) {
    return `<img class="avatar avatar-img ${extraClass}"
              src="${API}/media/${encodeURIComponent(picFilename)}?key=${encodeURIComponent(apiKey)}"
              data-name="${escAttr(safe)}"
              onerror="onAvatarError(this)">`;
  }
  return `<div class="avatar ${extraClass}" style="background:${bg};color:${fg}">${initials(safe)}</div>`;
}

function onAvatarError(img) {
  const name = img.getAttribute('data-name') || '?';
  const [bg, fg] = avatarColor(name);
  const div = document.createElement('div');
  div.className = (img.className || 'avatar').replace(/\bavatar-img\b/, '').trim();
  if (img.id) div.id = img.id;
  div.style.background = bg;
  div.style.color = fg;
  div.textContent = initials(name);
  img.replaceWith(div);
}

// Small avatar variant used inside the profile-modal member list. Same
// onerror → letter-circle fallback as renderAvatar, but a different class so
// the size doesn't collide with the 38px chat-list / header avatars.
function renderMemberAvatar(name, picFilename) {
  const safe = name || '?';
  const [bg, fg] = avatarColor(safe);
  if (picFilename) {
    return `<img class="member-avatar"
              src="${API}/media/${encodeURIComponent(picFilename)}?key=${encodeURIComponent(apiKey)}"
              data-name="${escAttr(safe)}"
              onerror="onMemberAvatarError(this)">`;
  }
  return `<div class="member-avatar member-avatar-fallback" style="background:${bg};color:${fg}">${esc(initials(safe))}</div>`;
}

function onMemberAvatarError(img) {
  const name = img.getAttribute('data-name') || '?';
  const [bg, fg] = avatarColor(name);
  const div = document.createElement('div');
  div.className = 'member-avatar member-avatar-fallback';
  div.style.background = bg;
  div.style.color = fg;
  div.textContent = initials(name);
  img.replaceWith(div);
}

// Replace the chat-header avatar element in place — preserves the #chat-avatar
// id so subsequent updates (and the inline click handler on the header) keep
// working regardless of whether the avatar is currently an img or a div.
function setHeaderAvatar(name, picFilename) {
  const old = document.getElementById('chat-avatar');
  if (!old) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderAvatar(name, picFilename);
  const fresh = tmp.firstElementChild;
  fresh.id = 'chat-avatar';
  old.replaceWith(fresh);
}

// ── Time formatting ─────────────────────────────────────────────────────
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now - d;
  if (diff < 86400000 && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diff < 7 * 86400000) {
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  }
  return d.toLocaleDateString([], { day:'numeric', month:'short' });
}

function fmtFull(ts) {
  return new Date(ts * 1000).toLocaleString([], {
    day:'numeric', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}

// ── Stats ───────────────────────────────────────────────────────────────
async function loadStats() {
  // Fetch stats and bot status in parallel
  try {
    const statsUrl = currentUserId ? `${API}/stats?userId=${currentUserId}` : `${API}/stats`;
    const [statsRes, statusRes] = await Promise.all([
      apiFetch(statsUrl),
      apiFetch(`${API}/bot-status`),
    ]);
    const s  = await statsRes.json();
    const st = await statusRes.json();

    document.getElementById('s-total').textContent = s.total_messages.toLocaleString();
    document.getElementById('s-voice').textContent = s.voice_notes.toLocaleString();
    document.getElementById('s-media').textContent = s.media_files.toLocaleString();
    document.getElementById('s-chats').textContent = s.total_chats.toLocaleString();
    document.getElementById('s-today').textContent = s.today_received.toLocaleString();

    const dot   = document.getElementById('dot-live');
    const label = document.getElementById('live-label');
    if (st.online) {
      label.textContent    = 'BOT LIVE';
      label.style.color    = 'var(--accent)';
      dot.style.background = 'var(--accent)';
      dot.style.boxShadow  = '';
      dot.style.animation  = 'pulse 2s ease-in-out infinite';
    } else {
      label.textContent    = 'BOT OFFLINE';
      label.style.color    = 'var(--coral)';
      dot.style.background = 'var(--coral)';
      dot.style.boxShadow  = '0 0 0 3px rgba(255,107,107,.25)';
      dot.style.animation  = 'none';
    }
  } catch {
    document.getElementById('live-label').textContent = 'OFFLINE';
    document.getElementById('dot-live').style.background = 'var(--coral)';
  }
}

// ── Chat list ───────────────────────────────────────────────────────────
async function loadChats() {
  try {
    if (!currentUserId) { document.getElementById('chat-list').innerHTML = '<div class="empty-list">Select a user above</div>'; return; }
    const r = await apiFetch(`${API}/chats?userId=${currentUserId}`);
    const chats = await r.json();
    const list = document.getElementById('chat-list');
    document.getElementById('chat-count-lbl').textContent = chats.length;

    if (chats.length === 0) {
      list.innerHTML = `
        <div class="empty-list" style="padding:24px;text-align:center">
          <span style="font-size:24px">📭</span>
          <span>No messages yet</span>
          <span style="font-size:10px;opacity:.5">Start chatting on WhatsApp to see messages here</span>
        </div>`;
      return;
    }

    list.innerHTML = chats.map(c => {
      const displayName = c.name || c.chat_id.split('@')[0];
      const preview = previewText(c.last_type, c.last_body);
      const time = c.last_msg_at ? fmtTime(c.last_msg_at) : '';
      const active = c.chat_id === currentChatId ? ' active' : '';
      const groupTag = c.is_group ? `<span class="tag group">group</span>` : '';
      const pic = c.pic_filename || '';
      return `
        <div class="chat-item${active}" onclick="selectChat('${escAttr(c.chat_id)}','${escAttr(c.name||c.chat_id)}',${c.is_group},${c.msg_count},'${escAttr(pic)}')">
          ${renderAvatar(displayName, c.pic_filename)}
          <div class="chat-meta">
            <div class="chat-name">${esc(displayName)} ${groupTag}</div>
            <div class="chat-preview">${preview}</div>
          </div>
          <button class="del-chat-btn" title="Delete conversation" onclick="event.stopPropagation();confirmDeleteChat('${escAttr(c.chat_id)}','${escAttr(c.name||c.chat_id)}')">✕</button>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
            <div class="chat-time">${time}</div>
            <div class="chat-count">${c.msg_count}</div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    console.error(e);
  }
}

function previewText(type, body) {
  if (!type) return '';
  const icons = { ptt:'🎙 Voice note', audio:'🎵 Audio', image:'🖼 Photo', video:'🎬 Video', document:'📄 Document', sticker:'🎭 Sticker', location:'📍 Location' };
  if (icons[type]) return icons[type];
  return body ? esc(body.substring(0, 40)) : '';
}

// ── Select chat ─────────────────────────────────────────────────────────
async function selectChat(chatId, name, isGroup, count, picFilename) {
  currentChatId = chatId;
  currentFilter = 'all';
  loadedCount   = 0;
  hasMoreMsgs   = false;
  document.querySelectorAll('.filter-btn').forEach((b,i)=>b.classList.toggle('active',i===0));
  document.getElementById('chat-header').style.display = 'flex';
  document.getElementById('filter-bar').style.display = 'flex';
  document.getElementById('search-results').classList.remove('open');

  setHeaderAvatar(name, picFilename || null);
  document.getElementById('chat-name').textContent = name;
  document.getElementById('chat-sub').textContent = `${count} messages`;

  document.querySelectorAll('.chat-item').forEach(el => {
    el.classList.toggle('active', el.querySelector('.chat-name')?.textContent.trim().startsWith(name.trim()));
  });

  await loadMessages(chatId);
  // On mobile we show one pane at a time; flag the body BEFORE the snap so
  // the chat-area is laid out (display:none → display:flex) — otherwise its
  // scrollHeight is 0 at the moment we try to scroll to the bottom.
  document.body.classList.add('chat-open');
  // Snap to the latest message. Background reloads (SSE / poller / refresh)
  // go through reloadCurrentChatMessages() and do NOT snap — they preserve
  // the user's scroll position instead.
  const box = document.getElementById('messages');
  box.scrollTop = box.scrollHeight;
}

// Mobile back-button: return to the chat-list view.
function closeChatView() {
  document.body.classList.remove('chat-open');
}

// Mobile stats popover toggle. The statsbar element is reused as a dropdown
// panel via CSS; this just flips the .open class.
function toggleStatsMenu(e) {
  if (e) e.stopPropagation();
  document.querySelector('.statsbar').classList.toggle('open');
}

// ── Load messages ───────────────────────────────────────────────────────
// Server returns the latest N messages (offset M from the newest) in ASC
// order. Fresh load = offset 0 → newest 50. Load-more = offset loadedCount
// → next 50 older, prepended to allMessages.
let loadedCount  = 0;
const MSG_LIMIT  = 50;
let hasMoreMsgs  = false;

async function loadMessages(chatId, prepend = false, limitOverride) {
  const box   = document.getElementById('messages');
  const limit = limitOverride ?? MSG_LIMIT;
  if (!prepend) {
    loadedCount = 0;
    allMessages = [];
    box.innerHTML = `<div class="empty"><div class="spinner"></div></div>`;
  }
  try {
    // Over-fetch by 1 so we can distinguish "exactly N left" from "N+ left"
    // without a separate count query. If we got the extra row, drop the
    // oldest (index 0 in ASC order) and flag hasMore.
    const r    = await apiFetch(`${API}/chats/${encodeURIComponent(chatId)}/messages?userId=${currentUserId}&limit=${limit + 1}&offset=${loadedCount}`);
    let page   = await r.json();
    const more = page.length > limit;
    if (more) page = page.slice(1);
    hasMoreMsgs = more;
    allMessages = prepend ? [...page, ...allMessages] : page;
    loadedCount += page.length;
    renderMessages();
  } catch {
    if (!prepend) box.innerHTML = `<div class="empty"><h3>Failed to load</h3></div>`;
  }
}

async function loadMoreMessages() {
  if (!currentChatId || !hasMoreMsgs) return;
  const box     = document.getElementById('messages');
  const prevH   = box.scrollHeight;
  const prevTop = box.scrollTop;
  await loadMessages(currentChatId, true);
  // Anchor the user's view: keep the same message under the cursor by
  // shifting scrollTop by the height of the freshly-prepended block.
  box.scrollTop = prevTop + (box.scrollHeight - prevH);
}

// Background reloads (10s poll, SSE) refresh the active chat without yanking
// the user's scroll. We fetch silently (never wiping innerHTML during the
// network trip), then diff-render by data-id so surviving message nodes —
// with their already-loaded images, paused videos, and voice-note timers —
// stay in place. Idle polls (no message changes) become true no-ops.
async function reloadCurrentChatMessages() {
  if (!currentChatId) return;
  const box = document.getElementById('messages');

  if (currentAudio && !currentAudio.paused) return;
  for (const v of box.querySelectorAll('video')) {
    if (!v.paused) return;
  }

  // Keep however many older pages the user already expanded; otherwise an SSE
  // tick would silently snap them back to just the latest 50.
  const limit = Math.max(MSG_LIMIT, loadedCount);
  let page, more;
  try {
    const r = await apiFetch(`${API}/chats/${encodeURIComponent(currentChatId)}/messages?userId=${currentUserId}&limit=${limit + 1}&offset=0`);
    page = await r.json();
    more = page.length > limit;
    if (more) page = page.slice(1);
  } catch {
    return;
  }
  hasMoreMsgs = more;

  const oldFps = allMessages.map(msgFingerprint).join(',');
  const newFps = page.map(msgFingerprint).join(',');
  if (oldFps === newFps) return;

  const filtered = (currentFilter === 'all') ? page : page.filter(m => m.type === currentFilter);
  const wasNearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 100;

  if (filtered.length === 0) {
    box.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>No messages</h3><p>No ${currentFilter === 'all' ? '' : currentFilter + ' '}messages in this chat.</p></div>`;
    allMessages = page;
    loadedCount = page.length;
    return;
  }

  const keepIds = new Set(filtered.map(m => m.id));
  for (const node of [...box.children]) {
    const isMsg = node.classList?.contains('msg-wrap');
    if (!isMsg || !keepIds.has(parseInt(node.dataset.id, 10))) node.remove();
  }

  // Save allMessages to the new page BEFORE walking, so renderMessage's
  // quoted-banner lookup (which scans allMessages) sees the fresh data.
  allMessages = page;

  let cursor = box.firstElementChild;
  for (const m of filtered) {
    const want = msgFingerprint(m);
    if (cursor && parseInt(cursor.dataset.id, 10) === m.id) {
      if (cursor.dataset.fp !== want) {
        // Same message, content changed (edit / revoke / late media) — swap in
        // a freshly-rendered bubble at this exact position.
        const tmp = document.createElement('div');
        tmp.innerHTML = renderMessage(m);
        const fresh = tmp.firstElementChild;
        fresh.dataset.fp = want;
        const next = cursor.nextElementSibling;
        cursor.replaceWith(fresh);
        cursor = next;
      } else {
        cursor = cursor.nextElementSibling;
      }
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderMessage(m);
      const fresh = tmp.firstElementChild;
      fresh.dataset.fp = want;
      box.insertBefore(fresh, cursor);
    }
  }

  if (hasMoreMsgs) {
    box.insertAdjacentHTML('afterbegin', `<div style="text-align:center;padding:10px 0">
        <button onclick="loadMoreMessages()" style="font-family:var(--mono);font-size:11px;padding:5px 14px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--subtle);cursor:pointer">
          ↑ Load older messages
        </button>
       </div>`);
  }

  loadedCount = page.length;

  if (wasNearBottom) box.scrollTop = box.scrollHeight;
}

// Fields whose change requires re-rendering a message bubble. Keep this in
// sync with reloadCurrentChatMessages's diff-render so initial-load and
// background-poll renders agree on what counts as "unchanged".
function msgFingerprint(m) {
  return `${m.id}:${m.body || ''}:${m.edited_at || 0}:${m.revoked_at || 0}:${m.media_file || ''}:${m.ack || 0}:${m.reactions || ''}`;
}

function renderMessages() {
  const box = document.getElementById('messages');
  let msgs = allMessages;
  if (currentFilter !== 'all') {
    msgs = msgs.filter(m => m.type === currentFilter);
  }
  if (msgs.length === 0) {
    box.innerHTML = `<div class="empty"><div class="empty-icon">🔍</div><h3>No messages</h3><p>No ${currentFilter === 'all' ? '' : currentFilter + ' '}messages in this chat.</p></div>`;
    return;
  }
  const loadMoreBtn = hasMoreMsgs
    ? `<div style="text-align:center;padding:10px 0">
        <button onclick="loadMoreMessages()" style="font-family:var(--mono);font-size:11px;padding:5px 14px;border-radius:6px;border:1px solid var(--border2);background:transparent;color:var(--subtle);cursor:pointer">
          ↑ Load older messages
        </button>
       </div>`
    : '';
  box.innerHTML = loadMoreBtn + msgs.map(renderMessage).join('');
  // Stamp data-fp on each freshly-rendered bubble so the next diff-render
  // tick can tell which (if any) need to be replaced.
  for (const node of box.querySelectorAll('.msg-wrap[data-id]')) {
    const m = msgs.find(x => x.id === parseInt(node.dataset.id, 10));
    if (m) node.dataset.fp = msgFingerprint(m);
  }
}

function renderMessage(m) {
  const side    = m.from_me ? 'me' : 'them';
  const checked = selectedIds.has(m.id) ? ' checked' : '';
  const senderLine = !m.from_me
    ? `<div class="msg-sender">${esc(m.sender || 'Unknown')}</div>` : '';

  // Edit + revoke affordances on the meta line. Edited messages show a
  // clickable "edited" tag that opens the version history popover.
  const editTag = m.edited_at
    ? ` <span class="edited-tag" onclick="event.stopPropagation();showEditHistory(${m.id})">· edited</span>`
    : '';
  // Read receipts on outbound messages only (1=server, 2=device, 3=read, 4=played).
  const ackTag = (m.from_me && m.ack)
    ? ` <span class="ack-tag ack-${m.ack}">${ackIcon(m.ack)}</span>`
    : '';
  const timeLine = `<div class="msg-meta">${fmtFull(m.timestamp)}${editTag}${ackTag}</div>`;

  const quotedBanner    = m.quoted_wa_id ? renderQuotedBanner(findQuotedMessage(m.quoted_wa_id)) : '';
  const forwardedTag    = m.is_forwarded ? `<div class="forwarded-tag">↪ Forwarded</div>` : '';
  const revokedTag      = m.revoked_at   ? `<div class="revoked-tag">🚫 Deleted by sender</div>` : '';
  const reactionsRow    = m.reactions    ? renderReactionsRow(m.reactions) : '';

  let content = '';
  if (m.type === 'ptt' || m.type === 'audio') {
    content = renderVoice(m);
  } else if (m.type === 'image' || m.type === 'sticker') {
    // Stickers are .webp images — render them like photos (just smaller)
    content = renderImage(m, m.type === 'sticker');
  } else if (m.type === 'video') {
    content = renderVideo(m);
  } else if (m.type === 'document') {
    content = renderDoc(m);
  } else if (m.type === 'location') {
    content = renderLocation(m);
  } else if (m.type === 'vcard') {
    content = renderVcard(m);
  } else if (m.type === 'poll_creation') {
    content = renderPoll(m);
  } else if (m.type === 'call_log') {
    content = renderCallLog(m);
  } else {
    content = `<div class="bubble">${highlightMentions(m.body || '', m.mentions)}</div>`;
  }

  // Checkbox (visible in select mode) + per-message delete (visible on hover in normal mode)
  const checkbox = `<div class="msg-check" onclick="event.stopPropagation();toggleMsgSelect(${m.id})"></div>`;
  const delBtn   = `<button class="msg-del-btn" onclick="event.stopPropagation();confirmDeleteOne(${m.id})">🗑</button>`;

  const wrapCls = `msg-wrap ${side}${checked}${m.revoked_at ? ' revoked' : ''}`;
  return `<div class="${wrapCls}" data-id="${m.id}" onclick="handleMsgClick(${m.id})">
    ${checkbox}
    <div class="msg-row ${side}" style="max-width:100%">${senderLine}${quotedBanner}${forwardedTag}${revokedTag}${content}${reactionsRow}${timeLine}</div>
    ${delBtn}
  </div>`;
}

function ackIcon(ack) {
  if (ack === 1) return '✓';     // server
  if (ack === 2) return '✓✓';    // device
  if (ack === 3) return '✓✓';    // read (blue via CSS)
  if (ack === 4) return '▶';     // played
  if (ack === -1) return '⚠';    // error
  return '';
}

// Render aggregated reactions as small chips below the bubble.
function renderReactionsRow(reactionsJson) {
  let arr;
  try { arr = JSON.parse(reactionsJson); } catch { return ''; }
  if (!Array.isArray(arr) || !arr.length) return '';
  const chips = arr.map(r => `<span class="reaction-chip">${esc(r.emoji)}${r.count > 1 ? ` ${r.count}` : ''}</span>`).join('');
  return `<div class="reactions-row">${chips}</div>`;
}

// Poll-creation message — name + option list. Live tally is loaded on demand
// (one fetch per poll on first render) and rebuilt on vote_update SSE events.
function renderPoll(m) {
  let opts = [];
  try { opts = JSON.parse(m.poll_options || '[]'); } catch {}
  const lines = opts.map((o, i) => `
    <div class="poll-option" data-idx="${i}">
      <div class="poll-option-bar"><div class="poll-option-fill"></div></div>
      <div class="poll-option-row">
        <span class="poll-option-label">${esc(o)}</span>
        <span class="poll-option-count">0</span>
      </div>
    </div>
  `).join('');
  // Schedule a tally refresh after the bubble is in the DOM.
  if (m.wa_id) setTimeout(() => refreshPollTally(m.id, m.wa_id, opts.length), 0);
  return `<div class="bubble poll-bubble" id="poll-${m.id}" data-poll-wa="${escAttr(m.wa_id || '')}" data-poll-opts="${opts.length}">
    <div class="poll-title">📊 ${esc(m.body || 'Poll')}</div>
    ${lines}
  </div>`;
}

// Call log bubble — direction arrow, outcome (missed/answered), and the
// duration string from the body when present.
function renderCallLog(m) {
  const out = m.from_me;
  const arrow = out ? '↗' : '↙';
  const label = out ? 'Outgoing call' : 'Incoming call';
  const body = (m.body || '').trim();
  const isMissed = /missed/i.test(body);
  const icon = isMissed ? '📵' : '📞';
  const detail = body ? `<span class="call-detail">${esc(body)}</span>` : '';
  return `<div class="bubble call-bubble">
    <span class="call-icon">${icon}</span>
    <span class="call-arrow">${arrow}</span>
    <span class="call-label">${esc(label)}</span>
    ${detail}
  </div>`;
}

async function refreshPollTally(messageId, pollWaId, optionCount) {
  if (!pollWaId) return;
  let votes;
  try {
    const r = await apiFetch(`${API}/polls/${encodeURIComponent(pollWaId)}/votes?userId=${currentUserId}`);
    votes = await r.json();
  } catch { return; }
  if (!Array.isArray(votes)) return;
  const counts = new Array(optionCount).fill(0);
  for (const v of votes) {
    let sel;
    try { sel = JSON.parse(v.selected || '[]'); } catch { continue; }
    if (Array.isArray(sel)) for (const i of sel) if (counts[i] != null) counts[i]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const bubble = document.getElementById(`poll-${messageId}`);
  if (!bubble) return;
  for (const opt of bubble.querySelectorAll('.poll-option')) {
    const idx = parseInt(opt.dataset.idx, 10);
    const c   = counts[idx] || 0;
    const pct = total ? Math.round((c / total) * 100) : 0;
    opt.querySelector('.poll-option-count').textContent = c;
    opt.querySelector('.poll-option-fill').style.width = pct + '%';
  }
}

// Edit-history popover. Fetches the per-message edit log and shows a small
// floating panel with each version. Closing is via outside click.
async function showEditHistory(messageId) {
  document.querySelectorAll('.edit-history-popover').forEach(el => el.remove());
  let rows = [];
  try {
    const r = await apiFetch(`${API}/messages/${messageId}/edits?userId=${currentUserId}`);
    rows = await r.json();
  } catch { return; }
  if (!Array.isArray(rows) || !rows.length) return;
  const items = rows.map(r => `
    <div class="edit-history-item">
      <div class="edit-history-time">${esc(fmtFull(r.edited_at))}</div>
      ${r.prev_body ? `<div class="edit-history-prev">${esc(r.prev_body)}</div>` : ''}
      <div class="edit-history-new">${esc(r.new_body || '')}</div>
    </div>
  `).join('');
  const wrap = document.querySelector(`.msg-wrap[data-id="${messageId}"]`);
  if (!wrap) return;
  const pop = document.createElement('div');
  pop.className = 'edit-history-popover';
  pop.innerHTML = `<div class="edit-history-title">Edit history</div>${items}`;
  wrap.appendChild(pop);
  setTimeout(() => {
    const off = e => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', off); } };
    document.addEventListener('click', off);
  }, 0);
}

// Quoted-reply preview banner — shown above the bubble when this message
// replies to another. Returns empty if the parent isn't currently loaded.
function findQuotedMessage(quotedWaId) {
  if (!quotedWaId) return null;
  return allMessages.find(m => m.wa_id === quotedWaId) || null;
}
function renderQuotedBanner(quoted) {
  if (!quoted) return '';
  const sender = quoted.from_me ? 'You' : (quoted.sender || 'Unknown');
  let preview;
  if (quoted.type === 'image' || quoted.type === 'sticker') preview = '🖼 Photo';
  else if (quoted.type === 'video')                          preview = '🎬 Video';
  else if (quoted.type === 'ptt' || quoted.type === 'audio') preview = '🎙️ Voice message';
  else if (quoted.type === 'document')                       preview = '📄 ' + (quoted.filename || 'Document');
  else if (quoted.type === 'location')                       preview = '📍 Location';
  else if (quoted.type === 'vcard')                          preview = '👤 Contact card';
  else                                                       preview = (quoted.body || '').substring(0, 80);
  return `<div class="quoted-banner" onclick="event.stopPropagation();scrollToMessage(${quoted.id})">
    <div class="quoted-sender">${esc(sender)}</div>
    <div class="quoted-preview">${esc(preview)}</div>
  </div>`;
}
function scrollToMessage(id) {
  const el = document.querySelector(`.msg-wrap[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-flash');
  setTimeout(() => el.classList.remove('msg-flash'), 1200);
}

// Highlight @<number> spans corresponding to mentioned WA contact ids.
function highlightMentions(body, mentionsJson) {
  if (!body) return '';
  if (!mentionsJson) return esc(body);
  let mentions;
  try { mentions = JSON.parse(mentionsJson); } catch { return esc(body); }
  if (!Array.isArray(mentions) || !mentions.length) return esc(body);
  let html = esc(body);
  for (const id of mentions) {
    const num = String(id).split('@')[0];
    if (!/^\d+$/.test(num)) continue;
    html = html.replace(new RegExp('@' + num + '(?!\\d)', 'g'), `<span class="mention">@${num}</span>`);
  }
  return html;
}

// Pull FN: and TEL: from the first vCard so we can render structured info
// instead of raw card text. Falls back to body if parsing fails.
function renderVcard(m) {
  let parsed = null;
  if (m.vcards) {
    try {
      const arr = JSON.parse(m.vcards);
      const raw = Array.isArray(arr) ? arr[0] : null;
      if (raw) {
        const fn  = (raw.match(/^FN:(.+)$/m) || [])[1];
        const tel = (raw.match(/^TEL[^:]*:(.+)$/m) || [])[1];
        parsed = { name: (fn || '').trim(), tel: (tel || '').trim() };
      }
    } catch {}
  }
  if (parsed && (parsed.name || parsed.tel)) {
    const name = parsed.name || (m.body || '').trim();
    return `<div class="bubble vcard-bubble">
      <div class="vcard-row"><span class="vcard-icon">👤</span> ${esc(name || 'Contact')}</div>
      ${parsed.tel ? `<div class="vcard-tel">${esc(parsed.tel)}</div>` : ''}
    </div>`;
  }
  return `<div class="bubble">👤 Contact card${m.body ? ': ' + esc(m.body.substring(0, 80)) : ''}</div>`;
}

// Location bubble that surfaces name/address/url when wwebjs gave them to us.
function renderLocation(m) {
  const hasMeta = m.loc_name || m.loc_address || m.loc_url;
  const lat = (m.lat != null) ? Number(m.lat).toFixed(4) : '?';
  const lng = (m.lng != null) ? Number(m.lng).toFixed(4) : '?';
  if (!hasMeta) return `<div class="bubble">📍 Location (${lat}, ${lng})</div>`;
  return `<div class="bubble loc-bubble">
    <div class="loc-title">📍 ${esc(m.loc_name || 'Location')}</div>
    ${m.loc_address ? `<div class="loc-addr">${esc(m.loc_address)}</div>` : ''}
    ${m.loc_url ? `<div class="loc-url"><a href="${escAttr(m.loc_url)}" target="_blank" rel="noopener noreferrer">${esc(m.loc_url)}</a></div>` : ''}
    <div class="loc-coords">${lat}, ${lng}</div>
  </div>`;
}

function handleMsgClick(id) {
  if (selectMode) toggleMsgSelect(id);
}

function renderVoice(m) {
  const bars = Array.from({length:28}, (_,i) => {
    const h = 4 + Math.abs(Math.sin(i * 0.7 + (m.id||0)) * 20);
    return `<div class="wave-bar" style="height:${h.toFixed(0)}px"></div>`;
  }).join('');

  const id = `voice-${m.id}`;
  // Pass the filename — toggleVoice will load the blob URL on first play
  return `
    <div class="voice-bubble" id="${id}" onclick="toggleVoice('${id}','${esc(m.media_file || '')}')">
      <button class="play-btn" id="btn-${id}">▶</button>
      <div class="waveform">${bars}</div>
      <span class="voice-dur">0:00</span>
    </div>`;
}

function renderImage(m, isSticker = false) {
  if (!m.media_file) return `<div class="bubble">${isSticker ? '🎭 Sticker' : '🖼 Image'} (not downloaded)</div>`;
  const imgId = `img-${m.id}`;
  // Render placeholder immediately, then load the authenticated blob async
  setTimeout(async () => {
    const el = document.getElementById(imgId);
    if (!el) return;
    const url = await loadMediaBlob(m.media_file);
    if (url) {
      el.src = url;
      // Only stickers skip the lightbox click — photos open lightbox
      if (!isSticker) el.closest('.img-bubble').onclick = () => openLightbox(url);
    } else {
      el.parentElement.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--muted)">${isSticker ? '🎭 Sticker' : '🖼 Image'} unavailable</div>`;
    }
  }, 0);

  if (isSticker) {
    // Stickers: smaller, transparent background, no caption
    return `
      <div class="img-bubble" style="background:transparent;border:none;max-width:140px">
        <img id="${imgId}" alt="Sticker" style="min-height:60px;max-height:140px;background:transparent" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      </div>`;
  }

  return `
    <div class="img-bubble">
      <img id="${imgId}" alt="Photo" style="min-height:80px;background:var(--panel)" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      <div class="img-meta">📷 ${esc(m.filename || 'Photo')}</div>
    </div>`;
}

function renderVideo(m) {
  if (!m.media_file) return `<div class="bubble">🎬 Video (not downloaded)</div>`;
  // Use direct URL — videos rely on Range requests for streaming/seeking
  const directUrl = `${API}/media/${encodeURIComponent(m.media_file)}?key=${encodeURIComponent(apiKey)}`;
  // id lets reloadCurrentChatMessages restore currentTime after a DOM wipe
  return `
    <div class="img-bubble">
      <video id="vid-${m.id}" controls preload="metadata" style="width:100%;max-height:200px;display:block" src="${directUrl}"></video>
      <div class="img-meta">🎬 ${esc(m.filename || 'Video')}</div>
    </div>`;
}

function renderDoc(m) {
  const docId = `doc-${m.id}`;
  return `
    <div class="doc-bubble" id="${docId}" onclick="openDoc('${esc(m.media_file || '')}','${esc(m.filename || 'document')}')">
      <div class="doc-icon">📄</div>
      <div>
        <div class="doc-name">${esc(m.filename || m.body || 'Document')}</div>
        <div class="doc-size">${esc(m.mimetype || '')}</div>
      </div>
    </div>`;
}

async function openDoc(filename, name) {
  if (!filename) return;
  const url = await loadMediaBlob(filename);
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

// ── Voice playback ──────────────────────────────────────────────────────
let currentAudio = null;
let currentAudioId = null;

async function toggleVoice(id, filename) {
  if (!filename) return;

  // Pause/resume if already loaded
  if (currentAudioId === id && currentAudio) {
    currentAudio.paused ? currentAudio.play() : currentAudio.pause();
    const btn = document.getElementById(`btn-${id}`);
    if (btn) btn.textContent = currentAudio.paused ? '▶' : '⏸';
    return;
  }

  // Stop previous
  if (currentAudio) {
    currentAudio.pause();
    const prevBtn = document.getElementById(`btn-${currentAudioId}`);
    if (prevBtn) { prevBtn.textContent = '▶'; prevBtn.classList.remove('playing'); }
    currentAudio = null;
  }

  const btn = document.getElementById(`btn-${id}`);
  if (btn) { btn.textContent = '…'; btn.disabled = true; }

  // Use direct authenticated URL — Range requests work natively, no blob needed.
  // The server accepts ?key= via the same fallback used by SSE.
  const directUrl = `${API}/media/${encodeURIComponent(filename)}?key=${encodeURIComponent(apiKey)}`;
  currentAudio   = new Audio(directUrl);
  currentAudioId = id;

  currentAudio.addEventListener('timeupdate', () => {
    const t = currentAudio.currentTime;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    // Requery on each tick — a background chat reload between play sessions
    // would have replaced the .voice-dur span, leaving any captured reference
    // detached. The closure-scoped `id` is stable, so this lookup is cheap.
    const liveDur = document.querySelector(`#${id} .voice-dur`);
    if (liveDur) liveDur.textContent = `${m}:${s}`;
  });

  currentAudio.addEventListener('ended', () => {
    if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); btn.disabled = false; }
    currentAudio = null; currentAudioId = null;
  });

  currentAudio.addEventListener('error', () => {
    console.warn('Audio playback error for', filename, currentAudio.error);
    if (btn) {
      btn.textContent = '⬇';
      btn.title       = 'Click to download (browser cannot play this format)';
      btn.disabled    = false;
      btn.onclick     = (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = directUrl; a.download = filename; a.click();
      };
    }
    currentAudio = null; currentAudioId = null;
  });

  try {
    await currentAudio.play();
    if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); btn.disabled = false; }
  } catch (err) {
    console.warn('Audio play() rejected:', err.message);
    if (btn) { btn.textContent = '▶'; btn.disabled = false; }
  }
}

// ── Lightbox ────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
}

// ── Filter ──────────────────────────────────────────────────────────────
function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderMessages();
}

// ── Search ──────────────────────────────────────────────────────────────
let searchTimeout = null;

function handleSearch(q) {
  clearTimeout(searchTimeout);
  const panel = document.getElementById('search-results');
  const msgs  = document.getElementById('messages');

  if (!q.trim() || !currentUserId) {
    panel.classList.remove('open');
    msgs.style.display = 'flex';
    // On mobile: drop the chat-open body class if no chat was open before
    // searching, so the user lands back on the chat list.
    if (!currentChatId) document.body.classList.remove('chat-open');
    return;
  }

  // On mobile the chat-area (and its child .search-results) is hidden until
  // body.chat-open is set. Flip it on so the results panel is visible.
  document.body.classList.add('chat-open');
  msgs.style.display = 'none';
  panel.classList.add('open');
  panel.innerHTML = `<div class="empty-list"><div class="spinner"></div><span>Searching...</span></div>`;

  searchTimeout = setTimeout(async () => {
    try {
      const r = await apiFetch(`${API}/search?userId=${currentUserId}&q=${encodeURIComponent(q)}`);
      const results = await r.json();
      if (results.length === 0) {
        panel.innerHTML = `<div class="empty-list">No results for "${esc(q)}"</div>`;
        return;
      }
      panel.innerHTML = results.map(m => `
        <div class="search-result-item" onclick="jumpToChat('${escAttr(m.chat_id)}','${escAttr(m.chat_name||m.chat_id)}')">
          <div class="sr-chat">${esc(m.chat_name || m.chat_id)}</div>
          <div class="sr-body">${highlight(esc(m.body||''), q)}</div>
          <div class="sr-time">${fmtFull(m.timestamp)}</div>
        </div>`).join('');
    } catch {
      panel.innerHTML = `<div class="empty-list">Search failed</div>`;
    }
  }, 300);
}

function highlight(text, q) {
  return text.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi'),
    '<span style="background:#2a3d1a;color:var(--accent)">$1</span>');
}

async function jumpToChat(chatId, name) {
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').classList.remove('open');
  document.getElementById('messages').style.display = 'flex';
  await selectChat(chatId, name, false, '?');
}

// ── Escape helpers ──────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(s) {
  return String(s||'').replace(/'/g,"\\'");
}



// ── Select / Delete state ───────────────────────────────────────────────
let selectMode   = false;
let selectedIds  = new Set();
let modalAction  = null;   // function to call on modal confirm

// ── Toggle select mode ──────────────────────────────────────────────────
function toggleSelectMode() {
  selectMode = !selectMode;
  selectedIds.clear();

  const btn     = document.getElementById('select-toggle-btn');
  const msgBox  = document.getElementById('messages');
  const actionBar = document.getElementById('action-bar');

  btn.classList.toggle('active', selectMode);
  msgBox.classList.toggle('select-mode', selectMode);
  actionBar.classList.toggle('visible', selectMode);
  updateSelCount();

  // Re-render so checkboxes / del buttons appear/disappear
  renderMessages();
}

function updateSelCount() {
  const n = selectedIds.size;
  document.getElementById('sel-count').textContent =
    n === 0 ? 'None selected' : n + ' selected';
}

function selectAll() {
  const visible = getVisibleMessages();
  visible.forEach(m => selectedIds.add(m.id));
  updateSelCount();
  renderMessages();
}

function clearSelection() {
  selectedIds.clear();
  updateSelCount();
  renderMessages();
}

function toggleMsgSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  updateSelCount();

  // Flip just this wrapper's checked class without full re-render
  const wrap = document.querySelector('.msg-wrap[data-id="' + id + '"]');
  if (wrap) wrap.classList.toggle('checked', selectedIds.has(id));
}

function getVisibleMessages() {
  let msgs = allMessages;
  if (currentFilter !== 'all') msgs = msgs.filter(m => m.type === currentFilter);
  return msgs;
}

// ── Delete selected messages ────────────────────────────────────────────
function confirmDeleteSelected() {
  const n = selectedIds.size;
  if (n === 0) return;
  openModal(
    'Delete ' + n + ' message' + (n === 1 ? '' : 's') + '?',
    'This will permanently remove ' + n + ' message' + (n === 1 ? '' : 's') + ' and any attached media files from your vault.',
    async function() {
      await apiDeleteMessages(Array.from(selectedIds));
      selectedIds.clear();
      if (selectMode) toggleSelectMode();
      await loadMessages(currentChatId);
      await loadChats();
      await loadStats();
    }
  );
}

// ── Delete single message ───────────────────────────────────────────────
function confirmDeleteOne(id) {
  openModal(
    'Delete this message?',
    'This will permanently remove the message and any attached media file from your vault.',
    async function() {
      await apiDeleteMessages([id]);
      await loadMessages(currentChatId);
      await loadChats();
      await loadStats();
    }
  );
}

// ── Delete entire chat ──────────────────────────────────────────────────
function confirmDeleteChat(chatId, name) {
  openModal(
    'Delete "' + name + '"?',
    'This will permanently delete all messages, voice notes, and photos in this conversation from your vault.',
    async function() {
      await apiDeleteChat(chatId);
      if (currentChatId === chatId) {
        currentChatId = null;
        document.getElementById('chat-header').style.display = 'none';
        document.getElementById('filter-bar').style.display  = 'none';
        document.getElementById('action-bar').classList.remove('visible');
        document.getElementById('messages').innerHTML =
          '<div class="empty"><div class="empty-icon">💬</div><h3>Select a conversation</h3><p>Choose a chat from the sidebar.</p></div>';
      }
      await loadChats();
      await loadStats();
    }
  );
}

// ── Modal helpers ───────────────────────────────────────────────────────
function openModal(title, body, onConfirm) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent  = body;
  document.getElementById('confirm-modal').classList.add('open');
  modalAction = onConfirm;
}

function closeModal() {
  document.getElementById('confirm-modal').classList.remove('open');
  modalAction = null;
}

async function modalConfirm() {
  const action = modalAction;  // capture BEFORE closeModal nulls it
  closeModal();
  if (action) await action();
}

// Close modal on overlay click
document.getElementById('confirm-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// ── API calls ───────────────────────────────────────────────────────────
async function apiDeleteMessages(ids) {
  try {
    const r = await apiFetch(API + '/messages', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUserId, ids }),
    });
    return await r.json();
  } catch (e) {
    console.error('Delete messages failed:', e);
  }
}

async function apiDeleteChat(chatId) {
  try {
    // Server requires ?userId= as a query param to scope the delete
    const url = `${API}/chats/${encodeURIComponent(chatId)}?userId=${currentUserId}`;
    const r   = await apiFetch(url, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return await r.json();
  } catch (e) {
    console.error('Delete chat failed:', e);
    showToast('❌', 'Delete failed', e.message);
  }
}


// ── Multi-user state ─────────────────────────────────────────────────────
let users         = [];          // [{id, name, phone, status}, ...]
let currentUserId = null;        // selected user's DB id
let userStatuses  = {};          // userId → 'online'|'authenticated'|'qr'|'offline'
let qrModalUserId    = null;  // which user's QR modal is open
let qrModalIsNewUser = false; // true if user was just created and has never scanned
let sseSource     = null;        // EventSource connection
let userMenuOpen  = false;
let notifyFromMe  = localStorage.getItem('vault_notify_from_me') === '1';

function toggleFromMeNotifications() {
  notifyFromMe = !notifyFromMe;
  localStorage.setItem('vault_notify_from_me', notifyFromMe ? '1' : '0');
  updateFromMeToggle();
  showToast(
    notifyFromMe ? '🔔' : '🔕',
    notifyFromMe ? 'Outgoing notifications on' : 'Outgoing notifications off',
    notifyFromMe ? 'Toasts will fire for messages YOU send too' : 'Only incoming messages will toast'
  );
}

function updateFromMeToggle() {
  const el = document.getElementById('from-me-toggle');
  if (el) el.classList.toggle('on', notifyFromMe);
}

// ── Avatar helpers ───────────────────────────────────────────────────────
const UCOLORS = [
  ['#1a3329','#25d366'],['#1a2233','#4a9eff'],['#2e1a33','#a855f7'],
  ['#2e1a1a','#ff6b6b'],['#1a2a1a','#86efac'],['#2a2011','#f5a623'],
];
function userColor(id) { return UCOLORS[(id - 1) % UCOLORS.length]; }
function userInitials(name) {
  return (name || '?').split(/[\s@_-]+/).filter(Boolean).slice(0,2).map(w => w[0].toUpperCase()).join('');
}

// ── Render user dropdown ─────────────────────────────────────────────────
function renderUserMenu() {
  const list = document.getElementById('user-menu-list');
  if (!list) return;
  list.innerHTML = users.map(u => {
    const [bg, fg] = userColor(u.id);
    const ini      = userInitials(u.name);
    const st       = userStatuses[u.id] || u.status || 'offline';
    const active   = u.id === currentUserId ? ' active' : '';
    return `<div class="user-menu-item${active}" onclick="selectUser(${u.id})">
      <div class="user-btn-avatar" style="background:${bg};color:${fg}">${ini}</div>
      <div style="flex:1;min-width:0">
        <div class="user-menu-name">${esc(u.name)}</div>
        ${u.phone ? `<div class="user-menu-phone">+${esc(u.phone)}</div>` : ''}
      </div>
      <div class="user-status-dot ${st}"></div>
      <button class="user-menu-del" onclick="event.stopPropagation();confirmRemoveUser(${u.id},'${esc(u.name)}')" title="Remove user">✕</button>
    </div>`;
  }).join('');
}

function updateUserBtn() {
  const u = users.find(x => x.id === currentUserId);
  const nameEl  = document.getElementById('user-btn-name');
  const avEl    = document.getElementById('user-btn-avatar');
  const dotEl   = document.getElementById('user-btn-dot');
  if (!nameEl) return;
  if (!u) {
    nameEl.textContent   = users.length ? 'Select user' : 'No users yet';
    avEl.textContent     = '?';
    avEl.style.background = '#1a3329';
    avEl.style.color     = '#25d366';
    dotEl.className      = 'user-status-dot offline';
    return;
  }
  const [bg, fg] = userColor(u.id);
  const st       = userStatuses[u.id] || u.status || 'offline';
  nameEl.textContent    = u.name;
  avEl.textContent      = userInitials(u.name);
  avEl.style.background = bg;
  avEl.style.color      = fg;
  dotEl.className       = `user-status-dot ${st}`;
}

// ── Toggle dropdown ──────────────────────────────────────────────────────
function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  userMenuOpen = !userMenuOpen;
  menu.classList.toggle('open', userMenuOpen);
  if (userMenuOpen) {
    renderUserMenu();
    // If users haven't loaded yet (or load failed), retry immediately so
    // the dropdown always reflects the current server state when opened.
    if (users.length === 0) loadUsers();
  }
}

// Close dropdown when clicking outside
document.addEventListener('click', e => {
  if (userMenuOpen && !document.getElementById('user-dropdown').contains(e.target)) {
    document.getElementById('user-menu').classList.remove('open');
    userMenuOpen = false;
  }
  // Same for the mobile stats popover
  const sb = document.querySelector('.statsbar');
  if (sb && sb.classList.contains('open')
      && !sb.contains(e.target)
      && !e.target.closest('.stats-trigger')) {
    sb.classList.remove('open');
  }
});

// ── Select user ──────────────────────────────────────────────────────────
async function selectUser(userId) {
  currentUserId = userId;
  currentChatId = null;
  currentFilter = 'all';
  allMessages   = [];
  document.getElementById('user-menu').classList.remove('open');
  userMenuOpen = false;
  // On mobile, switching accounts should drop the user back to the chat list,
  // not leave them parked on the now-empty chat-area panel.
  document.body.classList.remove('chat-open');
  updateUserBtn();
  updateReconnectBanner();

  // Reset chat area
  document.getElementById('chat-header').style.display = 'none';
  document.getElementById('filter-bar').style.display  = 'none';
  document.getElementById('action-bar').classList.remove('visible');
  document.getElementById('messages').innerHTML =
    '<div class="empty"><div class="empty-icon">💬</div><h3>Select a conversation</h3><p>Choose a chat from the sidebar.</p></div>';

  await loadStats();
  await loadChats();
}

// ── Load users ───────────────────────────────────────────────────────────
async function loadUsers() {
  try {
    const r = await apiFetch(`${API}/users`);
    users   = await r.json();
    // Sync statuses from server response
    users.forEach(u => { userStatuses[u.id] = u.status || 'offline'; });
    renderUserMenu();
    updateUserBtn();

    // Auto-select first user if none selected
    if (!currentUserId && users.length > 0) {
      await selectUser(users[0].id);
    }
  } catch(e) {
    console.error('loadUsers:', e);
  }
}

// ── Add user flow ────────────────────────────────────────────────────────
async function openAddUser() {
  document.getElementById('user-menu').classList.remove('open');
  userMenuOpen = false;

  const name = prompt('Enter a name for this WhatsApp account (e.g. "Reda" or "Sara"):');
  if (!name || !name.trim()) return;

  // Create user on server — this immediately starts the WhatsApp session
  let user;
  try {
    const r = await apiFetch(`${API}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    user = await r.json();
  } catch (e) {
    showToast('❌', 'Failed to add user', e.message);
    return;
  }

  users.push(user);
  qrModalUserId    = user.id;
  qrModalIsNewUser = true;  // brand-new — cancel should remove them
  openQRModal(user);
}

// ── Remove user ──────────────────────────────────────────────────────────
function confirmRemoveUser(userId, name) {
  openModal(
    `Remove "${name}"?`,
    `This will permanently delete all messages and media for this account from the vault.`,
    async () => {
      await apiFetch(`${API}/users/${userId}`, { method: 'DELETE' });
      users = users.filter(u => u.id !== userId);
      delete userStatuses[userId];
      if (currentUserId === userId) {
        currentUserId = null;
        currentChatId = null;
        if (users.length > 0) await selectUser(users[0].id);
        else {
          document.getElementById('chat-list').innerHTML = '<div class="empty-list">No users yet</div>';
          document.getElementById('messages').innerHTML  = '<div class="empty"><div class="empty-icon">👤</div><h3>No users</h3><p>Add a user to get started.</p></div>';
        }
      }
      renderUserMenu();
      updateUserBtn();
    }
  );
}

// ── QR modal ─────────────────────────────────────────────────────────────
function openQRModal(user) {
  qrModalUserId = user.id;
  document.getElementById('qr-modal-title').textContent = `Linking ${user.name}`;
  document.getElementById('qr-modal-sub').textContent   = 'Open WhatsApp → Linked Devices → Link a Device and scan the QR code.';
  document.getElementById('qr-box').innerHTML           = '<div class="qr-spinner"></div>';
  document.getElementById('qr-status-badge').textContent = 'Starting session...';
  document.getElementById('qr-status-badge').className   = 'qr-status waiting';
  document.getElementById('qr-modal-overlay').classList.add('open');
  // Poll for QR in case SSE delivers it before we open the modal
  pollQR(user.id);
}

// reason: 'cancel' = user dismissed the modal (X / overlay click) → destroy Chrome
//         'auto'   = system closed it (scan succeeded or QR_TIMEOUT)         → leave the
//                    server-side state alone; /cancel and /disconnect would otherwise
//                    tear down a session that just went online or was already destroyed.
async function closeQRModal(reason = 'cancel') {
  document.getElementById('qr-modal-overlay').classList.remove('open');
  const cancelId  = qrModalUserId;
  const isNew     = qrModalIsNewUser;
  qrModalUserId    = null;
  qrModalIsNewUser = false;
  if (!cancelId || reason === 'auto') return;

  if (isNew) {
    // Brand-new user who never scanned — stop Chrome and remove them.
    try {
      const r = await apiFetch(`${API}/users/${cancelId}/cancel`, { method: 'POST' });
      const d = await r.json();
      if (d.removed) {
        users = users.filter(u => u.id !== cancelId);
        renderUserSelector();
      }
    } catch (_) {}
  } else {
    // Existing user dismissed the Reconnect modal — stop Chrome but keep the
    // user. Status stays 'qr' (red dot) so the Reconnect banner remains visible.
    try { await apiFetch(`${API}/users/${cancelId}/disconnect`, { method: 'POST' }); } catch (_) {}
  }
}

// Show/hide the "Account disconnected — Reconnect" banner above the chat list,
// based on the current user's status. Called from selectUser() and SSE handlers.
function updateReconnectBanner() {
  const banner = document.getElementById('reconnect-banner');
  if (!banner) return;
  if (!currentUserId) { banner.style.display = 'none'; return; }
  const st = userStatuses[currentUserId];
  banner.style.display = (st === 'qr') ? 'flex' : 'none';
}

// Triggered by the Reconnect button — start the session and open the QR modal.
async function reconnectCurrentUser() {
  if (!currentUserId) return;
  const user = users.find(u => u.id === currentUserId);
  if (!user) return;
  try { await apiFetch(`${API}/users/${currentUserId}/connect`, { method: 'POST' }); }
  catch (e) { showToast('❌', 'Reconnect failed', e.message); return; }
  qrModalIsNewUser = false;
  openQRModal(user);
}

async function pollQR(userId) {
  // Poll every 2s for up to 2 minutes — Chrome takes 20-30s to launch on
  // a 1GB VM, and we want to keep refreshing the QR if it regenerates.
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (qrModalUserId !== userId) return; // modal was closed
    try {
      const r = await apiFetch(`${API}/users/${userId}/qr`);
      const d = await r.json();
      if (d.status === 'online') {
        document.getElementById('qr-status-badge').textContent = '✅ Connected!';
        document.getElementById('qr-status-badge').className   = 'qr-status online';
        setTimeout(() => closeQRModal('auto'), 1500);
        return;
      }
      if (d.qr) renderQRInModal(d.qr);   // keep refreshing — don't return
    } catch (_) {}
  }
  // After 2 min with no QR, show a helpful message
  if (qrModalUserId === userId) {
    document.getElementById('qr-status-badge').textContent = '⚠️ Taking too long — check server logs';
    document.getElementById('qr-status-badge').className   = 'qr-status offline';
  }
}

function renderQRInModal(qrDataUrl) {
  const box = document.getElementById('qr-box');
  if (!box) return;
  box.innerHTML = `<img src="${qrDataUrl}" alt="QR code">`;
  document.getElementById('qr-status-badge').textContent = 'Waiting for scan...';
  document.getElementById('qr-status-badge').className   = 'qr-status waiting';
}

// ── SSE — real-time events ────────────────────────────────────────────────
function connectSSE() {
  if (sseSource) sseSource.close();
  // Include API key in URL since EventSource can't send custom headers
  sseSource = new EventSource(`${API}/events?key=${encodeURIComponent(apiKey)}`);

  sseSource.addEventListener('qr', e => {
    const { userId, qr } = JSON.parse(e.data);
    userStatuses[userId] = 'qr';
    renderUserMenu(); updateUserBtn(); updateReconnectBanner();
    if (qrModalUserId === userId) renderQRInModal(qr);
  });

  sseSource.addEventListener('ready', e => {
    const { userId, name } = JSON.parse(e.data);
    userStatuses[userId] = 'online';
    // Update name in local users array (WhatsApp may have returned real name)
    const u = users.find(x => x.id === userId);
    if (u) u.name = name;
    renderUserMenu(); updateUserBtn(); updateReconnectBanner();
    // Close QR modal if this is the user being linked
    if (qrModalUserId === userId) {
      document.getElementById('qr-status-badge').textContent = '✅ Connected!';
      document.getElementById('qr-status-badge').className   = 'qr-status online';
      setTimeout(() => closeQRModal('auto'), 1500);
    }
    // Reload users to get updated phone number
    loadUsers();
  });

  sseSource.addEventListener('status', e => {
    const { userId, status } = JSON.parse(e.data);
    userStatuses[userId] = status;
    renderUserMenu(); updateUserBtn(); updateReconnectBanner();
    // If the QR modal is open for this user and the scan just landed,
    // swap the QR for a spinner and update the badge while chats sync.
    if (qrModalUserId === userId && status === 'authenticated') {
      document.getElementById('qr-box').innerHTML            = '<div class="qr-spinner"></div>';
      document.getElementById('qr-status-badge').textContent = '✓ Scanned — syncing chats...';
      document.getElementById('qr-status-badge').className   = 'qr-status waiting';
    }
  });

  sseSource.addEventListener('qr_timeout', e => {
    const { userId } = JSON.parse(e.data);
    // Auto-close the modal — Chrome was already destroyed by QR_TIMEOUT.
    // 'auto' so we don't fire a second /disconnect that would do nothing.
    if (qrModalUserId === userId) closeQRModal('auto');
  });

  sseSource.addEventListener('message', async e => {
    const { userId, userName, chatName, sender, body, type, fromMe } = JSON.parse(e.data);
    if (fromMe && !notifyFromMe) return; // don't toast your own messages

    const ICONS = { chat:'💬', ptt:'🎙️', audio:'🎵', image:'🖼️', video:'🎬', document:'📄', sticker:'🎭', location:'📍' };
    const icon  = ICONS[type] || '📨';
    const title = `${userName} ← ${sender}`;
    const sub   = type === 'chat' ? (body || '').substring(0, 60)
                : type === 'ptt'  ? 'Voice message'
                : type === 'image'? 'Photo'
                : type === 'video'? 'Video'
                : type === 'sticker' ? 'Sticker'
                : type === 'audio'? 'Audio'
                : type === 'document' ? 'Document'
                : type;

    showToast(icon, title, sub);

    // Refresh chat list if this message belongs to the active user
    if (userId === currentUserId) {
      loadChats();
      await reloadCurrentChatMessages();
    }
  });

  sseSource.addEventListener('message_edit', async e => {
    const { userId } = JSON.parse(e.data);
    if (userId === currentUserId) await reloadCurrentChatMessages();
  });

  sseSource.addEventListener('message_revoke', async e => {
    const { userId } = JSON.parse(e.data);
    if (userId === currentUserId) await reloadCurrentChatMessages();
  });

  // Reactions are part of msgFingerprint — a chat reload picks them up via
  // the diff-render. No per-bubble surgical update needed.
  sseSource.addEventListener('reaction', async e => {
    const { userId } = JSON.parse(e.data);
    if (userId === currentUserId) await reloadCurrentChatMessages();
  });

  // Vote updates only affect poll bubbles. Re-fetch the tally for any
  // visible poll bubble with that wa_id; no full chat reload needed.
  sseSource.addEventListener('vote_update', e => {
    const { userId, pollWaId } = JSON.parse(e.data);
    if (userId !== currentUserId || !pollWaId) return;
    const bubble = document.querySelector(`.poll-bubble[data-poll-wa="${pollWaId}"]`);
    if (!bubble) return;
    const messageId  = parseInt(bubble.id.replace('poll-', ''), 10);
    const optionCount = parseInt(bubble.dataset.pollOpts || '0', 10);
    refreshPollTally(messageId, pollWaId, optionCount);
  });

  sseSource.onerror = () => {
    // Reconnect after 5s on error
    setTimeout(connectSSE, 5000);
  };
}

// ── Profile modal ─────────────────────────────────────────────────────────
let profileModalChatId   = null;
let currentLatestProfile = null; // live snapshot — "← Latest" returns here
let viewingSnapshot      = false;
let profileNavStack      = [];   // member drill-down breadcrumbs
let historyRows          = [];   // cached version list while history panel is open

function showProfileBackBtn(label) {
  const btn = document.getElementById('profile-back-btn');
  btn.textContent = label;
  btn.hidden = false;
}
function hideProfileBackBtn() {
  document.getElementById('profile-back-btn').hidden = true;
}

function _resetHistoryPanel() {
  document.getElementById('profile-history').innerHTML   = '';
  document.getElementById('profile-history').hidden      = true;
  document.getElementById('profile-history-btn').textContent = 'Show history';
  historyRows = [];
}

async function openProfileModal(chatId) {
  if (!chatId) return;
  profileModalChatId   = chatId;
  currentLatestProfile = null;
  viewingSnapshot      = false;
  profileNavStack      = [];
  historyRows          = [];
  hideProfileBackBtn();

  document.getElementById('profile-pic-large').innerHTML = '';
  document.getElementById('profile-name').textContent    = '';
  document.getElementById('profile-sub').textContent     = '';
  document.getElementById('profile-fields').innerHTML    = '<div class="empty"><div class="spinner"></div></div>';
  _resetHistoryPanel();
  document.getElementById('profile-modal').classList.add('open');

  // 1. Paint what we already have — instant.
  let cached = null;
  try {
    const r = await apiFetch(`${API}/chats/${encodeURIComponent(chatId)}/profile?userId=${currentUserId}`);
    cached = await r.json();
    currentLatestProfile = cached;
    paintProfile(cached);
    decorateProfileExtras(chatId);
  } catch {
    document.getElementById('profile-fields').innerHTML = '<div class="empty"><h3>Failed to load profile</h3></div>';
  }

  // 2. Background refresh — dedupes server-side, updates if something changed.
  if (profileModalChatId !== chatId) return;
  try {
    const r = await apiFetch(`${API}/chats/${encodeURIComponent(chatId)}/profile/refresh?userId=${currentUserId}`, { method: 'POST' });
    if (!r.ok) return;
    const fresh = await r.json();
    if (profileModalChatId !== chatId) return;
    if (fresh && (!cached || fresh.id !== cached.id)) {
      currentLatestProfile = fresh;
      if (!viewingSnapshot) paintProfile(fresh);
      if (chatId === currentChatId) {
        const headerName = document.getElementById('chat-name')?.textContent || fresh.name || '?';
        setHeaderAvatar(headerName, fresh.pic_filename);
      }
    }
  } catch {/* session offline — leave cached view */}
}

function closeProfileModal() {
  document.getElementById('profile-modal').classList.remove('open');
  profileModalChatId   = null;
  currentLatestProfile = null;
  viewingSnapshot      = false;
  profileNavStack      = [];
  historyRows          = [];
  hideProfileBackBtn();
}

// ── Member drill-down ──────────────────────────────────────────────────────
async function openMemberProfile(memberId) {
  // Push current view onto the breadcrumb stack.
  profileNavStack.push({
    chatId:    profileModalChatId,
    profile:   currentLatestProfile,
    backLabel: document.getElementById('profile-name').textContent || 'Back',
  });

  profileModalChatId   = memberId;
  viewingSnapshot      = false;
  currentLatestProfile = null;
  showProfileBackBtn(`← ${profileNavStack[profileNavStack.length - 1].backLabel}`);

  document.getElementById('profile-pic-large').innerHTML = '';
  document.getElementById('profile-name').textContent    = '';
  document.getElementById('profile-sub').textContent     = '';
  document.getElementById('profile-fields').innerHTML    = '<div class="empty"><div class="spinner"></div></div>';
  _resetHistoryPanel();

  // 1. Paint cached snapshot (may be null for contacts we haven't visited).
  let cached = null;
  try {
    const r = await apiFetch(`${API}/chats/${encodeURIComponent(memberId)}/profile?userId=${currentUserId}`);
    cached = await r.json();
    currentLatestProfile = cached;
    paintProfile(cached);
  } catch {}

  // 2. Background refresh pulls pic, about, phone from WhatsApp.
  if (profileModalChatId !== memberId) return;
  try {
    const r = await apiFetch(`${API}/chats/${encodeURIComponent(memberId)}/profile/refresh?userId=${currentUserId}`, { method: 'POST' });
    if (!r.ok) return;
    const fresh = await r.json();
    if (profileModalChatId !== memberId) return;
    if (fresh && (!cached || fresh.id !== cached.id)) {
      currentLatestProfile = fresh;
      if (!viewingSnapshot) paintProfile(fresh);
    }
  } catch {}
}

// ── History snapshot navigation ────────────────────────────────────────────
function viewHistorySnapshot(idx) {
  const v = historyRows[idx];
  if (!v) return;
  viewingSnapshot = true;
  showProfileBackBtn('← Latest');
  paintProfile(v);
  document.getElementById('profile-history').hidden      = true;
  document.getElementById('profile-history-btn').textContent = 'Show history';
}

function viewLatestProfile() {
  viewingSnapshot = false;
  if (profileNavStack.length > 0) {
    showProfileBackBtn(`← ${profileNavStack[profileNavStack.length - 1].backLabel}`);
  } else {
    hideProfileBackBtn();
  }
  paintProfile(currentLatestProfile);
}

// ── Back button ────────────────────────────────────────────────────────────
function profileModalBack() {
  if (viewingSnapshot) {
    viewLatestProfile();
    return;
  }
  if (profileNavStack.length === 0) return;
  const prev = profileNavStack.pop();
  profileModalChatId   = prev.chatId;
  currentLatestProfile = prev.profile;
  viewingSnapshot      = false;
  _resetHistoryPanel();
  paintProfile(prev.profile);
  profileNavStack.length > 0
    ? showProfileBackBtn(`← ${profileNavStack[profileNavStack.length - 1].backLabel}`)
    : hideProfileBackBtn();
}

function parseParticipants(json) {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

// Format a phone number for display. Prefer the E.164 we resolved server-side
// via Contact.number; fall back to parsing the raw id, but only when it's a
// legacy @c.us id (the @lid user-part is NOT a phone number, so showing it
// would mislead — return a placeholder instead).
function formatPhone(number, fallbackId) {
  if (number) return '+' + String(number).replace(/^\+/, '');
  const id = String(fallbackId || '');
  // Only parse the user-part for @c.us ids — those genuinely contain the
  // phone. @lid user-parts are WhatsApp-internal privacy ids, not phones.
  if (id.endsWith('@c.us')) return '+' + id.split('@')[0];
  return null; // caller decides what to show when phone is unavailable
}

function paintProfile(p) {
  const chatId = profileModalChatId || '';
  const isGroup = chatId.endsWith('@g.us');
  const headerName = document.getElementById('chat-name')?.textContent || '';
  const name = (p && p.name) || headerName || chatId.split('@')[0] || '?';
  const participants = parseParticipants(p?.participants);

  // Big picture
  const picBox = document.getElementById('profile-pic-large');
  if (p && p.pic_filename) {
    picBox.innerHTML = `<img class="profile-pic-img"
        src="${API}/media/${encodeURIComponent(p.pic_filename)}?key=${encodeURIComponent(apiKey)}"
        data-name="${escAttr(name)}"
        onerror="onProfilePicError(this)">`;
  } else {
    const [bg, fg] = avatarColor(name);
    picBox.innerHTML = `<div class="profile-pic-fallback" style="background:${bg};color:${fg}">${esc(initials(name))}</div>`;
  }

  document.getElementById('profile-name').textContent = name;

  let sub = '';
  if (isGroup) {
    sub = participants ? `Group · ${participants.length} members` : 'Group';
  } else if (chatId) {
    sub = formatPhone(p?.phone, chatId) || '';
  }
  if (p && p.is_business) sub += sub ? ' · 🟢 Business' : '🟢 Business';
  document.getElementById('profile-sub').textContent = sub;

  const rows = [];
  if (p && p.about)       rows.push(['About',        esc(p.about)]);
  if (p && p.description) rows.push(['Description',  esc(p.description)]);
  // Pushname (what they call themselves on WA) — only show if it differs from
  // the name we already have at the top.
  if (p && p.pushname && p.pushname !== name) rows.push(['Pushname', esc(p.pushname)]);
  if (p && p.business_profile) {
    const html = renderBusinessProfile(p.business_profile);
    if (html) rows.push(['Business', html]);
  }
  if (isGroup && participants) {
    const items = participants.map(m => {
      const tag = m.isSuperAdmin ? ' <span class="participant-tag">owner</span>'
                : m.isAdmin      ? ' <span class="participant-tag">admin</span>'
                : '';
      const phone = formatPhone(m.number, m.id);
      const avatarName = m.name || phone || m.id;
      return `<button class="participant member-btn" onclick="openMemberProfile('${escAttr(m.id)}')">
        ${renderMemberAvatar(avatarName, m.pic_filename)}
        <span class="member-phone">${esc(phone)}</span>${tag}
      </button>`;
    }).join('');
    rows.push(['Members', `<div class="participant-list">${items}</div>`]);
  }
  if (p && p.fetched_at)  rows.push(['Last checked', esc(fmtFull(p.fetched_at))]);

  document.getElementById('profile-fields').innerHTML = rows.length
    ? rows.map(([k, v]) => `<div class="profile-field"><div class="profile-field-key">${esc(k)}</div><div class="profile-field-val">${v}</div></div>`).join('')
    : '<div class="profile-field profile-field-empty">No additional info available.</div>';
}

// Best-effort rendering of WA's business profile blob — surfaces address,
// email, websites, vertical, and hours when present, ignores fields we
// don't recognize. Returns '' if the JSON is empty or unparseable.
function renderBusinessProfile(json) {
  let bp;
  try { bp = JSON.parse(json); } catch { return ''; }
  if (!bp || typeof bp !== 'object') return '';
  const lines = [];
  const addr = [bp.address, bp.city, bp.state, bp.zip].filter(Boolean).join(', ');
  if (addr)        lines.push(`<div>📍 ${esc(addr)}</div>`);
  if (bp.email)    lines.push(`<div>✉️ ${esc(bp.email)}</div>`);
  if (Array.isArray(bp.website)) {
    for (const w of bp.website) lines.push(`<div>🔗 <a href="${escAttr(w)}" target="_blank" rel="noopener noreferrer">${esc(w)}</a></div>`);
  } else if (typeof bp.website === 'string' && bp.website) {
    lines.push(`<div>🔗 <a href="${escAttr(bp.website)}" target="_blank" rel="noopener noreferrer">${esc(bp.website)}</a></div>`);
  }
  if (bp.vertical) lines.push(`<div>🏷 ${esc(bp.vertical)}</div>`);
  if (bp.description) lines.push(`<div>${esc(bp.description)}</div>`);
  return lines.join('') || '';
}

// Append "Previously / Recent activity" rows to the profile-fields list
// after the main profile has painted. Both fetches run in parallel and any
// failure is silent — these are decorative, not load-blocking.
async function decorateProfileExtras(chatId) {
  if (!chatId || profileModalChatId !== chatId) return;
  const isGroup = chatId.endsWith('@g.us');
  try {
    if (isGroup) {
      const r = await apiFetch(`${API}/chats/${encodeURIComponent(chatId)}/group-events?userId=${currentUserId}`);
      const events = await r.json();
      if (profileModalChatId !== chatId) return;
      appendProfileExtraRow('Recent activity', renderGroupEventsList(events));
    } else {
      const r = await apiFetch(`${API}/contacts/${encodeURIComponent(chatId)}/changes?userId=${currentUserId}`);
      const changes = await r.json();
      if (profileModalChatId !== chatId) return;
      appendProfileExtraRow('Previously', renderContactChangesList(changes));
    }
  } catch { /* silent — extras are optional */ }
}

function appendProfileExtraRow(key, valHtml) {
  if (!valHtml) return;
  const fields = document.getElementById('profile-fields');
  if (!fields) return;
  const row = document.createElement('div');
  row.className = 'profile-field';
  row.innerHTML = `<div class="profile-field-key">${esc(key)}</div><div class="profile-field-val">${valHtml}</div>`;
  fields.appendChild(row);
}

function renderGroupEventsList(events) {
  if (!Array.isArray(events) || !events.length) return '';
  // Newest first, cap at 20 — older history is in the DB if needed.
  const recent = events.slice(-20).reverse();
  return `<div class="group-events-list">${recent.map(e => {
    const label = describeGroupEvent(e);
    return `<div class="group-event"><span class="group-event-time">${esc(fmtFull(e.timestamp))}</span> ${label}</div>`;
  }).join('')}</div>`;
}

function describeGroupEvent(e) {
  const actor = e.actor_id ? esc(e.actor_id.split('@')[0]) : 'Someone';
  let targets = [];
  try { targets = JSON.parse(e.target_ids || '[]').map(t => t.split('@')[0]); } catch {}
  const targetStr = targets.length ? esc(targets.join(', ')) : '';
  switch (e.event_type) {
    case 'join':              return targetStr ? `${actor} added ${targetStr}` : `${actor} joined`;
    case 'leave':             return targetStr ? `${actor} removed ${targetStr}` : `${actor} left`;
    case 'admin_change':      return `${actor} changed admins${targetStr ? ': ' + targetStr : ''}`;
    case 'update':            return `${actor} updated the group${e.body ? ': ' + esc(e.body.substring(0, 60)) : ''}`;
    case 'membership_request':return `${actor} requested to join`;
    default:                  return `${actor} · ${esc(e.event_type)}`;
  }
}

function renderContactChangesList(changes) {
  if (!Array.isArray(changes) || !changes.length) return '';
  return `<div class="contact-changes-list">${changes.map(c => {
    const oldNum = (c.old_id || '').split('@')[0];
    return `<div class="contact-change">+${esc(oldNum)} <span class="muted">· ${esc(fmtFull(c.timestamp))}</span></div>`;
  }).join('')}</div>`;
}

function onProfilePicError(img) {
  const name = img.getAttribute('data-name') || '?';
  const [bg, fg] = avatarColor(name);
  const div = document.createElement('div');
  div.className = 'profile-pic-fallback';
  div.style.background = bg;
  div.style.color = fg;
  div.textContent = initials(name);
  img.replaceWith(div);
}

async function toggleProfileHistory() {
  const panel = document.getElementById('profile-history');
  const btn   = document.getElementById('profile-history-btn');
  if (!panel.hidden) {
    panel.hidden = true;
    btn.textContent = 'Show history';
    return;
  }
  if (!profileModalChatId) return;
  panel.hidden = false;
  btn.textContent = 'Hide history';
  panel.innerHTML = '<div class="empty"><div class="spinner"></div></div>';
  try {
    const r    = await apiFetch(`${API}/chats/${encodeURIComponent(profileModalChatId)}/profile/history?userId=${currentUserId}`);
    const rows = await r.json();
    historyRows = rows; // cache so viewHistorySnapshot can look up by index
    panel.innerHTML = rows.length
      ? rows.map((v, i) => `<div class="history-date-item" onclick="viewHistorySnapshot(${i})">${esc(fmtFull(v.fetched_at))}</div>`).join('')
      : '<div class="profile-field profile-field-empty">No version history yet.</div>';
  } catch {
    panel.innerHTML = '<div class="profile-field profile-field-empty">Failed to load history.</div>';
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(icon, title, sub) {
  const container = document.getElementById('toast-container');
  const id        = 'toast-' + Date.now();
  const el        = document.createElement('div');
  el.className    = 'toast';
  el.id           = id;
  el.innerHTML    = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      <div class="toast-sub">${esc(sub)}</div>
    </div>
    <button class="toast-close" onclick="document.getElementById('${id}').remove()">✕</button>`;
  container.appendChild(el);
  // Auto-dismiss after 5s
  setTimeout(() => { try { el.remove(); } catch(_) {} }, 5000);
}

// ── Auto-refresh ────────────────────────────────────────────────────────
async function refresh() {
  await loadUsers();
  await loadStats();
  await loadChats();
  await reloadCurrentChatMessages();
}

// ── Init ────────────────────────────────────────────────────────────────
(async () => {
  if (apiKey) {
    // Returning visitor with a cached key — validate it first
    try {
      const r = await fetch(`${API}/stats`, { headers: { 'X-API-Key': apiKey } });
      if (r.status === 401) {
        sessionStorage.removeItem('vault_api_key');
        apiKey = '';
        document.getElementById('login-overlay').classList.add('open');
        return;
      }
      document.getElementById('login-overlay').classList.remove('open');
      updateFromMeToggle();
      connectSSE();
      await loadUsers();
      refreshTimer = setInterval(async () => {
        await loadStats();
        await loadChats();
        await reloadCurrentChatMessages();
      }, 10000);
    } catch {
      document.getElementById('login-overlay').classList.add('open');
    }
  }
  // else: login overlay is already open (default)
})();
