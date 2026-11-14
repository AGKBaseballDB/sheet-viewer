'use strict';
// 試合日程.xlsx (top of the data folder) -> table "schedule", plus the page seed for the 試合日程 / Blast views.
// Columns (header row, any order): 日付 / 時刻 / 大会 / チーム1 / チーム2 / 球場 / 動画の列（中継映像・CC映像・動画URL など。列は何列でも・1セルに複数可）/ メモ
// 動画URL欄は「名前<TAB>URL」を1行ずつ保存（名前は列の見出しか、セルでURLの前に書いた文字）
// The workbook is the source of truth: every import replaces the whole table. The file stays in the folder.
const SCHEDULE_FILE = '試合日程.xlsx';
const MPH = 1.609344;
const q = s => '"' + String(s).replace(/"/g, '""') + '"';

function ensureSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS schedule (
  row_no INTEGER PRIMARY KEY, ${q('日付')} TEXT NOT NULL, ${q('時刻')} TEXT, ${q('大会')} TEXT, ${q('チーム1')} TEXT, ${q('チーム2')} TEXT,
  ${q('球場')} TEXT, ${q('動画URL')} TEXT, ${q('メモ')} TEXT, source_path TEXT, imported_at TEXT);`);
}
const isScheduleFile = rel => String(rel).normalize('NFKC') === SCHEDULE_FILE.normalize('NFKC');

const p2 = n => String(n).padStart(2, '0');
function dateOf(cell, X) {
  if (!cell) return '';
  if (cell.t === 'd' && cell.v instanceof Date) { const d = new Date(Math.round(cell.v.getTime() / 1000) * 1000); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
  if (cell.t === 'n' && cell.v > 20000 && cell.v < 80000) { const p = X.SSF.parse_date_code(cell.v); if (p) return `${p.y}-${p2(p.m)}-${p2(p.d)}`; }
  const s = String(cell.w != null ? cell.w : cell.v).normalize('NFKC').trim();
  let m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
  return '';
}
function timeOf(cell, X) {
  if (!cell) return '';
  if (cell.t === 'd' && cell.v instanceof Date) { const d = new Date(Math.round(cell.v.getTime() / 1000) * 1000); return `${d.getHours()}:${p2(d.getMinutes())}`; }
  if (cell.t === 'n' && cell.v >= 0 && cell.v < 1) { const mins = Math.round(cell.v * 1440); return `${Math.floor(mins / 60)}:${p2(mins % 60)}`; }
  return String(cell.w != null ? cell.w : cell.v).normalize('NFKC').trim();
}
const textOf = cell => (!cell ? '' : String(cell.w != null ? cell.w : (cell.v == null ? '' : cell.v)).trim());
// 動画のリンク。セルの文字が「CC https://…」のように前に名前があれば、その名前を動画の名前にする。
// 名前がなければ列の見出し（「CC映像」→「CC」、「中継映像」→「中継」。「動画URL」「動画URL2」は名前なし）を使う
function urlsOf(cell, label) {
  if (!cell) return [];
  const out = [], seen = new Set();
  const push = (u, l) => { u = u.trim(); if (!u || seen.has(u)) return; seen.add(u); out.push((l || label || '').trim() + '\t' + u); };
  const t = String(cell.v == null ? '' : cell.v);
  const re = /https?:\/\/[^\s"'<>、，,]+/g; let m, last = 0;
  while ((m = re.exec(t))) { const pre = t.slice(last, m.index).replace(/[\s:：|｜\-－]+$/,'').split(/\r?\n/).pop().trim(); push(m[0], pre); last = m.index + m[0].length; }
  if (cell.l && cell.l.Target && /^https?:/i.test(cell.l.Target)) push(cell.l.Target, '');
  return out;
}
const urlLabel = h => { h = String(h || '').normalize('NFKC').replace(/\s/g, ''); if (/^(動画)?(URL|url|リンク|YouTube|youtube)?\d*$/.test(h) || /^動画URL\d*$/i.test(h)) return ''; return h.replace(/(の)?(映像|動画|URL|リンク)\d*$/i, '') || h; };
function parseSchedule(X, buf) {
  const wb = X.read(buf, { type: 'buffer', cellDates: true, cellNF: true, cellText: true });
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const R = X.utils.decode_range(ws['!ref']);
    const at = (r, c) => ws[X.utils.encode_cell({ r, c })];
    // header: first row (within the first 10) that has 日付
    for (let hr = R.s.r; hr <= Math.min(R.e.r, R.s.r + 9); hr++) {
      const H = [];
      for (let c = R.s.c; c <= R.e.c; c++) H.push({ c, h: textOf(at(hr, c)).normalize('NFKC').replace(/\s/g, '') });
      const find = re => (H.find(x => re.test(x.h)) || {}).c;
      const cDate = find(/^(日付|試合日|日にち)$/);
      if (cDate == null) continue;
      const cTime = find(/^(時刻|時間|開始|開始時刻|試合開始)$/), cComp = find(/^(大会|大会名|区分|大会・区分)$/), cMemo = find(/^(メモ|備考)$/);
      const cA = find(/^(チーム1|チーム|ホーム|先攻|自チーム)$/), cB = find(/^(チーム2|対戦相手|相手|相手チーム|ビジター|後攻)$/);
      const cVenue = find(/^(球場|会場|場所)$/);
      const cUrls = H.filter(x => /URL|動画|YouTube|リンク|映像|^CC/i.test(x.h)).map(x => ({ c: x.c, l: urlLabel(x.h) }));
      const rows = [], bad = [];
      for (let r = hr + 1; r <= R.e.r; r++) {
        const d = dateOf(at(r, cDate), X);
        const a = cA != null ? textOf(at(r, cA)) : '', b = cB != null ? textOf(at(r, cB)) : '';
        const urls = cUrls.flatMap(o => urlsOf(at(r, o.c), o.l));
        const anything = d || a || b || urls.length || (cVenue != null && textOf(at(r, cVenue)));
        if (!anything) continue;
        if (!d) { bad.push(r + 1); continue; }
        rows.push({ d, t: cTime != null ? timeOf(at(r, cTime), X) : '', comp: cComp != null ? textOf(at(r, cComp)) : '', a, b,
          venue: cVenue != null ? textOf(at(r, cVenue)) : '', urls, memo: cMemo != null ? textOf(at(r, cMemo)) : '' });
      }
      return { sheet: name, rows, bad };
    }
  }
  return { err: '「日付」の列が見つかりません（1行目に 日付・チーム1・チーム2・球場・動画URL などの見出しを入れてください）' };
}

function ingestSchedule(core, db, items, notes) {
  ensureSchema(db);
  if (!items.length) return { changed: false, n: 0 };
  const it = items[items.length - 1];
  const r = parseSchedule(core.XLSX, it.buf);
  if (r.err) { notes.push(`✕ ${it.rel}：${r.err}`); it.result = 'error'; return { changed: false, n: 0 }; }
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM schedule');
    const ins = db.prepare(`INSERT INTO schedule(row_no,${['日付', '時刻', '大会', 'チーム1', 'チーム2', '球場', '動画URL', 'メモ'].map(q).join(',')},source_path,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    r.rows.forEach((o, i) => ins.run(i, o.d, o.t, o.comp, o.a, o.b, o.venue, o.urls.join('\n'), o.memo, it.rel, now));
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  const nv = r.rows.filter(o => o.urls.length).length;
  notes.push(`○ ${it.rel}：試合日程 ${r.rows.length}行（動画あり ${nv}試合）`);
  if (r.bad.length) notes.push(`△ ${it.rel}：日付が読めない行を飛ばしました（${r.bad.slice(0, 10).join('・')}行目${r.bad.length > 10 ? 'ほか' : ''}）。日付は 2026/11/3 の形で入れてください`);
  it.result = r.bad.length ? 'ok (some rows skipped)' : 'ok';
  return { changed: true, n: r.rows.length };
}

// ---------- page seed
function schedSeed(db) {
  ensureSchema(db);
  return db.prepare(`SELECT * FROM schedule ORDER BY row_no`).all().map(o => {
    const s = { d: o['日付'] };
    if (o['時刻']) s.t = o['時刻']; if (o['大会']) s.comp = o['大会']; if (o['チーム1']) s.a = o['チーム1']; if (o['チーム2']) s.b = o['チーム2'];
    if (o['球場']) s.venue = o['球場']; if (o['動画URL']) s.urls = o['動画URL'].split('\n').filter(Boolean);  // メモはExcelの中だけ（ページには出さない）
    return s;
  });
}
const BLAST_COLS = ['key', 'name', 'date', 'time', 'cond', 'bs', 'hs', 'ra', 'ope', 'aa', 'ec', 'ci', 'vba', 'pw', 'ttc', 'ev', 'la'];
function blastSeed(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='blast_swings'").get();
  if (!has) return null;
  const num = v => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const r1 = (v, d) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
  const rows = db.prepare(`SELECT b.player_key, b.${q('選手名')} AS nm, b.${q('日付')} AS d, b.${q('日時')} AS dt, b.${q('スイング条件')} AS cond,
      b.${q('バットスピード_kmh')} AS bs, b.${q('手の最大スピード_kmh')} AS hs, b.${q('回転加速度_G')} AS ra, b.${q('オンプレーン効率_pct')} AS ope,
      b.${q('アッパースイング度')} AS aa, b.${q('体とバットの角度_構え')} AS ec, b.${q('体とバットの角度_インパクト')} AS ci, b.${q('バット角度')} AS vba,
      b.${q('パワー_kW')} AS pw, b.${q('スイング時間_秒')} AS ttc, t.ExitSpeed AS ev, t.Angle AS la
    FROM blast_swings b LEFT JOIN trackman_pitches t ON t.session_id = b.tm_session_id AND CAST(t.PitchNo AS INTEGER) = b.tr_pitch_no
    WHERE b.${q('選手名')} IS NOT NULL AND b.${q('選手名')} <> ''
    ORDER BY b.${q('日時')}, b.capture_id`).all();
  if (!rows.length) return null;
  return {
    cols: BLAST_COLS,
    rows: rows.map(o => [o.player_key || '', o.nm, o.d, String(o.dt || '').slice(11, 19), o.cond || '',
      num(o.bs), num(o.hs), num(o.ra), num(o.ope), num(o.aa), num(o.ec), num(o.ci), num(o.vba), num(o.pw), num(o.ttc),
      r1(num(o.ev) == null ? null : num(o.ev) * MPH, 1), r1(num(o.la), 1)]),
  };
}

module.exports = { SCHEDULE_FILE, ensureSchema, isScheduleFile, parseSchedule, ingestSchedule, schedSeed, blastSeed, dateOf, textOf };
