#!/usr/bin/env python3
"""Append TrackMan / Blast CSV rows to 【男子野球部】…測定DB.xlsx without re-saving the workbook.

Only the sheet XML of Trackmandata / Blast / 選手マスタ is touched (rows appended, ranges widened);
every other part of the file (data-validation extensions, styles, shared strings) is copied byte-for-byte.
選手マスタ: one row per player per measurement day — players in newly added TrackMan rows who have no
row for that day get one, copied from their latest row (A..W).

  python3 -I measure_xlsx.py --xlsx IN.xlsx --out OUT.xlsx --tm-dir DIR --blast-dir DIR [--report R.txt]

Blast rows get the same conversions as 「Blast CSV → DB貼り付け変換」 and, from the
TrackMan pitch thrown within a few seconds of the swing on the same day:
  C: TRPitchNo. (the pitch's PitchNo), A: 選手名 (選手マスタ 氏名 for the batter's TMID),
  B: =XLOOKUP(A, 選手マスタ!K:K, 選手マスタ!W:W, 0)  (same formula as the existing rows)
"""
import argparse, csv, datetime as dt, io, json, math, os, re, sys, zipfile
from xml.sax.saxutils import escape

MATCH_SEC = 10          # swing ↔ pitch time window
MPH = 1.609344
WD = '月火水木金土日'   # Python weekday(): Monday=0
COND = {'tee': 'Tee', 'front toss overhand': 'Front Toss Overhand', 'front toss underhand': 'Front Toss Underhand',
        'soft toss': 'Soft Toss', 'live pitch': 'Live Pitch', 'general practice': 'General Practice', 'in game': 'In Game'}

# ---------------------------------------------------------------- helpers
def col_letter(n):  # 1-based
    s = ''
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n

def read_text(b):
    for enc in ('utf-8-sig', 'cp932'):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode('utf-8', 'replace')

def read_csv(path):
    with open(path, 'rb') as f:
        return list(csv.reader(io.StringIO(read_text(f.read()))))

def num(v):
    if v is None:
        return None
    s = str(v).strip().replace(',', '')
    if s == '':
        return None
    try:
        x = float(s)
        return x if math.isfinite(x) else None
    except ValueError:
        return None

EPOCH = dt.datetime(1899, 12, 30)
def excel_serial_date(d):
    return (dt.datetime(d.year, d.month, d.day) - EPOCH).days

def norm_name(s):
    import unicodedata
    return re.sub(r'[\s　]+', '', unicodedata.normalize('NFKC', str(s or ''))).replace('髙', '高').replace('﨑', '崎')

def roman_key(s):
    return re.sub(r'[^a-z]', '', str(s or '').lower())

# ---------------------------------------------------------------- workbook parts
class Book:
    def __init__(self, path):
        self.zin = zipfile.ZipFile(path)
        self.parts = {n: self.zin.read(n) for n in self.zin.namelist()}
        wb = self.parts['xl/workbook.xml'].decode('utf-8')
        rels = self.parts['xl/_rels/workbook.xml.rels'].decode('utf-8')
        rid2t = dict(re.findall(r'<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"', rels))
        rid2t.update({a: b for b, a in re.findall(r'<Relationship [^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"', rels)})
        self.sheets = {}
        self.tm_new_dates = set()
        for name, rid in re.findall(r'<sheet name="([^"]+)"[^>]*?r:id="([^"]+)"', wb):
            t = rid2t[rid]
            self.sheets[name] = 'xl/' + t if not t.startswith('/') else t[1:]
        self.sst = []
        if 'xl/sharedStrings.xml' in self.parts:
            x = self.parts['xl/sharedStrings.xml'].decode('utf-8')
            for si in re.findall(r'<si>(.*?)</si>', x, re.S):
                txt = ''.join(re.findall(r'<t(?: [^>]*)?>(.*?)</t>', re.sub(r'<rPh .*?</rPh>', '', si, flags=re.S), re.S))
                self.sst.append(unescape(txt))

    def sheet_xml(self, name):
        return self.parts[self.sheets[name]].decode('utf-8')

    def set_sheet_xml(self, name, xml):
        self.parts[self.sheets[name]] = xml.encode('utf-8')

    def save(self, out):
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for info in self.zin.infolist():
                z.writestr(info, self.parts[info.filename], compress_type=zipfile.ZIP_DEFLATED)

def unescape(s):
    return s.replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'").replace('&amp;', '&')

ROW_RE = re.compile(r'<row [^>]*?r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', re.S)
CELL_RE = re.compile(r'<c r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', re.S)

def cell_value(book, attrs, inner):
    if inner is None:
        return None
    t = re.search(r't="([^"]+)"', attrs)
    t = t.group(1) if t else 'n'
    if t == 'inlineStr':
        return unescape(''.join(re.findall(r'<t(?: [^>]*)?>(.*?)</t>', inner, re.S)))
    v = re.search(r'<v>(.*?)</v>', inner, re.S)
    if not v:
        return None
    v = v.group(1)
    if t == 's':
        return book.sst[int(v)]
    if t in ('str', 'e'):
        return unescape(v)
    if t == 'b':
        return v == '1'
    try:
        return float(v)
    except ValueError:
        return v

def read_rows(book, xml):
    """-> list of (rownum, {col_letter: (value, style, has_formula)}), raw row xml map"""
    out = []
    for m in ROW_RE.finditer(xml):
        r = int(m.group(1))
        cells = {}
        for cm in CELL_RE.finditer(m.group(2) or ''):
            attrs, inner = cm.group(3), cm.group(4)
            st = re.search(r's="(\d+)"', attrs)
            cells[cm.group(1)] = (cell_value(book, attrs, inner), st.group(1) if st else None, bool(inner and '<f' in inner))
        out.append((r, cells, m.span()))
    return out

def c_num(ref, v, s):
    sa = f' s="{s}"' if s else ''
    return f'<c r="{ref}"{sa}><v>{repr(float(v)) if not float(v).is_integer() else int(v)}</v></c>'

def c_str(ref, v, s):
    sa = f' s="{s}"' if s else ''
    return f'<c r="{ref}"{sa} t="inlineStr"><is><t xml:space="preserve">{escape(str(v))}</t></is></c>'

def c_formula(ref, f, s):
    sa = f' s="{s}"' if s else ''
    return f'<c r="{ref}"{sa}><f>{escape(f)}</f></c>'

def widen_ranges(xml, sheet_last_row, last_col):
    xml = re.sub(r'<dimension ref="A1:[A-Z]+\d+"/>', f'<dimension ref="A1:{last_col}{sheet_last_row}"/>', xml, count=1)
    xml = re.sub(r'(<autoFilter ref="A1:[A-Z]+)\d+"', lambda m: f'{m.group(1)}{sheet_last_row}"', xml, count=1)
    return xml

def put_rows(xml, rows_by_num, existing_spans):
    """rows_by_num: {r: '<row ...>...</row>'}; replaces existing row elements with those numbers, inserts the rest in order."""
    pieces, pos = [], 0
    handled = set()
    for r, span in existing_spans:
        if r in rows_by_num:
            pieces.append(xml[pos:span[0]])
            pieces.append(rows_by_num[r])
            pos = span[1]
            handled.add(r)
    pieces.append(xml[pos:])
    xml = ''.join(pieces)
    rest = [rows_by_num[r] for r in sorted(rows_by_num) if r not in handled]
    if rest:
        i = xml.index('</sheetData>')
        xml = xml[:i] + ''.join(rest) + xml[i:]
    return xml

# ---------------------------------------------------------------- TrackMan
def parse_tm_date(s):
    s = str(s or '').strip()
    m = re.match(r'(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})', s)
    if m:
        return dt.date(int(m[1]), int(m[2]), int(m[3]))
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{4})', s)
    if m:
        return dt.date(int(m[3]), int(m[1]), int(m[2]))
    return None

def parse_clock(s):
    m = re.match(r'^\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*$', str(s or ''))
    if not m:
        return None
    sec = int(m[3] or 0) + (float('0.' + m[4]) if m[4] else 0)
    return (int(m[1]) * 3600 + int(m[2]) * 60 + sec) / 86400

def tm_sheet(book, csv_paths, notes):
    name = 'Trackmandata'
    xml = book.sheet_xml(name)
    rows = read_rows(book, xml)
    header = {c: v for c, (v, s, f) in rows[0][1].items()} if rows else {}
    cols = sorted(header, key=col_index)
    hname = {c: str(header[c]).strip() for c in cols}
    by_h = {hname[c]: c for c in cols}
    data_rows = [r for r in rows[1:] if any(v not in (None, '') for v, s, f in r[1].values())]
    last = data_rows[-1][0] if data_rows else 1
    styles = {c: s for c, (v, s, f) in (data_rows[-1][1].items() if data_rows else [])}
    row_attr = re.search(r'<row r="%d"([^>]*)>' % last, xml)
    row_extra = re.sub(r'\s*r="\d+"', '', row_attr.group(1)) if row_attr else ''
    play_col = by_h.get('PlayID')
    seen = {r[1][play_col][0] for r in data_rows if play_col in r[1]} if play_col else set()
    pitches = []  # for Blast matching: (date, seconds, PitchNo, BatterId, Batter)
    def add_pitch(cells_get):
        d, t = cells_get('Date'), cells_get('Time')
        if d is None or t is None:
            return
        pitches.append((d, t * 86400, cells_get('PitchNo'), cells_get('BatterId'), cells_get('Batter')))
    for r, cells, _ in data_rows:
        def g(h, cells=cells):
            c = by_h.get(h)
            v = cells.get(c, (None,))[0] if c else None
            if h == 'Date' and isinstance(v, float):
                return (EPOCH + dt.timedelta(days=v)).date()
            return v
        add_pitch(g)
    new_rows, added, dup, bad = {}, 0, 0, []
    nxt = last + 1
    for p in csv_paths:
        rel = os.path.basename(p)
        try:
            table = read_csv(p)
        except Exception as e:
            bad.append(f'{rel}：読み込めませんでした（{e}）'); continue
        if not table or 'Pitcher' not in [h.strip() for h in table[0]] or 'PitchNo' not in [h.strip() for h in table[0]]:
            bad.append(f'{rel}：トラックマンのCSVではないようです'); continue
        hdr = [h.replace('﻿', '').strip() for h in table[0]]
        idx = {h: i for i, h in enumerate(hdr)}
        a = d0 = 0
        for line in table[1:]:
            if not any(x.strip() for x in line):
                continue
            get = lambda h: line[idx[h]].strip() if h in idx and idx[h] < len(line) else ''
            pid = get('PlayID')
            if pid and pid in seen:
                d0 += 1; continue
            if pid:
                seen.add(pid)
            cells = []
            vals = {}
            for c in cols:
                h = hname[c]
                raw = get(h)
                if raw == '':
                    continue
                ref = f'{c}{nxt}'
                s = styles.get(c)
                if h == 'Date':
                    d = parse_tm_date(raw)
                    if d:
                        cells.append(c_num(ref, excel_serial_date(d), s)); vals[h] = d; continue
                if h in ('Time', 'Tilt'):
                    fr = parse_clock(raw)
                    if fr is not None:
                        cells.append(c_num(ref, fr, s)); vals[h] = fr; continue
                x = num(raw)
                if x is not None and not re.match(r'^0\d', raw):
                    cells.append(c_num(ref, x, s)); vals[h] = x
                else:
                    cells.append(c_str(ref, raw, s)); vals[h] = raw
            new_rows[nxt] = f'<row r="{nxt}"{row_extra}>' + ''.join(cells) + '</row>'
            add_pitch(lambda h: vals.get(h))
            if isinstance(vals.get('Date'), dt.date):
                book.tm_new_dates.add(vals['Date'].isoformat())
            nxt += 1; a += 1
        added += a; dup += d0
        notes.append(f'・トラックマン {rel}：{a}球をExcelに追加' + (f'（登録済み {d0}球はスキップ）' if d0 else ''))
    for b in bad:
        notes.append('✕ ' + b)
    if new_rows:
        xml = put_rows(xml, new_rows, [(r, sp) for r, c, sp in rows])
        xml = widen_ranges(xml, nxt - 1, col_letter(max(len(cols), col_index(cols[-1]) if cols else 1)))
        m = re.search(r'<dimension ref="A1:([A-Z]+)\d+"/>', book.sheet_xml(name))
        if m:
            xml = re.sub(r'<dimension ref="A1:[A-Z]+\d+"/>', f'<dimension ref="A1:{m.group(1)}{nxt - 1}"/>', xml, count=1)
        book.set_sheet_xml(name, xml)
    return added, pitches

# ---------------------------------------------------------------- Blast
B_METRICS = [  # (sheet column, blast header (lower, no unit), kind, rounding)
    ('K', 'bat speed', 'speed', 1), ('L', 'rotational acceleration', None, 1), ('M', 'on plane efficiency', 'pct', 0),
    ('N', 'attack angle', None, 0), ('O', 'early connection', None, 0), ('P', 'connection at impact', None, 0),
    ('Q', 'vert. bat angle', None, 0), ('R', 'power', None, 2), ('S', 'time to contact', None, 2), ('T', 'peak hand speed', 'speed', 1),
]
def hkey(h):
    return re.sub(r'\s*\(.*\)\s*$', '', str(h or '').replace('﻿', '').strip().lower()).strip()

def rnd(v, d):
    x = round(v + (1e-9 if v >= 0 else -1e-9), d) if d else int(math.floor(v + 0.5))
    return x

def blast_dt(s):
    """-> (JST datetime, has_seconds) or (None, False)"""
    m = re.search(r'(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?', str(s or ''))
    if not m:
        return None, False
    return dt.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0)) + dt.timedelta(hours=9), m[6] is not None

def jp_label(t):
    return f'{t.year}年 {t.month}月 {t.day}日 {WD[t.weekday()]}曜日 {t:%H:%M:%S}'

def cond(s):
    k = re.sub(r'\s+', ' ', re.sub(r'[_-]', ' ', str(s or '').strip().lower()))
    if not k:
        return ''
    return COND.get(k) or ' '.join(w[:1].upper() + w[1:] for w in k.split(' '))

def master_maps(book):
    xml = book.sheet_xml('選手マスタ')
    rows = read_rows(book, xml)
    hdr = {str(v).strip(): c for c, (v, s, f) in rows[0][1].items() if v is not None}
    kc, wc, vc = hdr.get('氏名', 'K'), hdr.get('TMID', 'W'), hdr.get('打', 'V')
    by_id, by_name = {}, {}
    for r, cells, _ in rows[1:]:
        nm = cells.get(kc, (None,))[0]
        tid = cells.get(wc, (None,))[0]
        bat = cells.get(vc, (None,))[0]
        if not nm:
            continue
        rec = {'name': str(nm), 'bat': bat if bat in ('右', '左', '両') else ''}
        if isinstance(tid, float):
            tid = int(tid)
        if tid not in (None, ''):
            by_id[str(tid)] = rec
        by_name.setdefault(norm_name(nm), rec)
    return by_id, by_name

def blast_sheet(book, csv_paths, pitches, notes, game=None):
    game = game or {}  # 'YYYY-MM-DD HH:MM:SS'(JST) -> player: swings the DB matched to a game-record pitch
    name = 'Blast'
    xml = book.sheet_xml(name)
    rows = read_rows(book, xml)
    data = [r for r in rows[1:] if r[1].get('D', (None,))[0] not in (None, '')]
    last_d = data[-1][0] if data else 1
    seen = {str(r[1]['D'][0]) for r in data}
    # for files whose timestamps lost their seconds (opened and saved in Excel): same minute + same bat speed
    def kval(v):
        try:
            return round(float(v), 1)
        except (TypeError, ValueError):
            return None
    seen_min = {(str(r[1]['D'][0])[:-3], kval(r[1].get('K', (None,))[0])) for r in data}
    tmpl = {c: s for c, (v, s, f) in (data[-1][1].items() if data else [])}
    st = lambda c: tmpl.get(c, '23' if c >= 'E' else None)
    b_style = next((s for r, cells, _ in rows[1:] for c, (v, s, f) in cells.items() if c == 'B' and f), tmpl.get('B'))
    prefilled = {r for r, cells, _ in rows[1:] if r > last_d}
    by_id, by_name = master_maps(book)
    # TrackMan roman name -> id (for swings with no matching pitch)
    roman2id = {}
    for d, sec, pno, bid, bname in pitches:
        if bid not in (None, '') and bname:
            roman2id[roman_key(bname)] = str(int(bid) if isinstance(bid, float) else bid)
    by_day = {}
    for p in pitches:
        by_day.setdefault(p[0], []).append(p)
    swings, bad = [], []
    for p in csv_paths:
        rel = os.path.basename(p)
        try:
            table = read_csv(p)
        except Exception as e:
            bad.append(f'{rel}：読み込めませんでした（{e}）'); continue
        hi = next((i for i, r in enumerate(table[:15]) if 'bat speed' in [hkey(h) for h in r] and 'swing timestamp' in [hkey(h) for h in r]), -1)
        if hi < 0:
            bad.append(f'{rel}：Blast ConnectのCSVではないようです'); continue
        raw_h = table[hi]
        ks = [hkey(h) for h in raw_h]
        ix = lambda k: ks.index(k) if k in ks else -1
        I = {k: ix(k) for k in ('swing timestamp', 'bat nickname', 'environment tag', 'first_name', 'last_name')}
        mph = {k: (ix(k) >= 0 and 'mph' in raw_h[ix(k)].lower()) for _, k, kind, _ in B_METRICS}
        n_file = n_dup = n_nosec = 0
        for r in table[hi + 1:]:
            g = lambda k: r[I[k]].strip() if I[k] >= 0 and I[k] < len(r) else ''
            t, has_sec = blast_dt(g('swing timestamp'))
            if not t:
                continue
            label = jp_label(t)
            if not has_sec:
                n_nosec += 1
            vals = {}
            for col, k, kind, d in B_METRICS:
                i = ix(k)
                v = num(r[i]) if 0 <= i < len(r) else None
                if v is None:
                    continue
                if kind == 'speed' and mph[k]:
                    v *= MPH
                if kind == 'pct' and v <= 1.5:
                    v *= 100
                vals[col] = rnd(v, d)
            if label in seen or (not has_sec and (label[:-3], kval(vals.get('K'))) in seen_min):
                n_dup += 1
                continue
            seen.add(label); seen_min.add((label[:-3], kval(vals.get('K'))))
            swings.append({'t': t, 'has_sec': has_sec, 'label': label, 'bat': g('bat nickname'), 'cond': cond(g('environment tag')),
                           'first': g('first_name'), 'last': g('last_name'), 'vals': vals, 'file': rel})
            n_file += 1
        notes.append(f'・Blast {rel}：Excelにない新しいスイング {n_file}本' + (f'（登録済み {n_dup}本はスキップ）' if n_dup else ''))
        if n_nosec:
            notes.append(f'  ※ {rel} は時刻に「秒」がありません（Excelで開いて保存すると消えます）。トラックマンと結びつけられないので、Blast Connectからダウンロードしたままのファイルを入れてください')
    for b in bad:
        notes.append('✕ ' + b)
    if not swings:
        return 0, 0
    swings.sort(key=lambda s: s['t'])
    # one-to-one matching swing -> pitch (same day, nearest within MATCH_SEC), closest pairs first
    cand = []
    for si, s in enumerate(swings):
        if not s['has_sec']:
            continue
        sec = s['t'].hour * 3600 + s['t'].minute * 60 + s['t'].second
        for pi, p in enumerate(by_day.get(s['t'].date(), [])):
            if p[3] in (None, ''):
                continue
            diff = abs(p[1] - sec)
            if diff <= MATCH_SEC:
                cand.append((diff, si, id(p), p))
    cand.sort(key=lambda x: x[0])
    used_s, used_p, match = set(), set(), {}
    for diff, si, pid, p in cand:
        if si in used_s or pid in used_p:
            continue
        used_s.add(si); used_p.add(pid); match[si] = p
    new_rows, nxt, matched, unknown = {}, last_d + 1, 0, set()
    skipped = gmatched = 0
    for si, s in enumerate(swings):
        p = match.get(si)
        gname = None if p else game.get(f"{s['t']:%Y-%m-%d %H:%M:%S}")
        if not p and not gname:  # the team keeps only swings that line up with a TrackMan pitch (or a game-record pitch)
            skipped += 1
            continue
        if gname:
            gmatched += 1
            rec = by_name.get(norm_name(gname))
            pname, hand = (rec['name'], rec['bat']) if rec else (gname, '')
            if not rec:
                unknown.add(gname)
            R = nxt
            cells = [c_str(f'A{R}', pname, st('A')), c_formula(f'B{R}', f'_xlfn.XLOOKUP(A{R},選手マスタ!K:K,選手マスタ!W:W,0)', b_style), c_str(f'D{R}', s['label'], st('D'))]
            if s['bat']:
                cells.append(c_str(f'E{R}', s['bat'], st('E')))
            if hand:
                cells.append(c_str(f'F{R}', hand, st('F')))
            if s['cond']:
                cells.append(c_str(f'G{R}', s['cond'], st('G')))
            for col in 'KLMNOPQRST':
                if col in s['vals']:
                    cells.append(c_num(f'{col}{R}', s['vals'][col], st(col)))
            new_rows[R] = f'<row r="{R}" spans="1:22">' + ''.join(cells) + '</row>'
            nxt += 1
            continue
        tid = None
        if p:
            tid = str(int(p[3]) if isinstance(p[3], float) else p[3])
            matched += 1
        rec = by_id.get(tid) if tid else None
        if not rec:  # no pitch, or TMID not in マスタ: try the Blast account name
            ja = s['last'] + s['first']
            rec = by_name.get(norm_name(ja)) or by_name.get(norm_name(s['first'] + s['last']))
            if not rec:
                rid = roman2id.get(roman_key(s['last'] + s['first'])) or roman2id.get(roman_key(s['first'] + s['last']))
                rec = by_id.get(rid) if rid else None
        if rec:
            pname, hand = rec['name'], rec['bat']
        else:
            pname = (p[4] if p and p[4] else ' '.join(x for x in (s['first'], s['last']) if x)) or ''
            hand = ''
            unknown.add(pname or s['file'])
        R = nxt
        cells = []
        if pname:
            cells.append(c_str(f'A{R}', pname, st('A')))
        cells.append(c_formula(f'B{R}', f'_xlfn.XLOOKUP(A{R},選手マスタ!K:K,選手マスタ!W:W,0)', b_style))
        if p and p[2] not in (None, ''):
            cells.append(c_num(f'C{R}', p[2], st('C')))
        cells.append(c_str(f'D{R}', s['label'], st('D')))
        if s['bat']:
            cells.append(c_str(f'E{R}', s['bat'], st('E')))
        if hand:
            cells.append(c_str(f'F{R}', hand, st('F')))
        if s['cond']:
            cells.append(c_str(f'G{R}', s['cond'], st('G')))
        for col in 'KLMNOPQRST':
            if col in s['vals']:
                cells.append(c_num(f'{col}{R}', s['vals'][col], st(col)))
        new_rows[R] = f'<row r="{R}" spans="1:22">' + ''.join(cells) + '</row>'
        nxt += 1
    if not new_rows:
        notes.append(f'・Blast：トラックマンの投球と時刻が一致した新しいスイングはありませんでした（合わない {skipped}スイングは入れていません）')
        return 0, 0
    last_row = max(nxt - 1, max((r for r, c, sp in rows), default=1))
    xml = put_rows(xml, new_rows, [(r, sp) for r, c, sp in rows])
    xml = re.sub(r'<dimension ref="A1:([A-Z]+)\d+"/>', lambda m: f'<dimension ref="A1:{m.group(1)}{last_row}"/>', xml, count=1)
    xml = re.sub(r'(<autoFilter ref="A1:[A-Z]+)\d+"', lambda m: f'{m.group(1)}{last_row}"', xml, count=1)
    book.set_sheet_xml(name, xml)
    wb = book.parts['xl/workbook.xml'].decode('utf-8')
    wb = re.sub(r'(<definedName name="_xlnm\._FilterDatabase" localSheetId="\d+" hidden="1">Blast!\$A\$1:\$[A-Z]+\$)\d+', lambda m: f'{m.group(1)}{last_row}', wb)
    if 'fullCalcOnLoad' not in wb:
        wb = re.sub(r'<calcPr ([^/]*)/>', r'<calcPr \1 fullCalcOnLoad="1"/>', wb, count=1)
    book.parts['xl/workbook.xml'] = wb.encode('utf-8')
    if unknown:
        notes.append('※ Blastで選手マスタの氏名が見つからなかった選手（A列に名前をそのまま入れています）：' + '、'.join(sorted(unknown)))
    notes.append(f'・Blast：トラックマンの投球と時刻が一致した {matched}スイング' + (f'・試合記録の投球と一致した {gmatched}スイング' if gmatched else '') + f'を追加（合わない {skipped}スイングは入れていません）')
    return matched + gmatched, matched

# ---------------------------------------------------------------- romaji (for PDF file names like Akiyama_Kanta_20260317.pdf)
_K1 = dict(zip('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポァィゥェォ',
  'a i u e o ka ki ku ke ko sa shi su se so ta chi tsu te to na ni nu ne no ha hi fu he ho ma mi mu me mo ya yu yo ra ri ru re ro wa o n ga gi gu ge go za ji zu ze zo da ji zu de do ba bi bu be bo pa pi pu pe po a i u e o'.split()))
_K2 = {'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho','チャ':'cha','チュ':'chu','チョ':'cho','ニャ':'nya','ニュ':'nyu','ニョ':'nyo',
  'ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo','リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo',
  'ジャ':'ja','ジュ':'ju','ジョ':'jo','ビャ':'bya','ビュ':'byu','ビョ':'byo','ピャ':'pya','ピュ':'pyu','ピョ':'pyo','ヂャ':'ja','ヂュ':'ju','ヂョ':'jo'}
def kana_roman(kana):
    import unicodedata
    s = unicodedata.normalize('NFKC', str(kana or ''))
    s = ''.join(chr(ord(c) + 0x60) if 'ぁ' <= c <= 'ゖ' else c for c in s)  # hiragana -> katakana
    out, i = '', 0
    while i < len(s):
        c = s[i]
        if s[i:i + 2] in _K2:
            out += _K2[s[i:i + 2]]; i += 2; continue
        if c == 'ッ':
            nx = s[i + 1:i + 3] if s[i + 1:i + 3] in _K2 else s[i + 1:i + 2]
            r = _K2.get(nx) or _K1.get(nx, '')
            out += ('t' if r.startswith('ch') else r[:1]); i += 1; continue
        if c == 'ー':
            i += 1; continue
        out += _K1.get(c, c if c.isascii() else ' ')
        i += 1
    return out
def roman_norm(s):
    """letters only; long vowels folded (Katoh / Kato / Katou, Ohno / Ono) so spellings of the same name match"""
    s = re.sub(r'[^a-z]', '', str(s or '').lower())
    for a, b in (('sy', 'sh'), ('si', 'shi'), ('ty', 'ch'), ('ti', 'chi'), ('tu', 'tsu'), ('zy', 'j'), ('jy', 'j'), ('zi', 'ji')):
        s = s.replace(a, b)
    s = re.sub(r'(?<![sc])hu', 'fu', s)
    s = re.sub(r'(?<=o)h(?![aeiou])', '', s)
    for a, b in (('ou', 'o'), ('oo', 'o'), ('uu', 'u'), ('ei', 'e'), ('ii', 'i')):
        s = s.replace(a, b)
    return s
def roman_names(book):
    """{roman_norm('Akiyama Kanta'): 選手マスタ 氏名} from 氏名 / ﾌﾘｶﾞﾅ (surname first; first-name-first is added too)"""
    xml = book.sheet_xml('選手マスタ')
    rows = read_rows(book, xml)
    hdr = {str(v).strip(): c for c, (v, s, f) in rows[0][1].items() if v is not None}
    kc, fc = hdr.get('氏名', 'K'), hdr.get('ﾌﾘｶﾞﾅ', hdr.get('フリガナ', 'L'))
    out = {}
    for r, cells, _ in rows[1:]:
        nm, fu = cells.get(kc, (None,))[0], cells.get(fc, (None,))[0]
        if not nm or not fu:
            continue
        parts = [kana_roman(x) for x in re.split(r'[\s　]+', str(fu).strip()) if x]
        if not parts:
            continue
        nm = re.sub(r'[\s　]+', '', str(nm))
        out.setdefault(roman_norm(''.join(parts)), nm)
        out.setdefault(roman_norm(''.join(reversed(parts))), nm)
    return out

def batter_names(book):
    """TrackMan batter (and pitcher) names in Trackmandata -> 選手マスタ 氏名, via their TrackMan ID = TMID."""
    by_id, _ = master_maps(book)
    xml = book.sheet_xml('Trackmandata')
    rows = read_rows(book, xml)
    hdr = {str(v).strip(): c for c, (v, s, f) in rows[0][1].items() if v is not None}
    out = {}
    for nc, ic in ((hdr.get('Batter'), hdr.get('BatterId')), (hdr.get('Pitcher'), hdr.get('PitcherId'))):
        if not nc or not ic:
            continue
        for r, cells, _ in rows[1:]:
            nm, tid = cells.get(nc, (None,))[0], cells.get(ic, (None,))[0]
            if not nm or tid in (None, ''):
                continue
            tid = str(int(tid)) if isinstance(tid, float) else str(tid)
            rec = by_id.get(tid)
            if rec:
                out.setdefault(roman_key(nm), rec['name'])
    return out

def backfill_c(book, pitches, dates, notes):
    """Existing Blast rows on the given days with an empty C (TRPitchNo.): put the PitchNo of the TrackMan pitch
    thrown within MATCH_SEC of the swing (pitches already referenced in C that day are not reused)."""
    name = 'Blast'
    xml = book.sheet_xml(name)
    rows = read_rows(book, xml)
    want = set(dates)
    by_day = {}
    for p in pitches:
        if p[3] not in (None, '') and p[0].isoformat() in want:
            by_day.setdefault(p[0], []).append(p)
    def row_dt(cells):
        m = re.match(r'(\d+)年\s*(\d+)月\s*(\d+)日.*?(\d+):(\d+):(\d+)', str(cells.get('D', (None,))[0] or ''))
        return dt.datetime(*map(int, m.groups())) if m else None
    used, todo = set(), []
    for r, cells, span in rows[1:]:
        t = row_dt(cells)
        if not t or t.date().isoformat() not in want:
            continue
        c = cells.get('C', (None,))[0]
        if c not in (None, ''):
            used.add((t.date(), c if not isinstance(c, float) else int(c)))
        else:
            todo.append((r, t, span))
    cand = []
    for r, t, span in todo:
        sec = t.hour * 3600 + t.minute * 60 + t.second
        for p in by_day.get(t.date(), []):
            d = abs(p[1] - sec)
            pno = int(p[2]) if isinstance(p[2], float) else p[2]
            if d <= MATCH_SEC and (t.date(), pno) not in used:
                cand.append((d, r, (t.date(), pno), span))
    cand.sort(key=lambda x: x[0])
    done_r, fill = set(), {}
    for d, r, key, span in cand:
        if r in done_r or key in used:
            continue
        done_r.add(r); used.add(key); fill[r] = key[1]
    if not fill:
        notes.append('・Blastの既存行：C列を埋められる行はありませんでした')
        return 0
    # rewrite only those rows' C cell (keep its style)
    pieces, pos = [], 0
    for r, cells, span in rows:
        if r not in fill:
            continue
        rx = xml[span[0]:span[1]]
        cm = re.search(r'<c r="C%d"([^>]*?)(?:/>|>.*?</c>)' % r, rx, re.S)
        style = None
        if cm:
            sm = re.search(r's="(\d+)"', cm.group(1)); style = sm.group(1) if sm else None
            rx = rx[:cm.start()] + c_num(f'C{r}', fill[r], style) + rx[cm.end():]
        else:
            bm = re.search(r'<c r="B%d"[^>]*?(?:/>|>.*?</c>)' % r, rx, re.S)
            at = bm.end() if bm else (rx.index('>') + 1)
            rx = rx[:at] + c_num(f'C{r}', fill[r], '5') + rx[at:]
        pieces.append(xml[pos:span[0]]); pieces.append(rx); pos = span[1]
    pieces.append(xml[pos:])
    book.set_sheet_xml(name, ''.join(pieces))
    notes.append(f'・Blastの既存行（{"・".join(sorted(want))}）：C列が空欄だった {len(fill)}行に TRPitchNo. を入れました（時刻が合わない {len(todo) - len(fill)}行は空欄のまま）')
    return len(fill)

# ---------------------------------------------------------------- 選手マスタ
MASTER_KEEP = 23  # A..W (No. … TMID): the player's profile, copied from his latest row
def master_sheet(book, dates, notes):
    """One 選手マスタ row per player per measurement day: for every TrackMan pitcher/batter on the given days
    (YYYY-MM-DD) whose TMID has no row with that 作成日 yet, add a row copied from his latest row
    (A..W only; measurements left blank) with No.=next, 作成日=the day, メモ=the place."""
    want = sorted(set(dates))
    if not want:
        return []
    name = '選手マスタ'
    xml = book.sheet_xml(name)
    rows = read_rows(book, xml)
    hdr = {str(v).strip(): c for c, (v, s, f) in rows[0][1].items() if v is not None}
    cNo, cDay, cMemo, cName, cAge, cBirth, cTm = (hdr.get(k, d) for k, d in
        (('No.', 'A'), ('作成日', 'B'), ('メモ', 'D'), ('氏名', 'K'), ('年齢', 'M'), ('生年月日', 'N'), ('TMID', 'W')))
    def tid_of(v):
        if v in (None, ''):
            return None
        try:
            return str(int(float(v)))
        except (TypeError, ValueError):
            return None
    def day_of(v):
        return (EPOCH + dt.timedelta(days=v)).date().isoformat() if isinstance(v, float) else None
    have, latest, last_filled, max_no, place_by_day, spell = set(), {}, 1, 0, {}, {}
    for r, cells, span in rows[1:]:
        tid, day = tid_of(cells.get(cTm, (None,))[0]), day_of(cells.get(cDay, (None,))[0])
        no = cells.get(cNo, (None,))[0]
        if isinstance(no, float):
            max_no = max(max_no, int(no))
        if cells.get(cName, (None,))[0]:
            last_filled = r
        if tid and day:
            have.add((day, tid))
            nm = cells.get(cName, (None,))[0]
            if nm:
                sp = spell.setdefault(tid, {}); sp[str(nm)] = sp.get(str(nm), 0) + 1
            if tid not in latest or day >= latest[tid][0]:
                latest[tid] = (day, r, span)
            memo = cells.get(cMemo, (None,))[0]
            if memo:
                place_by_day[(day, tid)] = str(memo)
    # who was measured on those days (in order of first pitch), and where: the place most often written
    # for the same TrackMan device and practice type
    tx = book.sheet_xml('Trackmandata')
    trows = read_rows(book, tx)
    th = {str(v).strip(): c for c, (v, s, f) in trows[0][1].items() if v is not None}
    def tv(cells, h):
        c = th.get(h)
        return cells.get(c, (None,))[0] if c else None
    votes, todo, seen = {}, [], set()
    for r, cells, _ in trows[1:]:
        day = day_of(tv(cells, 'Date'))
        if not day:
            continue
        kind = str(tv(cells, 'PracticeType') or ''); dev = tid_of(tv(cells, 'Device')) or ''
        for hid, hnm in (('PitcherId', 'Pitcher'), ('BatterId', 'Batter')):
            tid = tid_of(tv(cells, hid))
            if not tid:
                continue
            memo = place_by_day.get((day, tid))
            if memo:
                v = votes.setdefault((dev, kind), {}); v[memo] = v.get(memo, 0) + 1
                v = votes.setdefault(('', kind), {}); v[memo] = v.get(memo, 0) + 1
            if day in want and (day, tid) not in have and (day, tid) not in seen:
                seen.add((day, tid)); todo.append((day, tid, dev, kind, tv(cells, hnm)))
    def place(dev, kind, fallback):
        for k in ((dev, kind), ('', kind)):
            if votes.get(k):
                return max(votes[k].items(), key=lambda x: x[1])[0]
        return fallback
    existing = {r: (cells, span) for r, cells, span in rows}
    new_rows, added, unknown, nxt = {}, [], [], last_filled + 1
    for day, tid, dev, kind, tm_name in todo:
        if tid not in latest:
            unknown.append(str(tm_name or tid)); continue
        _, tr, tspan = latest[tid]
        txml = xml[tspan[0]:tspan[1]]
        while nxt in existing and existing[nxt][0].get(cName, (None,))[0]:
            nxt += 1
        r = nxt; nxt += 1; max_no += 1
        d = dt.date.fromisoformat(day)
        tcells = existing[tr][0]
        memo = place(dev, kind, str(tcells.get(cMemo, (None,))[0] or ''))
        cells = {}
        for cm in CELL_RE.finditer(re.sub(r'^<row[^>]*>', '', txml)):
            col = cm.group(1)
            if col_index(col) > MASTER_KEEP or col in (cAge,):
                continue
            cells[col] = re.sub(r'r="%s%d"' % (col, tr), f'r="{col}{r}"', cm.group(0), count=1)
        st = lambda col: (re.search(r's="(\d+)"', cells.get(col, '')) or [None, None])[1]
        cells[cNo] = c_num(f'{cNo}{r}', max_no, st(cNo))
        cells[cDay] = c_num(f'{cDay}{r}', excel_serial_date(d), st(cDay))
        if memo:
            cells[cMemo] = c_str(f'{cMemo}{r}', memo, st(cMemo))
        # 氏名: the spelling used most often for this TMID (e.g. full-width space), so lookups by name keep working
        nm = max(spell[tid].items(), key=lambda x: x[1])[0] if spell.get(tid) else None
        if nm and nm != str(tcells.get(cName, (None,))[0]):
            cells[cName] = c_str(f'{cName}{r}', nm, st(cName))
        # 年齢: keep the cell that is already there (it may hold a shared formula); else write the same formula
        if r in existing and re.search(r'<c r="%s%d"' % (cAge, r), xml[existing[r][1][0]:existing[r][1][1]]):
            cells[cAge] = re.search(r'<c r="%s%d"[^>]*?(?:/>|>.*?</c>)' % (cAge, r), xml[existing[r][1][0]:existing[r][1][1]], re.S).group(0)
        else:
            b = tcells.get(cBirth, (None,))[0]
            age = ''
            if isinstance(b, float):
                bd = (EPOCH + dt.timedelta(days=b)).date()
                age = f'<v>{d.year - bd.year - ((d.month, d.day) < (bd.month, bd.day))}</v>'
            sa = re.search(r'<c r="%s%d"([^>]*?)(?:/>|>)' % (cAge, tr), txml)
            sm = re.search(r's="(\d+)"', sa.group(1)) if sa else None
            cells[cAge] = f'<c r="{cAge}{r}"{" s=" + chr(34) + sm.group(1) + chr(34) if sm else ""}><f>DATEDIF({cBirth}{r},{cDay}{r},"Y")</f>{age}</c>'
        ra = re.match(r'<row r="\d+"([^>]*)>', txml)
        new_rows[r] = f'<row r="{r}"{ra.group(1) if ra else ""}>' + ''.join(cells[c] for c in sorted(cells, key=col_index)) + '</row>'
        have.add((day, tid))
        nm = nm or tcells.get(cName, (None,))[0]
        added.append(f'{day[5:].replace("-", "/")} {re.sub(r"[ 　]+", "", str(nm))}（{memo}）')
    if new_rows:
        xml = put_rows(xml, new_rows, [(r, sp) for r, c, sp in rows])
        book.set_sheet_xml(name, xml)
        notes.append('・選手マスタ：' + '、'.join(added) + ' の行を追加')
    if unknown:
        notes.append('・選手マスタに前の行がなく作れなかった選手（トラックマンの名前）：' + '、'.join(sorted(set(unknown))))
    return added

def list_csv(d):
    if not d or not os.path.isdir(d):
        return []
    return sorted(os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith('.csv') and not f.startswith(('~$', '.')))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', required=True); ap.add_argument('--out')
    ap.add_argument('--game-swings', help='JSON {"YYYY-MM-DD HH:MM:SS" (JST): player} of Blast swings the DB matched to game-record pitches')
    ap.add_argument('--roman-out', help='with --names-out: also write {romaji (folded): 選手マスタ 氏名} for PDF file names')
    ap.add_argument('--names-out', help='only write {TrackMan batter (letters, lower-case): 選手マスタ 氏名} as JSON and exit')
    ap.add_argument('--tm-dir'); ap.add_argument('--blast-dir'); ap.add_argument('--report')
    ap.add_argument('--backfill-dates', help='comma-separated YYYY-MM-DD: fill empty TRPitchNo. on existing Blast rows of these days')
    ap.add_argument('--master-dates', help='comma-separated YYYY-MM-DD: also add 選手マスタ rows for the TrackMan players of these days')
    a = ap.parse_args()
    book = Book(a.xlsx)
    if a.names_out:
        json.dump(batter_names(book), open(a.names_out, 'w', encoding='utf-8'), ensure_ascii=False)
        if a.roman_out:
            json.dump(roman_names(book), open(a.roman_out, 'w', encoding='utf-8'), ensure_ascii=False)
        return
    if not a.out:
        ap.error('--out is required')
    notes = []
    tm_added, pitches = tm_sheet(book, list_csv(a.tm_dir), notes)
    game = json.load(open(a.game_swings, encoding='utf-8')) if a.game_swings and os.path.exists(a.game_swings) else {}
    bl_added, matched = blast_sheet(book, list_csv(a.blast_dir), pitches, notes, game)
    filled = backfill_c(book, pitches, [d.strip() for d in a.backfill_dates.split(',') if d.strip()], notes) if a.backfill_dates else 0
    mdays = set(book.tm_new_dates) | {d.strip() for d in (a.master_dates or '').split(',') if d.strip()}
    master_added = master_sheet(book, mdays, notes)
    changed = bool(tm_added or bl_added or filled or master_added)
    if changed:
        book.save(a.out)
    parts = []
    if tm_added or bl_added:
        parts.append(f'トラックマン {tm_added}球・Blast {bl_added}スイングを追加しました')
    if filled:
        parts.append(f'既存のBlast {filled}行にTRPitchNo.を入れました')
    if master_added:
        parts.append(f'選手マスタに{len(master_added)}行を追加しました')
    rep = '測定DB（Excel）：' + ('、'.join(parts) if changed else '新しく追加する行はありませんでした') + '\n' + '\n'.join(notes) + '\n'
    if a.report:
        open(a.report, 'w', encoding='utf-8').write(rep)
    print(json.dumps({'changed': changed, 'tm_added': tm_added, 'blast_added': bl_added, 'blast_matched': matched, 'backfilled': filled, 'master_added': len(master_added)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
