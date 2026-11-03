// Minimal Buffer shim for the browser spike (only what spikes/p3-mime/mime.ts uses).
const enc = new TextEncoder();
const dec = new TextDecoder();
// Build the binary string in chunks: spreading every byte into one String.fromCharCode(...) call
// overflows the call stack on large messages (~>100 KB). 0x8000 args per call is well under engine limits.
const CHUNK = 0x8000;
const b64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
};
class MiniBuffer {
  constructor(bytes) { this.bytes = bytes; }
  static from(v, encoding) {
    if (encoding === 'base64') return new MiniBuffer(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
    return new MiniBuffer(enc.encode(v));
  }
  static byteLength(s) { return enc.encode(s).length; }
  toString(encoding) {
    if (encoding === 'base64') return b64(this.bytes);
    if (encoding === 'base64url') return b64(this.bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return dec.decode(this.bytes);
  }
}
export { MiniBuffer as Buffer };
