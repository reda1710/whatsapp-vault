#!/usr/bin/env node
'use strict';

// One-shot migration to rename existing .bin media files using their stored
// mimetype. Run once after upgrading: `node migrate-bin-files.js`

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH   = path.join(__dirname, 'vault.db');
const MEDIA_DIR = path.join(__dirname, 'media');

function getExtension(mime) {
  if (!mime) return null;
  const base = String(mime).toLowerCase().split(';')[0].trim();
  const map = {
    'audio/ogg':       'ogg',
    'audio/opus':      'ogg',
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
  return map[base] || null;
}

const db = new Database(DB_PATH);
const rows = db.prepare(`
  SELECT id, media_file, filename, mimetype FROM messages
  WHERE media_file LIKE '%.bin' AND mimetype IS NOT NULL
`).all();

console.log(`Found ${rows.length} .bin files with known mimetype`);

let renamed = 0, skipped = 0, missing = 0;

for (const row of rows) {
  const newExt = getExtension(row.mimetype);
  if (!newExt) { skipped++; continue; }

  const oldPath = path.join(MEDIA_DIR, row.media_file);
  if (!fs.existsSync(oldPath)) { missing++; continue; }

  const newName = row.media_file.replace(/\.bin$/, '.' + newExt);
  const newPath = path.join(MEDIA_DIR, newName);

  try {
    fs.renameSync(oldPath, newPath);
    db.prepare('UPDATE messages SET media_file = ?, filename = ? WHERE id = ?')
      .run(newName, newName, row.id);
    renamed++;
    console.log(`  ${row.media_file} → ${newName}`);
  } catch (e) {
    console.warn(`  Failed for ${row.media_file}: ${e.message}`);
    skipped++;
  }
}

console.log(`\n✅ Done. Renamed: ${renamed}, skipped: ${skipped}, missing on disk: ${missing}`);
db.close();
