// Loads the sheet app's own data logic (decode/encode, CSV/InBody/TrackMan parsing,
// duplicate checks) out of the app template HTML, so imports behave exactly like the
// app's admin screen. The app template itself is NOT stored in this repository.
'use strict';
const vm = require('vm');
const path = require('path');
const fs = require('fs');

const VENDOR = path.join(__dirname, '..', 'vendor');

function splitTemplate(html) {
  const css = /<style id="app-css">([\s\S]*?)<\/style>/.exec(html);
  const js = /<script id="app-js">([\s\S]*?)<\/script>/.exec(html);
  const seed = /<script type="application\/json" id="seed">([\s\S]*?)<\/script>/.exec(html);
  if (!css || !js) throw new Error('app template: app-css / app-js not found');
  return { css: css[1], js: js[1], seed: seed ? seed[1] : null };
}

// Pull a whole `function name(...){...}` (or async) out of source by brace matching.
function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found in app: ' + name);
  let i = src.indexOf('{', m.index), depth = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced function: ' + name);
}

function loadCore(appJs) {
  const startTok = "'use strict';";
  const s = appJs.indexOf(startTok);
  const e = appJs.indexOf('// ---------- view state');
  if (s < 0 || e < 0) throw new Error('app-js layout changed (markers not found)');
  const body = appJs.slice(s + startTok.length, e);
  const extra = ['decodeBytes', 'hashRows'].map(n => extractFunction(appJs, n)).join('\n');
  const exportsList = ['COLS', 'REQUIRED', 'SKEL', 'HEAD', 'TM_KEEP', 'nfkc', 'decode', 'encode', 'gzipText', 'gunzipText',
    'hashRows', 'fileBases', 'parseBodyTable', 'bodyDateGuess', 'parseTrackman', 'normTmDate', 'decodeBytes', 'BODY_MM', 'dateKey', 'nameKey', 'normName'];
  const src = '(function(){"use strict";\n' + body + '\n' + extra + '\nreturn {' + exportsList.join(',') + '};\n})()';

  const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const win = {};
  const ctx = {
    console, atob, btoa, TextDecoder, TextEncoder, Blob, Response, CompressionStream, DecompressionStream, URL,
    setTimeout, clearTimeout, Intl, Date, Math, JSON, Map, Set, Promise, Uint8Array, ArrayBuffer,
    sessionStorage: store(), localStorage: store(),
    location: { hash: '', pathname: '/', href: 'https://local/' },
    navigator: { userAgent: 'node' },
    document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} }, fonts: { load: async () => [] } },
  };
  ctx.window = win; ctx.self = win; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Libraries the app loads on demand (window[name] is checked before any network load).
  for (const [file, name] of [['papaparse.min.js', 'Papa'], ['xlsx.full.min.js', 'XLSX'], ['jszip.min.js', 'JSZip']]) {
    const lib = require(path.join(VENDOR, file));
    win[name] = lib; ctx[name] = lib;
  }
  const core = vm.runInContext(src, ctx, { filename: 'app-core.js' });
  core.Papa = win.Papa; core.XLSX = win.XLSX; core.JSZip = win.JSZip;
  return core;
}

module.exports = { splitTemplate, loadCore, extractFunction };
