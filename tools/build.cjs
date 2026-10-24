#!/usr/bin/env node
// Usage:
//   node build.cjs init   <password> <secret.json>        -> derive key, write secret (salt, iter, key, kid)
//   node build.cjs build  <input.html> <outdir> <secret.json>  -> write encrypted outdir/index.html
//   node build.cjs verify <outdir/index.html> <password>  -> decrypt like the browser does, print result
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { webcrypto } = require('crypto');
const core = require('./gate-core.js');

const ITER = 600000;
const [cmd, a, b, c] = process.argv.slice(2);

async function init(password, secretPath) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const saltB64 = core.gB64e(salt);
  const raw = await core.gDeriveRaw(password, saltB64, ITER);
  const kid = Buffer.from(webcrypto.getRandomValues(new Uint8Array(6))).toString('hex');
  fs.writeFileSync(secretPath, JSON.stringify({ salt: saltB64, iter: ITER, key: core.gB64e(raw), kid }, null, 2), { mode: 0o600 });
  console.log('secret written:', secretPath, 'kid', kid);
}

async function build(input, outdir, secretPath) {
  const s = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  const html = fs.readFileSync(input);
  const gz = zlib.gzipSync(html, { level: 9 });
  const key = await webcrypto.subtle.importKey('raw', core.gB64d(s.key), 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, gz));
  const tpl = fs.readFileSync(path.join(__dirname, 'gate-template.html'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(__dirname, 'gate-core.js'), 'utf8').replace(/^if \(typeof module.*$/m, '');
  const page = tpl
    .replace('__CORE__', () => coreSrc)
    .replace('__SALT__', s.salt)
    .replace('__IV__', core.gB64e(iv))
    .replace('__ITER__', String(s.iter))
    .replace('__KID__', s.kid)
    .replace('__DATA__', () => core.gB64e(ct));
  fs.mkdirSync(outdir, { recursive: true });
  fs.writeFileSync(path.join(outdir, 'index.html'), page);
  fs.writeFileSync(path.join(outdir, '.nojekyll'), '');
  fs.writeFileSync(path.join(outdir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  console.log(`built ${outdir}/index.html  input ${html.length} B  gzip ${gz.length} B  page ${Buffer.byteLength(page)} B`);
}

async function verify(pagePath, password) {
  const page = fs.readFileSync(pagePath, 'utf8');
  const m = page.match(/<script type="application\/octet-stream" id="payload" data-salt="([^"]+)" data-iv="([^"]+)" data-iter="(\d+)" data-kid="([^"]+)">([^<]+)<\/script>/);
  if (!m) throw new Error('payload not found');
  const [, salt, iv, iter, , data] = m;
  const raw = await core.gDeriveRaw(password, salt, +iter);
  const html = await core.gOpen(raw, iv, data);
  return html;
}

// Encrypted file backup: JSON {v,salt,iter,kid,iv,data} with gzip -> AES-256-GCM (same key as the page).
async function encryptFile(input, output, secretPath) {
  const s = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  const key = await webcrypto.subtle.importKey('raw', core.gB64d(s.key), 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zlib.gzipSync(fs.readFileSync(input), { level: 9 })));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ v: 1, salt: s.salt, iter: s.iter, kid: s.kid, iv: core.gB64e(iv), data: Buffer.from(ct).toString('base64') }));
  console.log('encrypted', input, '->', output);
}
async function decryptFile(input, output, passwordOrSecret) {
  const o = JSON.parse(fs.readFileSync(input, 'utf8'));
  // Accept either the password or a secret.json path (key already derived).
  let raw;
  if (fs.existsSync(passwordOrSecret) && /\.json$/i.test(passwordOrSecret)) raw = core.gB64d(JSON.parse(fs.readFileSync(passwordOrSecret, 'utf8')).key);
  else raw = await core.gDeriveRaw(passwordOrSecret, o.salt, o.iter);
  const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const gz = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: core.gB64d(o.iv) }, key, Buffer.from(o.data, 'base64'));
  fs.writeFileSync(output, zlib.gunzipSync(Buffer.from(gz)));
  console.log('decrypted', input, '->', output);
}

(async () => {
  if (cmd === 'init') await init(a, b);
  else if (cmd === 'build') await build(a, b, c);
  else if (cmd === 'encrypt-file') await encryptFile(a, b, c);
  else if (cmd === 'decrypt-file') await decryptFile(a, b, c);
  else if (cmd === 'verify') {
    const html = await verify(a, b);
    console.log('OK decrypted', Buffer.byteLength(html), 'bytes; title:', (html.match(/<title>([^<]*)<\/title>/) || [])[1]);
    if (c) fs.writeFileSync(c, html);
  } else { console.error('unknown command'); process.exit(2); }
})().catch(e => { console.error('FAILED:', e.message || e); process.exit(1); });
