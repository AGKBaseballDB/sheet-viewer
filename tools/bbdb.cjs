#!/usr/bin/env node
// SQLite database for the analysis sheet + folder import.
//   node --no-warnings tools/bbdb.cjs init   --db DB --from-html SHEET.html     create DB from the current sheet
//   node --no-warnings tools/bbdb.cjs plan   --db DB --listing LIST.json         which files need staging (JSON to stdout)
//   node --no-warnings tools/bbdb.cjs ingest --db DB --listing LIST.json --files DIR [--report OUT.txt]
//   node --no-warnings tools/bbdb.cjs export --db DB --out SHEET.html            build the sheet page from the DB
//   node --no-warnings tools/bbdb.cjs check  --db DB --from-html SHEET.html      compare DB contents with a sheet
//   node --no-warnings tools/bbdb.cjs set-template --db DB --from-html SHEET.html   replace the app code kept in the DB
// LIST.json: [{"path":"試合記録/xxx.xlsx","size":123,"mtime":"2026-10-21T12:00:00Z"}, ...]  (paths relative to the data folder)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { splitTemplate, loadCore } = require('./lib/appcore.cjs');

const SCHEMA_VERSION = '2';
const BODY_FIELDS = [['name', '選手名'], ['h', '身長'], ['w', '体重'], ['pbf', '体脂肪率'], ['bfm', '体脂肪量'], ['smm', '骨格筋量'], ['mm', '筋肉量'], ['ffm', '除脂肪量'], ['ffmi', '除脂肪量指数'], ['num', '背番号']];
const KIND_DIRS = { '試合記録': 'game', '体組成': 'body', 'トラックマン': 'tm' };
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const nowIso = () => new Date().toISOString();

function args() {
  const a = process.argv.slice(3), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return o;
}
function open(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;');
  return db;
}

function createSchema(db, COLS, TM_KEEP) {
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS app_template (id INTEGER PRIMARY KEY CHECK (id = 1), css TEXT NOT NULL, js TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS games (
  file_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, imported_at TEXT, priority INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL, sort_order INTEGER NOT NULL, source_path TEXT);
CREATE TABLE IF NOT EXISTS pitches (
  file_id TEXT NOT NULL REFERENCES games(file_id) ON DELETE CASCADE, row_no INTEGER NOT NULL,
  ${COLS.map(c => q(c) + ' TEXT').join(', ')},
  PRIMARY KEY (file_id, row_no));
CREATE TABLE IF NOT EXISTS players (player_key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS body_measurements (
  measure_date TEXT PRIMARY KEY, file_name TEXT, imported_at TEXT, targets TEXT, sort_order INTEGER NOT NULL, source_path TEXT,
  extra TEXT);
CREATE TABLE IF NOT EXISTS body_rows (
  measure_date TEXT NOT NULL REFERENCES body_measurements(measure_date) ON DELETE CASCADE, row_no INTEGER NOT NULL,
  ${BODY_FIELDS.map(([k, j]) => q(j) + (k === 'name' || k === 'num' ? ' TEXT' : ' REAL')).join(', ')},
  extra TEXT,
  PRIMARY KEY (measure_date, row_no));
-- per-player body-composition notes (targets / tasks / source), kept as JSON
CREATE TABLE IF NOT EXISTS body_notes (player_key TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trackman_sessions (
  session_id TEXT PRIMARY KEY, session_date TEXT, practice_type TEXT, file_name TEXT, imported_at TEXT,
  cols TEXT NOT NULL, row_count INTEGER NOT NULL, sort_order INTEGER NOT NULL, source_path TEXT);
CREATE TABLE IF NOT EXISTS trackman_pitches (
  session_id TEXT NOT NULL REFERENCES trackman_sessions(session_id) ON DELETE CASCADE, row_no INTEGER NOT NULL,
  ${TM_KEEP.map(c => q(c) + ' TEXT').join(', ')},
  PRIMARY KEY (session_id, row_no));
CREATE TABLE IF NOT EXISTS trackman_names (tm_name TEXT PRIMARY KEY, player_key TEXT);
CREATE TABLE IF NOT EXISTS trackman_fixes (kind TEXT NOT NULL, play_id TEXT NOT NULL, value TEXT, PRIMARY KEY (kind, play_id));
CREATE TABLE IF NOT EXISTS import_log (
  path TEXT PRIMARY KEY, kind TEXT, size INTEGER, mtime TEXT, sha256 TEXT, imported_at TEXT, result TEXT);
CREATE INDEX IF NOT EXISTS pitches_batter ON pitches(${q('打者名')});
CREATE INDEX IF NOT EXISTS pitches_pitcher ON pitches(${q('投手名')});
CREATE INDEX IF NOT EXISTS pitches_date ON pitches(${q('日付')});
CREATE VIEW IF NOT EXISTS v_games AS
  SELECT g.file_id, g.file_name, g.imported_at, MIN(p.${q('日付')}) AS 日付, MIN(p.${q('球場')}) AS 球場,
         g.row_count AS 球数, g.priority
  FROM games g LEFT JOIN pitches p ON p.file_id = g.file_id GROUP BY g.file_id;
`);
}

// ---------- seed <-> DB
function writeSeed(db, seed, core, opts) {
  const COLS = core.COLS, TM_KEEP = core.TM_KEEP;
  db.exec('BEGIN');
  try {
    for (const t of ['pitches', 'games', 'players', 'body_rows', 'body_measurements', 'body_notes', 'trackman_pitches', 'trackman_sessions', 'trackman_names', 'trackman_fixes', 'settings']) db.exec('DELETE FROM ' + t);
    const setS = db.prepare('INSERT INTO settings(key,value) VALUES (?,?)');
    for (const [k, v] of Object.entries(seed.settings || {})) setS.run(k, JSON.stringify(v));
    const insG = db.prepare('INSERT INTO games(file_id,file_name,imported_at,priority,row_count,sort_order,source_path) VALUES (?,?,?,?,?,?,?)');
    const insP = db.prepare(`INSERT INTO pitches(file_id,row_no,${COLS.map(q).join(',')}) VALUES (?,?,${COLS.map(() => '?').join(',')})`);
    const src = (opts && opts.sources) || {};
    (seed.__files || []).forEach((f, i) => {
      insG.run(f.id, f.name, f.at || null, f.pri || 0, f.rows.length, i, src[f.id] || null);
      const idx = COLS.map(c => f.cols.indexOf(c));
      f.rows.forEach((a, r) => insP.run(f.id, r, ...idx.map(j => (j < 0 ? '' : a[j] == null ? '' : String(a[j])))));
    });
    const insPl = db.prepare('INSERT INTO players(player_key,data) VALUES (?,?)');
    for (const [k, v] of Object.entries(seed.players || {})) insPl.run(k, JSON.stringify(v));
    const insBM = db.prepare('INSERT INTO body_measurements(measure_date,file_name,imported_at,targets,sort_order,source_path,extra) VALUES (?,?,?,?,?,?,?)');
    const insBR = db.prepare(`INSERT INTO body_rows(measure_date,row_no,${BODY_FIELDS.map(x => q(x[1])).join(',')},extra) VALUES (?,?,${BODY_FIELDS.map(() => '?').join(',')},?)`);
    const MONTH_KEYS = new Set(['date', 'file', 'at', 'rows', 'targets', 'source']);
    const ROW_KEYS = new Set(BODY_FIELDS.map(x => x[0]));
    const jsonOrNull = o => (Object.keys(o).length ? JSON.stringify(o) : null);
    ((seed.body && seed.body.months) || []).forEach((m, i) => {
      const mx = {}; for (const k of Object.keys(m)) if (!MONTH_KEYS.has(k)) mx[k] = m[k];
      if (!('file' in m)) mx.__absent = ['file']; if (!('at' in m)) (mx.__absent = mx.__absent || []).push('at');
      insBM.run(m.date, m.file == null ? null : m.file, m.at == null ? null : m.at, m.targets ? JSON.stringify(m.targets) : null, i, m.source || src['body:' + m.date] || null, jsonOrNull(mx));
      (m.rows || []).forEach((r, j) => {
        const rx = {}; for (const k of Object.keys(r)) if (!ROW_KEYS.has(k)) rx[k] = r[k];
        const absent = BODY_FIELDS.map(x => x[0]).filter(k => !(k in r)); if (absent.length) rx.__absent = absent;
        insBR.run(m.date, j, ...BODY_FIELDS.map(([k]) => (r[k] === undefined ? null : r[k])), jsonOrNull(rx));
      });
    });
    const body = seed.body || {};
    const insBN = db.prepare('INSERT INTO body_notes(player_key,data) VALUES (?,?)');
    for (const [k, v] of Object.entries(body.notes || {})) insBN.run(k, JSON.stringify(v));
    const bx = {}; for (const k of Object.keys(body)) if (k !== 'months' && k !== 'notes') bx[k] = body[k];
    if ('notes' in body) bx.__has_notes = true;
    const tm = seed.__tm || { sessions: [], names: {}, bfix: {}, hfix: {} };
    const insTS = db.prepare('INSERT INTO trackman_sessions(session_id,session_date,practice_type,file_name,imported_at,cols,row_count,sort_order,source_path) VALUES (?,?,?,?,?,?,?,?,?)');
    const insTP = db.prepare(`INSERT INTO trackman_pitches(session_id,row_no,${TM_KEEP.map(q).join(',')}) VALUES (?,?,${TM_KEEP.map(() => '?').join(',')})`);
    tm.sessions.forEach((s, i) => {
      insTS.run(s.id, s.date || '', s.type || '', s.file || '', s.at || '', JSON.stringify(s.cols || []), s.rows.length, i, src[s.id] || null);
      const idx = TM_KEEP.map(c => (s.cols || []).indexOf(c));
      s.rows.forEach((a, r) => insTP.run(s.id, r, ...idx.map(j => (j < 0 ? null : a[j] == null ? '' : String(a[j])))));
    });
    const insTN = db.prepare('INSERT INTO trackman_names(tm_name,player_key) VALUES (?,?)');
    for (const [k, v] of Object.entries(tm.names || {})) insTN.run(k, v);
    const insTF = db.prepare('INSERT INTO trackman_fixes(kind,play_id,value) VALUES (?,?,?)');
    for (const [k, v] of Object.entries(tm.bfix || {})) insTF.run('batter', k, v);
    for (const [k, v] of Object.entries(tm.hfix || {})) insTF.run('hit', k, v);
    const setM = db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)');
    setM.run('schema_version', SCHEMA_VERSION);
    setM.run('rev', seed.rev || nowIso());
    setM.run('tm_sample', tm.sample ? JSON.stringify(tm.sample) : '');
    setM.run('body_extra', JSON.stringify(bx));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Read DB into the app's in-memory shape (rows as arrays), like core.decode() output.
function readMem(db, core) {
  const COLS = core.COLS, TM_KEEP = core.TM_KEEP;
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map(r => [r.key, r.value]));
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, JSON.parse(r.value)]));
  const games = db.prepare('SELECT * FROM games ORDER BY sort_order').all();
  const pq = db.prepare(`SELECT ${COLS.map(q).join(',')} FROM pitches WHERE file_id=? ORDER BY row_no`);
  const files = games.map(g => ({ id: g.file_id, name: g.file_name, at: g.imported_at, pri: g.priority || 0, cols: COLS.slice(), rows: pq.all(g.file_id).map(r => COLS.map(c => r[c] == null ? '' : r[c])), source: g.source_path }));
  const players = Object.fromEntries(db.prepare('SELECT player_key,data FROM players').all().map(r => [r.player_key, JSON.parse(r.data)]));
  const bq = db.prepare(`SELECT ${BODY_FIELDS.map(x => q(x[1])).join(',')},extra FROM body_rows WHERE measure_date=? ORDER BY row_no`);
  const months = db.prepare('SELECT * FROM body_measurements ORDER BY sort_order').all().map(m => {
    const mx = m.extra ? JSON.parse(m.extra) : {}, mabs = new Set(mx.__absent || []); delete mx.__absent;
    const rec = { date: m.measure_date };
    if (!mabs.has('file')) rec.file = m.file_name;
    if (!mabs.has('at')) rec.at = m.imported_at;
    rec.source = m.source_path;
    rec.rows = bq.all(m.measure_date).map(r => {
      const rx = r.extra ? JSON.parse(r.extra) : {}, abs = new Set(rx.__absent || []); delete rx.__absent;
      const o = {};
      for (const [k, j] of BODY_FIELDS) { if (abs.has(k)) continue; if (!r.extra && k === 'num' && r[j] == null) continue; o[k] = r[j]; }
      return Object.assign(o, rx);
    });
    if (m.targets) rec.targets = JSON.parse(m.targets);
    return Object.assign(rec, mx);
  });
  const bx = meta.body_extra ? JSON.parse(meta.body_extra) : {};
  const hasNotes = !!bx.__has_notes; delete bx.__has_notes;
  const noteRows = db.prepare('SELECT player_key,data FROM body_notes').all();
  const body = Object.assign({ months }, bx);
  if (hasNotes || noteRows.length) body.notes = Object.fromEntries(noteRows.map(r => [r.player_key, JSON.parse(r.data)]));
  const tq = db.prepare(`SELECT ${TM_KEEP.map(q).join(',')} FROM trackman_pitches WHERE session_id=? ORDER BY row_no`);
  const sessions = db.prepare('SELECT * FROM trackman_sessions ORDER BY sort_order').all().map(s => {
    const cols = JSON.parse(s.cols);
    return { id: s.session_id, date: s.session_date, type: s.practice_type, file: s.file_name, at: s.imported_at, cols, rows: tq.all(s.session_id).map(r => cols.map(c => r[c] == null ? '' : r[c])), source: s.source_path };
  });
  const names = Object.fromEntries(db.prepare('SELECT tm_name,player_key FROM trackman_names').all().map(r => [r.tm_name, r.player_key]));
  const fx = db.prepare('SELECT kind,play_id,value FROM trackman_fixes').all();
  const bfix = Object.fromEntries(fx.filter(r => r.kind === 'batter').map(r => [r.play_id, r.value]));
  const hfix = Object.fromEntries(fx.filter(r => r.kind === 'hit').map(r => [r.play_id, r.value]));
  const tm = { names, bfix, hfix, sessions }; if (meta.tm_sample) tm.sample = JSON.parse(meta.tm_sample);
  return { rev: meta.rev || '', settings, players, body, tm, files };
}

function memToSeedInput(mem) {
  // writeSeed() takes the decoded shape for files/tm (rows as arrays) under __files/__tm.
  return { rev: mem.rev, settings: mem.settings, players: mem.players, body: mem.body, __files: mem.files, __tm: mem.tm };
}
function sourcesOf(mem) {
  const s = {};
  mem.files.forEach(f => { if (f.source) s[f.id] = f.source; });
  mem.tm.sessions.forEach(x => { if (x.source) s[x.id] = x.source; });
  mem.body.months.forEach(m => { if (m.source) s['body:' + m.date] = m.source; });
  return s;
}

async function buildHtml(db, core, rev) {
  const t = db.prepare('SELECT css,js FROM app_template WHERE id=1').get();
  if (!t) throw new Error('app template missing in DB');
  const mem = readMem(db, core);
  mem.rev = rev || mem.rev;
  const body = Object.assign({}, mem.body, { months: mem.body.months.map(({ source, ...m }) => m) });
  const dbObj = { rev: mem.rev, settings: mem.settings, players: mem.players, body, tm: mem.tm, files: mem.files };
  const seed = JSON.stringify(await core.encode(dbObj)).replace(/</g, '\\u003c');
  return core.SKEL + core.HEAD + '<style id="app-css">' + t.css + '</style>\n<div id="app"></div>\n<script type="application/json" id="seed">' + seed + '<\/script>\n<script id="app-js">' + t.js + '<\/script>\n</body></html>';
}

function coreFromDb(db) {
  const t = db.prepare('SELECT js FROM app_template WHERE id=1').get();
  if (!t) throw new Error('app template missing in DB');
  return loadCore(t.js);
}

// ---------- file reading (same rules as the app)
// Excel cell -> the text Excel's own "save as CSV" would write, except that dates/times are
// written the way the app's CSVs have them (2026/3/4, 2026/03/04 10:30:41).
function cellText(X, cell) {
  if (!cell) return '';
  const p2 = n => String(n).padStart(2, '0');
  const fromParts = (y, mo, d, h, mi, s) => {
    if (y < 1901) return `${p2(h)}:${p2(mi)}:${p2(s)}`;
    return (h || mi || s) ? `${y}/${p2(mo)}/${p2(d)} ${p2(h)}:${p2(mi)}:${p2(s)}` : `${y}/${mo}/${d}`;
  };
  if (cell.t === 'd' && cell.v instanceof Date) {
    const v = new Date(Math.round(cell.v.getTime() / 1000) * 1000); // SheetJS builds the wall-clock time in local time
    return fromParts(v.getFullYear(), v.getMonth() + 1, v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
  }
  if (cell.t === 'n' && cell.z && X.SSF.is_date(cell.z)) {
    const p = X.SSF.parse_date_code(cell.v);
    if (p) return fromParts(p.y, p.m, p.d, p.H, p.M, Math.round(p.S));
  }
  if (cell.w != null) return String(cell.w);
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  return cell.v == null ? '' : String(cell.v);
}
function sheetRows(X, buf) {
  const wb = X.read(buf, { type: 'buffer', cellDates: true, cellNF: true, cellText: true });
  return wb.SheetNames.map(n => {
    const ws = wb.Sheets[n];
    if (!ws || !ws['!ref']) return { sheet: n, rows: [] };
    const R = X.utils.decode_range(ws['!ref']), rows = [];
    for (let r = R.s.r; r <= R.e.r; r++) {
      const row = [];
      for (let c = R.s.c; c <= R.e.c; c++) row.push(cellText(X, ws[X.utils.encode_cell({ r, c })]));
      if (row.some(v => v !== '') || rows.length) rows.push(row);
    }
    return { sheet: n, rows };
  });
}

function readGameTables(core, rel, buf) {
  const base = path.basename(rel);
  if (/\.zip$/i.test(base)) return { zip: true };
  if (/\.csv$/i.test(base)) return { tables: [{ name: base, data: core.Papa.parse(core.decodeBytes(new Uint8Array(buf)), { skipEmptyLines: 'greedy' }).data || [] }] };
  if (/\.xlsx?$/i.test(base)) {
    const sheets = sheetRows(core.XLSX, buf).filter(s => s.rows.length > 1);
    const stem = base.replace(/\.xlsx?$/i, '');
    const ok = sheets.filter(s => core.REQUIRED.every(c => (s.rows[0] || []).map(h => String(h).trim()).includes(c)));
    const use = ok.length ? ok : sheets.slice(0, 1);
    return { tables: use.map(s => ({ name: use.length > 1 ? `${stem}_${s.sheet}.csv` : `${stem}.csv`, data: s.rows })) };
  }
  return { err: 'Excel（.xlsx）・CSV・ZIPのファイルではありません' };
}

async function ingestGames(core, mem, items, notes) {
  const hashes = new Map(mem.files.map(f => [core.hashRows(f.rows), f.name]));
  let added = 0, replaced = 0;
  for (const it of items) {
    let tables;
    try {
      const r = readGameTables(core, it.rel, it.buf);
      if (r.err) { notes.push(`✕ ${it.rel}：${r.err}`); it.result = 'error'; continue; }
      if (r.zip) {
        const zip = await core.JSZip.loadAsync(it.buf, { decodeFileName: b => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (e) { return new TextDecoder('shift_jis').decode(u); } } });
        tables = [];
        for (const ent of Object.values(zip.files)) {
          if (ent.dir || ent.name.includes('__MACOSX')) continue;
          const b = ent.name.split('/').pop(); if (!b || b.startsWith('._') || !/\.csv$/i.test(b)) continue;
          tables.push({ name: b, data: core.Papa.parse(core.decodeBytes(await ent.async('uint8array')), { skipEmptyLines: 'greedy' }).data || [] });
        }
        if (!tables.length) { notes.push(`✕ ${it.rel}：ZIPの中にCSVがありません`); it.result = 'error'; continue; }
      } else tables = r.tables;
    } catch (e) { notes.push(`✕ ${it.rel}：読み込めませんでした（${e.message}）`); it.result = 'error'; continue; }
    const res = [];
    for (const { name, data } of tables) {
      if (data.length < 2) { res.push(`${name}：データ行がありません`); continue; }
      const hdr = data[0].map(h => String(h).replace(/^﻿/, '').trim());
      const miss = core.REQUIRED.filter(c => !hdr.includes(c));
      if (miss.length) { res.push(`${name}：「${miss.slice(0, 3).join('」「')}」${miss.length > 3 ? 'など' : ''}の列がありません`); continue; }
      const idx = core.COLS.map(c => hdr.indexOf(c));
      const rows = data.slice(1).map(a => idx.map(i => (i < 0 ? '' : String(a[i] == null ? '' : a[i]).replace(/[\t\r\n]+/g, ' ').trim()))).filter(a => a.some(v => v !== ''));
      if (!rows.length) { res.push(`${name}：データ行がありません`); continue; }
      const h = core.hashRows(rows);
      if (hashes.has(h)) { res.push(`${name}：登録済み（${hashes.get(h)}）と同じ内容のためそのまま`); continue; }
      const nf = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name, at: nowIso(), pri: 0, cols: core.COLS.slice(), rows, source: it.rel };
      const bases = core.fileBases(nf);
      const old = mem.files.find(f => f.name === name && [...core.fileBases(f)].some(b => bases.has(b)));
      if (old) { mem.files = mem.files.filter(f => f !== old); nf.pri = old.pri || 0; replaced++; res.push(`${name}：差し替え（${rows.length}球）`); }
      else {
        if (mem.files.some(f => f.name === name)) { let i = 2; const b = name.replace(/\.csv$/i, ''); while (mem.files.some(f => f.name === `${b} (${i}).csv`)) i++; nf.name = `${b} (${i}).csv`; }
        added++; res.push(`${nf.name}：追加（${rows.length}球）`);
      }
      mem.files.push(nf); hashes.set(h, nf.name);
    }
    it.result = 'ok';
    notes.push(`・${it.rel}\n    ` + res.join('\n    '));
  }
  return { added, replaced };
}

function todayJst() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }

async function ingestBody(core, mem, items, notes) {
  let n = 0;
  for (const it of items) {
    const base = path.basename(it.rel);
    let res = null;
    try {
      if (/\.csv$/i.test(base)) { res = core.parseBodyTable(core.Papa.parse(core.decodeBytes(new Uint8Array(it.buf)), { skipEmptyLines: 'greedy' }).data || []); }
      else if (/\.xlsx?$/i.test(base)) {
        const wb = core.XLSX.read(it.buf, { type: 'buffer' });
        for (const s of wb.SheetNames) { const r = core.parseBodyTable(core.XLSX.utils.sheet_to_json(wb.Sheets[s], { header: 1, raw: true, defval: '' })); r.sheets = [s]; if (!r.err) { res = r; break; } res = r; }
      } else { notes.push(`✕ ${it.rel}：ExcelかCSVのファイルではありません`); it.result = 'error'; continue; }
    } catch (e) { notes.push(`✕ ${it.rel}：読み込めませんでした（${e.message}）`); it.result = 'error'; continue; }
    if (!res || res.err) { notes.push(`✕ ${it.rel}：${(res && res.err) || '読み込めませんでした'}`); it.result = 'error'; continue; }
    const guess = core.bodyDateGuess(base, ...(res.sheets || []));
    const date = guess || todayJst();
    const same = mem.body.months.some(m => m.date === date);
    mem.body.months = mem.body.months.filter(m => m.date !== date);
    const rec = { date, file: base, at: nowIso(), rows: res.rows, source: it.rel };
    if (Object.keys(res.targets || {}).length) rec.targets = res.targets;
    mem.body.months.push(rec);
    mem.body.months.sort((a, b) => a.date.localeCompare(b.date));
    n++;
    notes.push(`・${it.rel}\n    測定日 ${date}${guess ? '' : '（ファイル名に日付がないため取り込んだ日にしました。ファイル名に「2026-10-10」のように日付を入れると、その日になります）'}：${res.rows.length}人を${same ? '差し替え' : '追加'}`
      + (res.miss && res.miss.length ? `\n    見つからなかった列：${res.miss.map(k => (core.BODY_MM[k] && core.BODY_MM[k].label) || k).join('、')}` : ''));
    it.result = 'ok';
  }
  return { n };
}

async function ingestTm(core, mem, items, notes) {
  const ids = new Set();
  mem.tm.sessions.forEach(s => { const i = s.cols.indexOf('PlayID'); if (i >= 0) s.rows.forEach(a => { if (a[i]) ids.add(a[i]); }); });
  let added = 0;
  for (const it of items) {
    const base = path.basename(it.rel);
    if (!/\.csv$/i.test(base)) { notes.push(`✕ ${it.rel}：CSVのファイルではありません`); it.result = 'error'; continue; }
    let res;
    try { res = core.parseTrackman(core.Papa.parse(core.decodeBytes(new Uint8Array(it.buf)), { skipEmptyLines: 'greedy' }).data || [], base); }
    catch (e) { notes.push(`✕ ${it.rel}：読み込めませんでした（${e.message}）`); it.result = 'error'; continue; }
    if (res.err) { notes.push(`✕ ${it.rel}：${res.err}`); it.result = 'error'; continue; }
    let a = 0, dup = 0; const lines = [];
    for (const s of res.sessions) {
      const pi = s.cols.indexOf('PlayID');
      const rows = s.rows.filter(r => { const id = pi < 0 ? '' : r[pi]; if (id && ids.has(id)) { dup++; return false; } if (id) ids.add(id); return true; });
      if (!rows.length) continue;
      if (!s.date) { lines.push('日付の列が読めない行がありました'); continue; }
      mem.tm.sessions.push({ id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: s.date, type: s.type, file: base, at: nowIso(), cols: s.cols, rows, source: it.rel });
      a += rows.length; lines.push(`${s.date}：${rows.length}球を追加`);
    }
    if (dup) lines.push(`登録済みの球 ${dup}球はスキップ`);
    added += a;
    notes.push(`・${it.rel}\n    ` + (lines.join('\n    ') || '追加できる球がありませんでした'));
    it.result = 'ok';
  }
  return { added };
}

function kindOf(rel) {
  const top = rel.split('/')[0];
  return KIND_DIRS[top] || null;
}
function isCandidate(rel) {
  const b = path.basename(rel);
  if (b.startsWith('~$') || b.startsWith('.') || b.startsWith('._')) return false; // Excel lock / hidden files
  if (!kindOf(rel)) return false;
  return /\.(xlsx|xls|csv|zip)$/i.test(b);
}

// ---------- commands
async function cmdInit(o) {
  const html = fs.readFileSync(o['from-html'], 'utf8');
  const t = splitTemplate(html);
  const core = loadCore(t.js);
  if (fs.existsSync(o.db)) throw new Error('DB already exists: ' + o.db);
  const db = open(o.db);
  createSchema(db, core.COLS, core.TM_KEEP);
  db.prepare('INSERT INTO app_template(id,css,js,updated_at) VALUES (1,?,?,?)').run(t.css, t.js, nowIso());
  const mem = await core.decode(JSON.parse(t.seed));
  writeSeed(db, memToSeedInput(mem), core);
  db.close();
  console.log(JSON.stringify({ ok: true, files: mem.files.length, pitches: mem.files.reduce((s, f) => s + f.rows.length, 0), body: mem.body.months.length, tm: mem.tm.sessions.length }));
}

function normPath(p) { return String(p).replace(/\\/g, '/').replace(/^\.\//, ''); }

function cmdPlan(o) {
  const db = open(o.db);
  const list = JSON.parse(fs.readFileSync(o.listing, 'utf8')).map(x => ({ ...x, path: normPath(x.path) }));
  const log = new Map(db.prepare('SELECT * FROM import_log').all().map(r => [r.path, r]));
  const need = list.filter(x => isCandidate(x.path)).filter(x => { const l = log.get(x.path); return !l || l.size !== x.size || String(l.mtime) !== String(x.mtime); });
  db.close();
  console.log(JSON.stringify({ stage: need.map(x => x.path), skipped: list.filter(x => !isCandidate(x.path)).map(x => x.path) }));
}

async function cmdIngest(o) {
  const db = open(o.db);
  const core = coreFromDb(db);
  const list = JSON.parse(fs.readFileSync(o.listing, 'utf8')).map(x => ({ ...x, path: normPath(x.path) }));
  const log = new Map(db.prepare('SELECT * FROM import_log').all().map(r => [r.path, r]));
  const items = [];
  for (const x of list) {
    if (!isCandidate(x.path)) continue;
    const l = log.get(x.path);
    if (l && l.size === x.size && String(l.mtime) === String(x.mtime)) continue;
    const local = path.join(o.files, x.path);
    if (!fs.existsSync(local)) { items.push({ rel: x.path, meta: x, missing: true }); continue; }
    const buf = fs.readFileSync(local);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    items.push({ rel: x.path, meta: x, buf, sha, unchanged: !!(l && l.sha256 === sha) });
  }
  const mem = readMem(db, core);
  const notes = [];
  const todo = items.filter(i => !i.missing && !i.unchanged);
  const g = await ingestGames(core, mem, todo.filter(i => kindOf(i.rel) === 'game').sort((a, b) => a.rel.localeCompare(b.rel)), notes);
  const b = await ingestBody(core, mem, todo.filter(i => kindOf(i.rel) === 'body').sort((a, b) => a.rel.localeCompare(b.rel)), notes);
  const t = await ingestTm(core, mem, todo.filter(i => kindOf(i.rel) === 'tm').sort((a, b) => a.rel.localeCompare(b.rel)), notes);
  const changed = g.added + g.replaced + b.n + t.added > 0;
  if (changed) mem.rev = nowIso();
  if (changed) writeSeed(db, memToSeedInput(mem), core, { sources: sourcesOf(mem) });
  db.exec('BEGIN');
  try {
    const up = db.prepare('INSERT OR REPLACE INTO import_log(path,kind,size,mtime,sha256,imported_at,result) VALUES (?,?,?,?,?,?,?)');
    for (const i of items) {
      if (i.missing) continue;
      up.run(i.rel, kindOf(i.rel), i.meta.size, String(i.meta.mtime), i.sha, nowIso(), i.unchanged ? 'unchanged' : (i.result || 'ok'));
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  const rev = db.prepare("SELECT value FROM meta WHERE key='rev'").get().value;
  const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
  const head = changed ? `${stamp} 取り込みました（試合 追加${g.added}・差し替え${g.replaced}／体組成 ${b.n}件／トラックマン ${t.added}球）` : `${stamp} 新しく取り込むデータはありませんでした`;
  const missing = items.filter(i => i.missing).map(i => `✕ ${i.rel}：ファイルを受け取れませんでした（次回もう一度試します）`);
  const report = [head, '', ...notes, ...missing].join('\n').trim() + '\n';
  if (o.report) fs.writeFileSync(o.report, report);
  db.close();
  console.log(JSON.stringify({ changed, rev, games_added: g.added, games_replaced: g.replaced, body: b.n, tm_pitches: t.added, errors: notes.filter(n => n.startsWith('✕')).length + missing.length }));
}

async function cmdExport(o) {
  const db = open(o.db);
  const core = coreFromDb(db);
  const rev = db.prepare("SELECT value FROM meta WHERE key='rev'").get().value;
  fs.writeFileSync(o.out, await buildHtml(db, core, rev));
  db.close();
  console.log(JSON.stringify({ ok: true, rev, out: o.out }));
}

// Exact check: the page built from the DB must decode to the same data (and code) as the given sheet.
async function cmdCheck(o) {
  const db = open(o.db);
  const core = coreFromDb(db);
  const ref = splitTemplate(fs.readFileSync(o['from-html'], 'utf8'));
  const rev = db.prepare("SELECT value FROM meta WHERE key='rev'").get().value;
  const got = splitTemplate(await buildHtml(db, core, rev));
  db.close();
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x));
  const strip = d => { d.files.forEach(f => delete f.z); d.tm.sessions.forEach(s => delete s.z); return d; };
  const a = strip(await core.decode(JSON.parse(ref.seed))), b = strip(await core.decode(JSON.parse(got.seed)));
  const diffs = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (canon(a[k]) !== canon(b[k])) diffs.push(k);
  if (ref.js !== got.js) diffs.push('app-js'); if (ref.css !== got.css) diffs.push('app-css');
  console.log(JSON.stringify({ same: diffs.length === 0, diffs }));
  if (diffs.length) process.exit(1);
}

function cmdSetTemplate(o) {
  const t = splitTemplate(fs.readFileSync(o['from-html'], 'utf8'));
  loadCore(t.js); // must still load
  const db = open(o.db);
  db.prepare('INSERT OR REPLACE INTO app_template(id,css,js,updated_at) VALUES (1,?,?,?)').run(t.css, t.js, nowIso());
  db.close();
  console.log(JSON.stringify({ ok: true }));
}

const cmd = process.argv[2];
const o = args();
const fn = { init: cmdInit, plan: cmdPlan, ingest: cmdIngest, export: cmdExport, check: cmdCheck, 'set-template': cmdSetTemplate }[cmd];
if (!fn) { console.error('unknown command'); process.exit(2); }
Promise.resolve().then(() => fn(o)).catch(e => { console.error('FAILED:', e.stack || e.message || e); process.exit(1); });
