# WhatsApp Vault

> Self-hosted WhatsApp backup with a web dashboard.

Connect any number of WhatsApp accounts and capture every message — text, voice notes, photos, videos, stickers, documents, locations — into a local SQLite database. Browse, search, and manage everything from a clean web UI on your own server.

![Node](https://img.shields.io/badge/node-20%2B-green) ![Platform](https://img.shields.io/badge/platform-linux-lightgrey) ![License](https://img.shields.io/badge/license-personal--use-blue)

---

## Table of contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Detailed installation](#detailed-installation)
- [Linking a WhatsApp account](#linking-a-whatsapp-account)
- [Dashboard](#dashboard)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [File layout](#file-layout)
- [How it works](#how-it-works)
- [API reference](#api-reference)
- [Database schema](#database-schema)
- [Backup & restore](#backup--restore)
- [Updating](#updating)
- [Security notes](#security-notes)
- [Built with](#built-with)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [License](#license)

---

## Features

- 🔗 **Multi-account** — link multiple WhatsApp numbers, each in its own isolated session
- 💬 **Captures everything** — text, voice notes, photos, videos, stickers, documents, locations, contact cards
- 🔔 **Live notifications** — toast in the dashboard for every new message, with optional outgoing-message alerts
- 🔍 **Full-text search** — scoped per account
- 🗑 **Bulk delete** — clear individual messages or entire conversations (media files removed too)
- ⏪ **Pagination** — load older messages on demand, no full-history downloads
- 🔐 **API-key auth** — single-key protection on every endpoint, including the real-time SSE stream
- 📦 **Lightweight** — runs on a 1 GB VM, single Node process, SQLite storage
- 🎵 **In-browser playback** — voice notes, audio, and video stream directly in the dashboard
- 🖼 **Image lightbox** — click any photo to view full-size

---

## Screenshots

> Add screenshots here once available — `docs/screenshots/dashboard.png`, `docs/screenshots/qr-modal.png`, etc.

---

## Requirements

- **Node.js 20+** (works on 22)
- **Google Chrome or Chromium** installed system-wide
- **Linux** (Ubuntu/Debian recommended; tested on Ubuntu 22.04 / 24.04)
- **2 GB RAM**, or 1 GB RAM + 2 GB swap if running on a small VM
- A WhatsApp account on a phone (the source of messages)

---

## Quick start

```bash
# 1. Get the code
git clone <this-repo> whatsapp-vault
cd whatsapp-vault
npm install

# 2. Generate an API key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Create .env in the project root
cat > .env <<EOF
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
DASHBOARD_API_KEY=<paste your generated key>
EOF

# 4. Start with PM2
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Open `http://<your-server>:3001`, paste your API key, and you're in.

---

## Detailed installation

### Install Chrome (Ubuntu)

```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
  | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt update && sudo apt install -y google-chrome-stable
```

### Install Node 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Add swap (only if RAM ≤ 1 GB)

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h    # verify Swap shows 2.0G
```

### Open the dashboard port

```bash
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save
```

If you're behind a cloud firewall (Oracle Cloud, AWS, GCP), also add an ingress rule for TCP/3001 in your VPC/security list.

### Run it

Then follow steps 1–4 from the [Quick start](#quick-start). To verify it's running:

```bash
pm2 logs vault
```

You should see `🌐 Dashboard: http://0.0.0.0:3001`.

---

## Linking a WhatsApp account

1. Open the dashboard and log in with your API key
2. Click the user dropdown (top-right) → **+ Add user**
3. Enter a display name (e.g. "Personal", "Work")
4. A QR-code modal opens. On your phone:
   **WhatsApp → Settings → Linked Devices → Link a Device**
5. Scan the QR — the modal closes automatically when authentication completes (~30 seconds)

The account's real name and phone number are pulled from WhatsApp once linked. Repeat steps 2–5 to add more accounts. Each runs in its own isolated Chrome session under `.wwebjs_auth/session-N/`.

---

## Dashboard

| Element | What it does |
|---|---|
| **User dropdown** (top-right) | Switch between linked accounts. Status dot: 🟢 online · 🟡 awaiting QR · ⚪ offline |
| **Search box** | Full-text search across the selected user's messages (limit 100 results) |
| **Filter pills** | Filter by message type (All, Voice, Photos, Videos, Stickers, etc.) |
| **Hover a chat** | `✕` button to delete the entire conversation |
| **Hover a message** | `🗑` button to delete that single message |
| **"Select" pill** | Multi-select mode — tick messages, then bulk-delete |
| **Toggle in user menu** | Also notify on outgoing messages (off by default) |
| **Click a photo** | Opens a full-size lightbox |
| **Click a voice note** | Plays in place with a waveform indicator |
| **Click a document** | Downloads via the authenticated media route |

The chat list auto-refreshes every 10 seconds. Live messages stream in via Server-Sent Events.

---

## Configuration

All configuration lives in `.env`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `DASHBOARD_API_KEY` | yes | — | 64-char hex key. The server refuses to start without it. |
| `PUPPETEER_EXECUTABLE_PATH` | recommended | auto-detected | Path to Chrome/Chromium. Auto-detects common paths if unset. |
| `PORT` | no | `3001` | Dashboard HTTP port |

Code-level constants you can tune in `bot/session-manager.js`:

| Constant | Default | Purpose |
|---|---|---|
| `QR_TIMEOUT` | 5 min | Restart the session if QR is never scanned |
| `READY_TIMEOUT` | 40 s | Restart if WhatsApp Web doesn't load after authentication |
| `RECONNECT_DELAY` | 8 s | Pause between failed start and the next attempt |
| `MAX_MEDIA_BYTES` | 10 MB | (in `database.js`) Files larger than this are skipped |

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  PM2 process: vault                                  │
│                                                      │
│   bot/index.js                                       │
│      ├── SessionManager                              │
│      │     └── Session × N (one per WA account)      │
│      │           ├── whatsapp-web.js Client          │
│      │           ├── headless Chrome                 │
│      │           ├── message queue                   │
│      │           └── late-media retry queue          │
│      ├── SQLite (vault.db, WAL mode)                 │
│      └── dashboard/server.js                         │
│            ├── Express API (/api/*)                  │
│            ├── SSE stream (/api/events)              │
│            └── Static dashboard                      │
└──────────────────────────────────────────────────────┘
                          │
                          ▼
                     Web browser
                  (HTML + vanilla JS)
```

The bot and dashboard run in a single Node process so they share the same `SessionManager` instance. Events flow correctly and Chrome sessions don't conflict.

---

## File layout

```
whatsapp-vault/
├── bot/
│   ├── index.js             # Entry point
│   ├── session-manager.js   # WhatsApp session lifecycle
│   ├── manager-instance.js  # Shared singleton holder
│   └── database.js          # SQLite schema + queries
├── dashboard/
│   ├── server.js            # API + SSE
│   └── public/index.html    # Dashboard UI (single file)
├── ecosystem.config.js      # PM2 config
├── migrate-bin-files.js     # Optional one-shot media-rename utility
├── package.json
├── .env                     # Your secrets (never commit)
└── .gitignore
```

Generated at runtime:

- `vault.db`, `vault.db-wal`, `vault.db-shm` — SQLite database
- `media/` — saved attachments, named `<userId>_<waId>.<ext>`
- `.wwebjs_auth/session-N/` — one folder per linked account

---

## How it works

**Capturing messages** — Each linked account runs a headless Chrome instance via `whatsapp-web.js`. When a message arrives, the bot downloads any attached media (with retry on failure for large files), persists everything to SQLite in a single transaction, and writes the media to disk only after the DB commit succeeds. This avoids orphaned files on crash.

**Late media** — Newly-sent stickers and freshly-captured photos sometimes hit WhatsApp's CDN a few seconds after the message event. If the initial download returns nothing, the message is queued for delayed retry at 3s/8s/20s and patched into the existing DB row when the file is finally available. Bursts of stickers are processed sequentially to avoid overwhelming the WhatsApp bridge.

**Real-time UI** — The dashboard uses Server-Sent Events (`/api/events`) to receive `qr`, `ready`, `status`, and `message` events as they happen. Toasts appear instantly when any account receives a message.

**Resilience** — Sessions auto-reconnect on disconnect with exponential backoff, isolate harmless transient errors from real ones, and recover gracefully from Chrome OOM kills (with a longer cooldown so the kernel can reclaim memory).

**Multi-tenancy** — Every database row is scoped by `user_id` with cascading foreign keys. Deleting a user removes all their messages, chats, and media in one transaction. Each user has its own Chrome session folder, so accounts can never see each other's data.

---

## API reference

All endpoints require an `X-API-Key` header. The SSE endpoint accepts the key as a `?key=` query parameter since `EventSource` can't send custom headers.

### Authentication

```
X-API-Key: <your DASHBOARD_API_KEY>
```

### Users

```
GET    /api/users                     List users with live status
POST   /api/users                     Body: {name} — adds user, starts session
DELETE /api/users/:id                 Remove user, delete all their data
GET    /api/users/:id/qr              Current QR (data URL) and status
POST   /api/users/:id/cancel          Cancel a pending QR session
```

### Chats and messages

```
GET    /api/chats?userId=N
GET    /api/chats/:chatId/messages?userId=N&limit=&offset=
DELETE /api/chats/:chatId?userId=N
DELETE /api/messages                  Body: {userId, ids: [...]}
```

### Misc

```
GET    /api/bot-status                {online, beat_at}
GET    /api/stats?userId=N            Counts (omit userId for global stats)
GET    /api/search?userId=N&q=...     Full-text search
GET    /api/media/:filename           Authenticated media stream
GET    /api/events                    SSE: qr / ready / status / message
```

### Example

```bash
curl -H "X-API-Key: $KEY" http://localhost:3001/api/users
```

---

## Database schema

Three tables, all scoped by `user_id` with FK cascade:

```sql
users      (id, name, phone, status, created_at)
messages   (id, user_id, wa_id, chat_id, chat_name, from_me, sender,
            body, type, timestamp, media_file, mimetype, filename, lat, lng)
chats      (id, user_id, chat_id, name, is_group, last_msg_at,
            last_body, last_type, msg_count, updated_at)
bot_status (id, state, beat_at)
```

Indexed on `(user_id)`, `(user_id, chat_id)`, `timestamp`, and `type`. WAL mode is enabled with `wal_autocheckpoint=100` for predictable I/O on burstable VMs.

---

## Backup & restore

Everything you need lives in three places: the database, the media folder, and the WhatsApp session folders.

### Backup

```bash
pm2 stop vault
tar czf vault-backup-$(date +%F).tar.gz vault.db media .wwebjs_auth .env
pm2 start vault
```

### Restore on another server

```bash
# Fresh install of the project, then:
pm2 stop vault   # if already running
tar xzf vault-backup-YYYY-MM-DD.tar.gz
pm2 start vault
```

The `.wwebjs_auth/` folder preserves your linked sessions, so no QR re-scan is needed.

---

## Updating

```bash
cd ~/whatsapp-vault
git pull
npm install
pm2 restart vault
```

Your `.env`, `vault.db`, `media/`, and `.wwebjs_auth/` are not touched.

---

## Security notes

- **The API key is the only protection.** Treat it like a password. Generate 32 random bytes (64 hex chars).
- **Never commit `.env`** — it's in `.gitignore` for a reason.
- **HTTPS is recommended** if exposing the dashboard publicly. Put a reverse proxy (Caddy, Nginx, Cloudflare Tunnel) in front and terminate TLS there.
- **Rotate the API key** if you suspect it's been leaked: regenerate, update `.env`, then `pm2 delete all && pm2 start ecosystem.config.js`.
- **Be aware of WhatsApp's terms.** Linked devices are intended for personal use. Don't use this to spy on people without their consent.

---

## Built with

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) — WhatsApp Web protocol client
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — synchronous SQLite for Node
- [Express](https://expressjs.com/) — HTTP server
- [PM2](https://pm2.keymetrics.io/) — process manager
- [Puppeteer](https://pptr.dev/) — headless Chrome automation (via whatsapp-web.js)

---

## Roadmap

Some ideas for future improvements:

- [ ] Export to JSON / mbox / HTML
- [ ] Per-user message retention policy (auto-delete after N days)
- [ ] Optional encrypted media storage at rest
- [ ] Multi-user dashboard auth (multiple API keys with per-account scoping)
- [ ] Metrics endpoint (Prometheus-compatible)
- [ ] Docker image
- [ ] HTTPS / Let's Encrypt integration
- [ ] Mobile-friendly responsive layout

PRs welcome.

---

## FAQ

**Will this get my WhatsApp account banned?**
WhatsApp's terms permit linked devices for personal use. Behaviour-wise, this acts like the official desktop app. That said, it's an unofficial integration — use at your own risk and don't run automation that looks like spam.

**Does it download my entire history?**
No, only messages received while the bot is running. WhatsApp Linked Devices doesn't expose backfill of old messages.

**Can I run it on a Raspberry Pi?**
A Pi 4 with 4 GB works well. Pi 3 will struggle because of Chrome's memory footprint.

**Multiple users on the same machine?**
Yes — that's the core feature. Add as many accounts as RAM permits. Budget ~300 MB per account for Chrome.

**Where are my media files stored?**
In `media/` next to `vault.db`. Filenames are `<userId>_<waMessageId>.<ext>`.

**How big is the database?**
Pure text is tiny — millions of messages fit in under 1 GB. Media dominates disk usage; the 10 MB per-file cap stops single videos from filling your disk silently.

---

## License

Personal-use project. Not affiliated with WhatsApp or Meta. Use responsibly.