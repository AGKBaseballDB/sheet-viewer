'use strict';
// Game video clips for batted balls (opened from the 打球方向 panels of the batter sheet).
// The DB keeps only the list (video_clips); the clips themselves are encrypted with the documents key
// (meta doc_key, the same key the PDFs use) and kept in the repository as clips/<id>.mp4.enc:
//   bytes = IV (12) || AES-256-GCM ciphertext || tag (16)   (no gzip: mp4 does not compress)
// They are added once with `bbdb.cjs add-clips` and stay in the repository across publishes.
// A clip can instead point into a YouTube video (yt = video id, t_start = second to start): nothing is stored then.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS video_clips (
    clip_id TEXT PRIMARY KEY, game_date TEXT, ts TEXT, batter TEXT, inning TEXT, result TEXT, opponent TEXT,
    source_video TEXT, t_start REAL, dur REAL, bytes INTEGER, sha256 TEXT, imported_at TEXT)`);
  const cols = db.prepare('PRAGMA table_info(video_clips)').all().map(c => c.name);
  if (!cols.includes('yt')) db.exec('ALTER TABLE video_clips ADD COLUMN yt TEXT');
  if (!cols.includes('yt_label')) db.exec('ALTER TABLE video_clips ADD COLUMN yt_label TEXT');
  if (!cols.includes('alts')) db.exec('ALTER TABLE video_clips ADD COLUMN alts TEXT');
}
function docKey(db) {
  const r = db.prepare("SELECT value FROM meta WHERE key='doc_key'").get();
  if (r && r.value) return Buffer.from(r.value, 'base64');
  const k = crypto.randomBytes(32);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('doc_key',?)").run(k.toString('base64'));
  return k;
}
// list: [{file | yt (+ l: label such as BC / CC / 中継, alts: [{yt, s, l}] other angles), ts, date, batter, inning, result, opponent, source, start, dur}]
function addClips(db, list, outDir) {
  ensureSchema(db);
  const key = docKey(db);
  fs.mkdirSync(outDir, { recursive: true });
  const up = db.prepare(`INSERT OR REPLACE INTO video_clips(clip_id,game_date,ts,batter,inning,result,opponent,source_video,t_start,dur,bytes,sha256,imported_at,yt,yt_label,alts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const old = db.prepare('SELECT clip_id FROM video_clips WHERE ts=? AND game_date=?');
  let n = 0;
  for (const c of list) {
    const id = crypto.createHash('sha256').update('clip|' + c.date + '|' + c.ts).digest('hex').slice(0, 20);
    if (c.yt) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(c.yt)) throw new Error('bad YouTube id: ' + c.yt);
      const prev = old.get(c.ts, c.date);
      if (prev) { try { fs.unlinkSync(path.join(outDir, prev.clip_id + '.mp4.enc')); } catch (e) {} db.prepare('DELETE FROM video_clips WHERE clip_id=?').run(prev.clip_id); }
      up.run(id, c.date, c.ts, c.batter || '', c.inning || '', c.result || '', c.opponent || '', c.source || '', Math.max(0, Math.round(+c.start || 0)), +c.dur || 0, 0, '', new Date().toISOString(), c.yt, c.l || '', c.alts && c.alts.length ? JSON.stringify(c.alts.filter(a => /^[A-Za-z0-9_-]{11}$/.test(a.yt)).map(a => ({ yt: a.yt, s: Math.max(0, Math.round(+a.s || 0)), l: a.l || '' }))) : null);
      n++; continue;
    }
    const buf = fs.readFileSync(c.file);
    if (buf.slice(4, 8).toString() !== 'ftyp') throw new Error('not an mp4: ' + c.file);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const prev = old.get(c.ts, c.date);
    if (prev && prev.clip_id !== id) { try { fs.unlinkSync(path.join(outDir, prev.clip_id + '.mp4.enc')); } catch (e) {} db.prepare('DELETE FROM video_clips WHERE clip_id=?').run(prev.clip_id); }
    const iv = crypto.randomBytes(12);
    const ci = crypto.createCipheriv('aes-256-gcm', key, iv);
    fs.writeFileSync(path.join(outDir, id + '.mp4.enc'), Buffer.concat([iv, ci.update(buf), ci.final(), ci.getAuthTag()]));
    up.run(id, c.date, c.ts, c.batter || '', c.inning || '', c.result || '', c.opponent || '', c.source || '', +c.start || 0, +c.dur || 0, buf.length, sha, new Date().toISOString(), null, null, null);
    n++;
  }
  return n;
}
function clipsSeed(db) {
  ensureSchema(db);
  return db.prepare('SELECT clip_id id, game_date d, ts, batter b, inning i, result r, opponent o, dur, yt, t_start s, yt_label l, alts FROM video_clips ORDER BY game_date, ts').all()
    .map(r => Object.assign({ id: r.id, d: r.d, ts: r.ts, b: r.b, i: r.i, r: r.r, o: r.o, dur: r.dur }, r.yt ? Object.assign({ yt: r.yt, s: r.s }, r.l ? { l: r.l } : {}, r.alts ? { alt: JSON.parse(r.alts) } : {}) : {}));
}
function clipCount(db) { ensureSchema(db); return db.prepare('SELECT count(*) n FROM video_clips').get().n; }
module.exports = { ensureSchema, addClips, clipsSeed, clipCount };
