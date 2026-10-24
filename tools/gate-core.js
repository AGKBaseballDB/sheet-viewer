// Shared by the browser gate page (inlined) and the Node verifier.
// PBKDF2-SHA256 -> AES-256-GCM, payload is gzip-compressed HTML.
function gNorm(pw) {
  return String(pw || '').normalize('NFKC').toLowerCase().replace(/[\s\-‐‑–—ー－]/g, '');
}
function gB64d(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function gB64e(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function gDeriveRaw(pw, saltB64, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(gNorm(pw)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: gB64d(saltB64), iterations: iter }, base, 256);
  return new Uint8Array(bits);
}
async function gOpen(rawKey, ivB64, dataB64) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: gB64d(ivB64) }, key, gB64d(dataB64));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
if (typeof module !== 'undefined') module.exports = { gNorm, gB64d, gB64e, gDeriveRaw, gOpen };
