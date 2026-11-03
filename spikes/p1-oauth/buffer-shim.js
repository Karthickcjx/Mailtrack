// Minimal Buffer shim for the browser spike (only what spikes/p3-mime/mime.ts uses).
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
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
