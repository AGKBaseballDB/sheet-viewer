// Blast Motion (Blast Connect "All swings by player" CSV) -> SQLite.
// Same conversions as the 「Blast CSV → DB貼り付け変換」 tool: mph -> km/h, UTC -> JST,
// On Plane Efficiency as %, environment tag names, and the same rounding.
// The team uses one shared Blast account, so the batter comes from the TrackMan pitch
// recorded within a few seconds of the swing (same day), mapped through trackman_names.
'use strict';
const path = require('path');

const MPH = 1.609344;
const MATCH_SEC = 10;
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const COND = { 'tee': 'Tee', 'front toss overhand': 'Front Toss Overhand', 'front toss underhand': 'Front Toss Underhand', 'soft toss': 'Soft Toss', 'live pitch': 'Live Pitch', 'general practice': 'General Practice', 'in game': 'In Game' };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r0 = v => Math.round(v);

// DB column, Blast Connect header (lower-cased, without unit), unit handling, rounding
const METRICS = [
  ['バットスピード_kmh', 'bat speed', 'speed', r1],
  ['手の最大スピード_kmh', 'peak hand speed', 'speed', r1],
  ['回転加速度_G', 'rotational acceleration', null, r1],
  ['オンプレーン効率_pct', 'on plane efficiency', 'pct', r0],
  ['アッパースイング度', 'attack angle', null, r0],
  ['体とバットの角度_構え', 'early connection', null, r0],
  ['体とバットの角度_インパクト', 'connection at impact', null, r0],
  ['バット角度', 'vert. bat angle', null, r0],
  ['パワー_kW', 'power', null, r2],
  ['スイング時間_秒', 'time to contact', null, r2],
];
const KNOWN = ['captureid', 'swing timestamp', 'bat nickname', 'environment tag', 'first_name', 'last_name', 'handedness', ...METRICS.map(m => m[1])];

function ensureSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS blast_swings (
  swing_id INTEGER PRIMARY KEY,
  source_path TEXT NOT NULL, row_no INTEGER NOT NULL,
  capture_id TEXT,
  blast_player TEXT NOT NULL, ${q('選手名')} TEXT, player_key TEXT,
  tm_batter TEXT, tr_pitch_no INTEGER, tm_session_id TEXT,
  swing_ts_utc TEXT, ${q('日時')} TEXT, ${q('日付')} TEXT, ts_has_seconds INTEGER NOT NULL DEFAULT 1,
  ${q('バット')} TEXT, ${q('利き腕')} TEXT, ${q('スイング条件')} TEXT,
  ${METRICS.map(m => q(m[0]) + ' REAL').join(', ')},
  extra TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS blast_capture ON blast_swings(capture_id);
CREATE INDEX IF NOT EXISTS blast_player_date ON blast_swings(${q('選手名')}, ${q('日付')});
CREATE VIEW IF NOT EXISTS v_blast_daily AS
  SELECT ${q('選手名')}, player_key, ${q('日付')}, COUNT(*) AS スイング数,
    ROUND(AVG(${q('バットスピード_kmh')}),1) AS バットスピード平均, MAX(${q('バットスピード_kmh')}) AS バットスピード最大,
    ROUND(AVG(${q('アッパースイング度')}),1) AS アッパースイング度平均,
    ROUND(AVG(${q('スイング時間_秒')}),3) AS スイング時間平均,
    ROUND(AVG(${q('手の最大スピード_kmh')}),1) AS 手の最大スピード平均,
    ROUND(AVG(${q('回転加速度_G')}),1) AS 回転加速度平均,
    ROUND(AVG(${q('オンプレーン効率_pct')}),1) AS オンプレーン効率平均,
    ROUND(AVG(${q('パワー_kW')}),2) AS パワー平均
  FROM blast_swings GROUP BY ${q('選手名')}, player_key, ${q('日付')};
`);
}

const p2 = n => String(n).padStart(2, '0');
function toJst(s) {
  const m = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const hasSec = m[6] != null;
  const sec = hasSec ? +m[6] : 0;
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], sec) + 9 * 3600e3);
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return { date, hasSec, secOfDay: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(),
    minute: `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
    dt: `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`,
    utc: `${m[1]}-${p2(m[2])}-${p2(m[3])} ${p2(m[4])}:${m[5]}:${p2(sec)}` };
}
function cond(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[_-]/g, ' ').replace(/\s+/g, ' ');
  if (!k) return '';
  return COND[k] || k.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}
const headKey = h => String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s*\(.*\)\s*$/, '').trim();
const hasJa = s => /[぀-ヿ㐀-鿿]/.test(s);
const squash = s => String(s || '').normalize('NFKC').replace(/[\s　]+/g, '');
const romanKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Own-team players we can recognise: keys like 「エイジェック|加藤慶大」 plus TrackMan's "Katoh, Yoshihiro" names.
function rosterOf(db, extraNames) {
  const own = (() => { try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='own'").get().value); } catch (e) { return ''; } })();
  const keys = new Set();
  for (const r of db.prepare('SELECT player_key FROM players').all()) keys.add(r.player_key.replace(/^P\|/, ''));
  for (const r of db.prepare('SELECT player_key FROM body_notes').all()) keys.add(r.player_key);
  const roman = new Map();
  for (const r of db.prepare('SELECT tm_name, player_key FROM trackman_names').all()) {
    if (!r.player_key || r.player_key.startsWith('__')) continue;
    keys.add(r.player_key);
    roman.set(romanKey(r.tm_name), r.player_key);
  }
  // TrackMan batter name -> 選手マスタ 氏名 (from the measurement workbook: BatterId -> TMID)
  for (const [rk, nm] of Object.entries(extraNames || {})) {
    const k = (own ? own + '|' : '') + squash(nm);
    if (!roman.has(rk)) roman.set(rk, k);
    keys.add(k);
  }
  const byName = new Map();
  for (const k of keys) { const nm = k.split('|').pop(); if (!own || k.startsWith(own + '|')) byName.set(squash(nm), k); }
  return { byName, roman };
}
function matchAccount(roster, first, last) {
  const ja = hasJa(first + last);
  if (ja) return roster.byName.get(squash(last + first)) || roster.byName.get(squash(first + last)) || null;
  const a = romanKey(last + first), b = romanKey(first + last);
  return roster.roman.get(a) || roster.roman.get(b) || null;
}
function clockSec(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(String(s || '').trim());
  return m ? +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0) + (m[4] ? +('0.' + m[4]) : 0) : null;
}
function normDate(s) {
  s = String(s || '').trim();
  let m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s); if (m) return `${m[1]}-${p2(+m[2])}-${p2(+m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${p2(+m[1])}-${p2(+m[2])}`;
  return '';
}
// TrackMan pitches with a batter, grouped by day: [{sec, pitchNo, batter, session}]
function pitchesByDay(db) {
  const out = new Map();
  const rows = db.prepare(`SELECT s.session_id, s.session_date, p."Date" AS d, p."Time" AS t, p."PitchNo" AS no, p."Batter" AS b
    FROM trackman_pitches p JOIN trackman_sessions s ON s.session_id = p.session_id WHERE p."Batter" IS NOT NULL AND p."Batter" <> ''`).all();
  for (const r of rows) {
    const day = normDate(r.d) || r.session_date, sec = clockSec(r.t);
    if (!day || sec == null) continue;
    if (!out.has(day)) out.set(day, []);
    out.get(day).push({ sec, pitchNo: r.no === '' || r.no == null ? null : +r.no, batter: r.b, session: r.session_id, used: false });
  }
  return out;
}

// rows: 2-D array of strings. Returns {swings:[...]} or {err}.
function parseBlastTable(rows, fileName) {
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const ks = (rows[i] || []).map(headKey);
    if (ks.includes('bat speed') && ks.includes('swing timestamp')) { hi = i; break; }
  }
  if (hi < 0) return { err: 'Blast ConnectのCSVではないようです（「Swing Timestamp」「Bat Speed」の列がありません）' };
  const hdr = rows[hi].map(h => String(h || '').replace(/^﻿/, '').trim());
  const ks = hdr.map(headKey);
  const ix = k => ks.indexOf(k);
  const I = { id: ix('captureid'), ts: ix('swing timestamp'), bat: ix('bat nickname'), env: ix('environment tag'), fn: ix('first_name'), ln: ix('last_name'), hand: ix('handedness') };
  const mI = METRICS.map(m => ({ m, i: ix(m[1]), mph: ix(m[1]) >= 0 && /mph/i.test(hdr[ix(m[1])]) }));
  const fallbackName = path.basename(fileName).replace(/\.(csv|xlsx?)$/i, '');
  const swings = [];
  rows.slice(hi + 1).forEach((r, n) => {
    if (!r || I.ts < 0 || !String(r[I.ts] || '').trim()) return;
    const t = toJst(r[I.ts]); if (!t) return;
    const first = I.fn >= 0 ? String(r[I.fn] || '').trim() : '', last = I.ln >= 0 ? String(r[I.ln] || '').trim() : '';
    const account = (first || last) ? [first, last].filter(Boolean).join(' ') : fallbackName;
    const o = { row_no: n, capture: I.id >= 0 ? String(r[I.id] || '').trim() || null : null, first, last, blast_player: account, ts: t,
      bat: I.bat >= 0 ? String(r[I.bat] || '').trim() : '', hand: I.hand >= 0 ? String(r[I.hand] || '').trim() : '', cond: I.env >= 0 ? cond(r[I.env]) : '', vals: {}, extra: {} };
    for (const { m, i, mph } of mI) {
      if (i < 0) { o.vals[m[0]] = null; continue; }
      let v = parseFloat(String(r[i] || '').replace(/,/g, ''));
      if (isNaN(v)) { o.vals[m[0]] = null; continue; }
      if (m[2] === 'speed' && mph) v *= MPH;
      if (m[2] === 'pct' && v <= 1.5) v *= 100;
      o.vals[m[0]] = m[3](v);
    }
    hdr.forEach((h, i) => { if (h && !KNOWN.includes(ks[i]) && String(r[i] || '').trim() !== '') o.extra[h] = String(r[i]); });
    swings.push(o);
  });
  if (!swings.length) return { err: 'スイングの行がありませんでした' };
  return { swings, noSeconds: swings.every(s => !s.ts.hasSec) };
}

function readTables(core, rel, buf) {
  if (/\.csv$/i.test(rel)) return [core.Papa.parse(core.decodeBytes(new Uint8Array(buf)), { skipEmptyLines: 'greedy' }).data || []];
  if (/\.xlsx?$/i.test(rel)) {
    const wb = core.XLSX.read(buf, { type: 'buffer', cellDates: false, raw: false });
    return wb.SheetNames.map(n => core.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' }));
  }
  return null;
}

// items: [{rel, buf}] ; returns {added, matched}
function ingestBlast(core, db, items, notes, extraNames) {
  ensureSchema(db);
  if (!items.length) return { added: 0, matched: 0 };
  const roster = rosterOf(db, extraNames);
  const days = pitchesByDay(db);
  // pitches already taken by stored swings
  for (const r of db.prepare(`SELECT ${q('日付')} AS d, tr_pitch_no AS no, tm_session_id AS s FROM blast_swings WHERE tr_pitch_no IS NOT NULL`).all()) {
    for (const p of days.get(r.d) || []) if (p.pitchNo === r.no && p.session === r.s) p.used = true;
  }
  const del = db.prepare('DELETE FROM blast_swings WHERE source_path=?');
  const prev = db.prepare('SELECT capture_id, blast_player, swing_ts_utc FROM blast_swings WHERE source_path=?');
  const byCapture = db.prepare('SELECT swing_id, ts_has_seconds FROM blast_swings WHERE capture_id=? LIMIT 1');
  const delId = db.prepare('DELETE FROM blast_swings WHERE swing_id=?');
  const sameTs = db.prepare(`SELECT 1 FROM blast_swings WHERE blast_player=? AND swing_ts_utc=? AND ${q('バットスピード_kmh')} IS ? LIMIT 1`);
  const sameMinute = db.prepare(`SELECT 1 FROM blast_swings WHERE blast_player=? AND substr(${q('日時')},1,16)=? AND ${q('バットスピード_kmh')} IS ? LIMIT 1`);
  const ins = db.prepare(`INSERT OR IGNORE INTO blast_swings(source_path,row_no,capture_id,blast_player,${q('選手名')},player_key,tm_batter,tr_pitch_no,tm_session_id,swing_ts_utc,${q('日時')},${q('日付')},ts_has_seconds,${q('バット')},${q('利き腕')},${q('スイング条件')},${METRICS.map(m => q(m[0])).join(',')},extra)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${METRICS.map(() => '?').join(',')},?)`);
  let added = 0, matchedAll = 0;
  const unmatched = new Set();
  for (const it of items) {
    const tables = readTables(core, it.rel, it.buf);
    if (!tables) { notes.push(`✕ ${it.rel}：CSVかExcelのファイルではありません`); it.result = 'error'; continue; }
    let res = null;
    for (const t of tables) { const r = parseBlastTable(t, it.rel); if (!r.err) { res = r; break; } res = res || r; }
    if (!res || res.err) { notes.push(`✕ ${it.rel}：${(res && res.err) || '読み込めませんでした'}`); it.result = 'error'; continue; }
    const before = new Set(prev.all(it.rel).map(r => r.capture_id || (r.blast_player + '|' + r.swing_ts_utc)));
    db.exec('BEGIN');
    let a = 0, dup = 0, matched = 0, skipped = 0;
    const players = new Map(), ds = new Set();
    try {
      del.run(it.rel);
      for (const s of res.swings) {
        if (s.capture) {
          const old = byCapture.get(s.capture);
          // a row saved from a file without seconds is replaced by the original download (so it can get its batter)
          if (old && !old.ts_has_seconds && s.ts.hasSec) delId.run(old.swing_id);
          else if (old) { dup++; continue; }
        } else if (sameTs.get(s.blast_player, s.ts.utc, s.vals['バットスピード_kmh'])) { dup++; continue; }
        if (!s.ts.hasSec && !s.capture && sameMinute.get(s.blast_player, s.ts.minute, s.vals['バットスピード_kmh'])) { dup++; continue; }
        // batter from the TrackMan pitch nearest in time (seconds needed for a reliable match)
        let pitch = null;
        if (s.ts.hasSec) {
          let best = MATCH_SEC + 1;
          for (const p of days.get(s.ts.date) || []) { const d = Math.abs(p.sec - s.ts.secOfDay); if (!p.used && d < best) { best = d; pitch = p; } }
        }
        // the team's choice: keep only swings that line up with a TrackMan pitch
        if (!pitch) { skipped++; continue; }
        let key = null;
        if (pitch) key = roster.roman.get(romanKey(pitch.batter)) || null;
        if (!key) key = matchAccount(roster, s.first, s.last);
        const name = key ? key.split('|').pop() : (pitch ? pitch.batter : (hasJa(s.first + s.last) ? [s.last, s.first].filter(Boolean).join(' ') : s.blast_player));
        if (!key) unmatched.add(name);
        const extra = Object.assign({}, s.extra); if (!s.ts.hasSec) extra.__no_seconds = true;
        const info = ins.run(it.rel, s.row_no, s.capture, s.blast_player, name, key, pitch ? pitch.batter : null, pitch ? pitch.pitchNo : null, pitch ? pitch.session : null,
          s.ts.utc, s.ts.dt, s.ts.date, s.ts.hasSec ? 1 : 0, s.bat, s.hand, s.cond, ...METRICS.map(m => s.vals[m[0]]), Object.keys(extra).length ? JSON.stringify(extra) : null);
        if (!info.changes) { dup++; continue; }
        if (pitch) { pitch.used = true; matched++; }
        if (!before.has(s.capture || (s.blast_player + '|' + s.ts.utc))) { a++; players.set(name, (players.get(name) || 0) + 1); ds.add(s.ts.date); }
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); notes.push(`✕ ${it.rel}：保存できませんでした（${e.message}）`); it.result = 'error'; continue; }
    added += a; matchedAll += matched;
    const dl = [...ds].sort();
    const lines = [a ? `${a}スイングを追加（${[...players.entries()].map(([n, c]) => `${n} ${c}`).join('、')}${dl.length ? `／${dl[0]}${dl.length > 1 ? '〜' + dl[dl.length - 1] : ''}` : ''}）` : '新しいスイングはありませんでした'];
    if (matched) lines.push(`トラックマンの投球と時刻が一致して打者がわかったスイング：${matched}本`);
    if (dup) lines.push(`登録済みのスイング ${dup}本はスキップ`);
    if (skipped) lines.push(`トラックマンの投球と時刻が合わない ${skipped}本は入れていません`);
    if (res.noSeconds) lines.push('※ このファイルは時刻に「秒」がありません（Excelで開いて保存すると消えます）。トラックマンと結びつけられないので、Blast Connectからダウンロードしたままのファイルを入れてください');
    notes.push(`・${it.rel}\n    ` + lines.join('\n    '));
    it.result = 'ok';
  }
  if (unmatched.size) notes.push(`※ Blastで選手がわからなかったスイングの名前（そのままの名前で保存しています）：${[...unmatched].join('、')}`);
  return { added, matched: matchedAll };
}

module.exports = { ensureSchema, ingestBlast, parseBlastTable };
