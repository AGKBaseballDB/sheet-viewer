'use strict';
// トピック.xlsx (top of the data folder) -> table "topics", plus the page seed for the TOPICS view.
// Columns (header row, any order): 日付 / 区分 / タイトル / 本文 / リンク / 出典 / 画像 / 注目
//   区分: お知らせ・試合・チーム・代表・イベント・メディア など自由に（同じ言葉が絞り込みボタンになる）
//   本文: 改行はそのまま段落になる ・ リンク: 記事・投稿のURL（なくてもよい） ・ 画像: 画像のURL（なくてもよい）
//   出典: 新聞名など（空ならURLから判定：下野新聞・毎日新聞・Instagram・X など）。区分か出典に「部内」と書くと部内限定の印
//   注目: ○ などを入れると、ホームの一番大きな枠に出る
// The workbook is the source of truth: every import replaces the whole table. The file stays in the folder.
const { dateOf, textOf } = require('./schedule.cjs');
const TOPICS_FILE = 'トピック.xlsx';
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const COLS = ['日付', '区分', 'タイトル', '本文', 'リンク', '出典', '画像', '注目'];

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS topics (row_no INTEGER PRIMARY KEY, ${COLS.map(c => q(c) + ' TEXT').join(', ')}, source_path TEXT, imported_at TEXT);`);
  const have = new Set(db.prepare('PRAGMA table_info(topics)').all().map(r => r.name));
  for (const c of COLS) if (!have.has(c)) db.exec(`ALTER TABLE topics ADD COLUMN ${q(c)} TEXT`);
}
const isTopicsFile = rel => String(rel).normalize('NFKC') === TOPICS_FILE.normalize('NFKC');
const urlOf = cell => {
  if (!cell) return '';
  if (cell.l && cell.l.Target && /^https?:/i.test(cell.l.Target)) return cell.l.Target.trim();
  const m = /https?:\/\/[^\s"'<>、，,]+/.exec(String(cell.v == null ? '' : cell.v));
  return m ? m[0] : '';
};
const yes = s => /^(○|◯|〇|●|◎|★|☆|1|yes|y|true|はい|注目|固定)$/i.test(String(s || '').normalize('NFKC').trim());

function parseTopics(X, buf) {
  const wb = X.read(buf, { type: 'buffer', cellDates: true, cellNF: true, cellText: true });
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const R = X.utils.decode_range(ws['!ref']);
    const at = (r, c) => ws[X.utils.encode_cell({ r, c })];
    for (let hr = R.s.r; hr <= Math.min(R.e.r, R.s.r + 9); hr++) {
      const H = [];
      for (let c = R.s.c; c <= R.e.c; c++) H.push({ c, h: textOf(at(hr, c)).normalize('NFKC').replace(/\s/g, '') });
      const find = re => (H.find(x => re.test(x.h)) || {}).c;
      const cT = find(/^(タイトル|見出し|題名|件名)$/);
      if (cT == null) continue;
      const cD = find(/^(日付|掲載日|日にち|公開日)$/), cC = find(/^(区分|カテゴリー?|種類|分類|タグ)$/), cB = find(/^(本文|内容|説明|記事|コメント)$/);
      const cL = find(/^(リンク|URL|記事URL|リンクURL)$/i), cS = find(/^(出典|媒体|ソース|出どころ|掲載元)$/), cI = find(/^(画像|写真|画像URL|サムネイル)$/i), cP = find(/^(注目|固定|ピン|トップ)$/);
      const rows = [], bad = [];
      for (let r = hr + 1; r <= R.e.r; r++) {
        const t = textOf(at(r, cT));
        const d = cD != null ? dateOf(at(r, cD), X) : '';
        const body = cB != null ? String((at(r, cB) || {}).v == null ? '' : at(r, cB).v).trim() : '';
        if (!t && !body) continue;
        if (!t) { bad.push(r + 1); continue; }
        rows.push({ d, cat: cC != null ? textOf(at(r, cC)) : '', t, body, url: cL != null ? urlOf(at(r, cL)) : '', src: cS != null ? textOf(at(r, cS)) : '', img: cI != null ? urlOf(at(r, cI)) : '', pin: cP != null && yes(textOf(at(r, cP))) });
      }
      return { sheet: name, rows, bad };
    }
  }
  return { err: '「タイトル」の列が見つかりません（1行目に 日付・区分・タイトル・本文・リンク などの見出しを入れてください）' };
}

function ingestTopics(core, db, items, notes) {
  ensureSchema(db);
  if (!items.length) return { changed: false, n: 0 };
  const it = items[items.length - 1];
  const r = parseTopics(core.XLSX, it.buf);
  if (r.err) { notes.push(`✕ ${it.rel}：${r.err}`); it.result = 'error'; return { changed: false, n: 0 }; }
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM topics');
    const ins = db.prepare(`INSERT INTO topics(row_no,${COLS.map(q).join(',')},source_path,imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    r.rows.forEach((o, i) => ins.run(i, o.d, o.cat, o.t, o.body, o.url, o.src, o.img, o.pin ? '○' : '', it.rel, now));
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  notes.push(`○ ${it.rel}：トピック ${r.rows.length}件`);
  if (r.bad.length) notes.push(`△ ${it.rel}：タイトルがない行を飛ばしました（${r.bad.slice(0, 10).join('・')}行目${r.bad.length > 10 ? 'ほか' : ''}）`);
  it.result = r.bad.length ? 'ok (some rows skipped)' : 'ok';
  return { changed: true, n: r.rows.length };
}

// newest first; rows without a date go last in the order of the sheet
function topicsSeed(db) {
  ensureSchema(db);
  const rows = db.prepare('SELECT * FROM topics ORDER BY row_no').all().map(o => {
    const s = { t: o['タイトル'] };
    if (o['日付']) s.d = o['日付']; if (o['区分']) s.cat = o['区分']; if (o['本文']) s.body = o['本文'];
    if (o['リンク']) s.url = o['リンク']; if (o['出典']) s.src = o['出典']; if (o['画像']) s.img = o['画像']; if (o['注目']) s.pin = 1;
    s.n = o.row_no;
    return s;
  });
  rows.sort((a, b) => (b.d || '').localeCompare(a.d || '') || a.n - b.n);
  rows.forEach(s => delete s.n);
  return rows;
}

module.exports = { TOPICS_FILE, ensureSchema, isTopicsFile, parseTopics, ingestTopics, topicsSeed };
