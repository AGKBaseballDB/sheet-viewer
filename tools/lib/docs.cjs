'use strict';
// PDF reports in 体組成/ (e.g. Akiyama_Kanta_20260317.pdf: 名前のローマ字_測定日) -> table body_docs.
// The page lists them per player; each PDF is published as an encrypted file docs/<id>.enc (same key as the page)
// and opened in the page on demand, so the page itself stays small.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const q = s => '"' + String(s).replace(/"/g, '""') + '"';

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS body_docs (doc_id TEXT PRIMARY KEY, player_name TEXT, doc_date TEXT, title TEXT, file_name TEXT, source_path TEXT, bytes INTEGER, sha256 TEXT, pdf BLOB, imported_at TEXT);
CREATE TABLE IF NOT EXISTS roman_names (rkey TEXT PRIMARY KEY, player_name TEXT NOT NULL);`);
  const have = new Set(db.prepare('PRAGMA table_info(body_docs)').all().map(r => r.name));
  if (!have.has('pages')) db.exec('ALTER TABLE body_docs ADD COLUMN pages INTEGER');
}
const { execFileSync } = require('child_process');
const os = require('os');
function withPdf(buf, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdoc-'));
  try { fs.writeFileSync(path.join(dir, 'in.pdf'), buf); return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function pdfTitle(buf) {
  try { const t = withPdf(buf, d => execFileSync('pdftotext', ['-f', '1', '-l', '1', '-enc', 'UTF-8', path.join(d, 'in.pdf'), '-']).toString());
    const l = t.split(/\r?\n/).map(x => x.normalize('NFKC').trim()).find(x => x && !/^[\d\s.\-\/]+$/.test(x)); return l ? l.slice(0, 40) : ''; } catch (e) { return ''; }
}
function pageCount(buf) {
  try { return withPdf(buf, d => +(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [path.join(d, 'in.pdf')]).toString()) || [])[1] || null); } catch (e) { return null; }
}
// PDF -> page images (WebP, 144 dpi) so the page can show them without a PDF viewer
function renderPages(buf) {
  return withPdf(buf, d => {
    execFileSync('pdftoppm', ['-r', '144', '-png', path.join(d, 'in.pdf'), path.join(d, 'p')]);
    const py = `import sys,glob,io,base64,json\nfrom PIL import Image\nout=[]\nfor f in sorted(glob.glob(sys.argv[1]+'/p-*.png'),key=lambda x:int(x.rsplit('-',1)[1].split('.')[0])):\n  im=Image.open(f).convert('RGB');b=io.BytesIO();im.save(b,'WEBP',quality=80,method=6);out.append({'w':im.width,'h':im.height,'b':base64.b64encode(b.getvalue()).decode()})\nprint(json.dumps(out))`;
    return JSON.parse(execFileSync('python3', ['-I', '-c', py, d], { maxBuffer: 1 << 28 }).toString());
  });
}
// letters only, long vowels folded (same as measure_xlsx.py roman_norm)
function romanNorm(s) {
  let x = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  // kunrei / nihon-shiki spellings -> Hepburn (Syunta -> Shunta, Tuboi -> Tsuboi, Hukuda -> Fukuda); Hepburn itself never has these pairs
  x = x.replace(/sy/g, 'sh').replace(/si/g, 'shi').replace(/ty/g, 'ch').replace(/ti/g, 'chi').replace(/tu/g, 'tsu').replace(/(?<![sc])hu/g, 'fu').replace(/zy|jy/g, 'j').replace(/zi/g, 'ji');
  x = x.replace(/(o)h(?![aeiou])/g, '$1');
  for (const [a, b] of [['ou', 'o'], ['oo', 'o'], ['uu', 'u'], ['ei', 'e'], ['ii', 'i']]) x = x.split(a).join(b);
  return x;
}
function setRoman(db, map) {
  ensureSchema(db);
  const ins = db.prepare('INSERT OR REPLACE INTO roman_names(rkey, player_name) VALUES (?,?)');
  db.exec('BEGIN'); try { for (const [k, v] of Object.entries(map || {})) ins.run(k, v); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function parseName(base) {
  const stem = base.replace(/\.pdf$/i, '');
  const m = /^(.*?)[_\-\s]*((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:\D.*)?$/.exec(stem);
  if (!m) return null;
  return { who: m[1], date: `${m[2]}-${m[3]}-${m[4]}` };
}
function ingestDocs(db, items, notes) {
  ensureSchema(db);
  if (!items.length) return { added: 0 };
  const roman = new Map(db.prepare('SELECT rkey, player_name FROM roman_names').all().map(r => [r.rkey, r.player_name]));
  for (const r of db.prepare("SELECT tm_name, player_key FROM trackman_names WHERE player_key NOT LIKE '\\_\\_%' ESCAPE '\\'").all()) {
    const nm = r.player_key.split('|').pop(), parts = r.tm_name.split(',').map(x => x.trim());
    if (!roman.has(romanNorm(parts.join('')))) roman.set(romanNorm(parts.join('')), nm);
    if (!roman.has(romanNorm(parts.slice().reverse().join('')))) roman.set(romanNorm(parts.slice().reverse().join('')), nm);
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO body_docs(doc_id,player_name,doc_date,title,file_name,source_path,bytes,sha256,pdf,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const sameFile = db.prepare('SELECT doc_id FROM body_docs WHERE file_name=?');
  let added = 0;
  for (const it of items) {
    const base = path.basename(it.rel);
    if (!/^%PDF/.test(it.buf.slice(0, 5).toString('latin1'))) { notes.push(`✕ ${it.rel}：PDFとして読めませんでした`); it.result = 'error'; continue; }
    const p = parseName(base);
    if (!p) { notes.push(`✕ ${it.rel}：ファイル名から測定日がわかりません（「名前_20260317.pdf」の形にしてください）`); it.result = 'error'; continue; }
    const who = /[^\x00-\x7f]/.test(p.who) ? p.who.replace(/[\s　_]+/g, '') : roman.get(romanNorm(p.who));
    if (!who) { notes.push(`✕ ${it.rel}：「${p.who}」がどの選手かわかりません（ファイル名を「Akiyama_Kanta_20260317.pdf」か「秋山貫太_20260317.pdf」の形にしてください）`); it.result = 'error'; continue; }
    const sha = crypto.createHash('sha256').update(it.buf).digest('hex');
    const old = sameFile.get(base);
    if (old) db.prepare('DELETE FROM body_docs WHERE doc_id=?').run(old.doc_id);
    const id = sha.slice(0, 20);
    const pages = pageCount(it.buf);
    ins.run(id, who, p.date, pdfTitle(it.buf) || 'レポート', base, it.rel, it.buf.length, sha, it.buf, new Date().toISOString());
    db.prepare('UPDATE body_docs SET pages=? WHERE doc_id=?').run(pages, id);
    added++;
    notes.push(`・${it.rel}\n    ${who}・${p.date} のレポート（PDF ${pages}ページ）を${old ? '差し替え' : '追加'}`);
    it.result = 'ok';
  }
  return { added };
}
function docsSeed(db) {
  ensureSchema(db);
  return db.prepare('SELECT doc_id, player_name, doc_date, title, file_name, bytes, pages FROM body_docs ORDER BY doc_date DESC, player_name').all()
    .map(r => ({ id: r.doc_id, name: r.player_name, d: r.doc_date, t: r.title, f: r.file_name, kb: Math.round(r.bytes / 1024), pg: r.pages || null }));
}
// The documents key: random, kept in the DB (meta doc_key; the DB backup itself is encrypted with the staff key).
// Both pages (staff / players) carry it inside their encrypted data (seed.dk), so one set of files serves both.
function docKey(db) {
  const r = db.prepare("SELECT value FROM meta WHERE key='doc_key'").get();
  if (r && r.value) return Buffer.from(r.value, 'base64');
  const k = crypto.randomBytes(32);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('doc_key',?)").run(k.toString('base64'));
  return k;
}
const docKeyId = k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 12);
// write docs/<id>.enc (page images) and docs/<id>.pdf.enc (the PDF itself) for every report:
// gzip -> AES-256-GCM with the documents key. Files already written with the same key are kept, others rewritten; stale ones removed.
function exportDocs(db, secret, outDir) {
  ensureSchema(db);
  const zlib = require('zlib');
  const key = docKey(db), kid = docKeyId(key);
  fs.mkdirSync(outDir, { recursive: true });
  const want = new Set();
  let wrote = 0;
  const seal = (f, bytes) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(zlib.gzipSync(bytes, { level: 9 })), c.final(), c.getAuthTag()]);
    fs.writeFileSync(f, JSON.stringify({ v: 2, dk: kid, iv: iv.toString('base64'), data: ct.toString('base64') }));
    wrote++;
  };
  for (const r of db.prepare('SELECT doc_id, pdf FROM body_docs').all()) {
    const fi = path.join(outDir, r.doc_id + '.enc'), fp = path.join(outDir, r.doc_id + '.pdf.enc');
    want.add(r.doc_id + '.enc'); want.add(r.doc_id + '.pdf.enc');
    const ok = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).dk === kid; } catch (e) { return false; } };
    if (!ok(fi)) seal(fi, Buffer.from(JSON.stringify({ pages: renderPages(Buffer.from(r.pdf)) })));
    if (!ok(fp)) seal(fp, Buffer.from(r.pdf));
  }
  let removed = 0;
  for (const f of fs.readdirSync(outDir)) if (/\.enc$/.test(f) && !want.has(f)) { fs.unlinkSync(path.join(outDir, f)); removed++; }
  return { files: want.size, wrote, removed };
}
function docKeyB64(db) { ensureSchema(db); return db.prepare('SELECT count(*) n FROM body_docs').get().n ? docKey(db).toString('base64') : null; }
module.exports = { ensureSchema, romanNorm, setRoman, ingestDocs, docsSeed, exportDocs, parseName, docKeyB64 };
