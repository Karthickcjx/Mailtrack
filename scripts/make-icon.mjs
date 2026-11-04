// Generates extension/public/icon128.png (original artwork: a rounded square with two check marks). No external assets.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const S = 128, px = Buffer.alloc(S * S * 4);
const set = (x, y, [r, g, b], a = 255) => { const i = (y * S + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; };
const inRound = (x, y, r = 28) => { const cx = Math.min(Math.max(x, r), S - 1 - r), cy = Math.min(Math.max(y, r), S - 1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };
const distSeg = (x, y, [ax, ay], [bx, by]) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - ax - t * dx, y - ay - t * dy); };
const checks = [[[24, 66], [44, 86], [80, 46]], [[52, 86], [94, 44]]];
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (!inRound(x, y)) { set(x, y, [0, 0, 0], 0); continue; }
  let on = false;
  for (const c of checks) for (let i = 0; i < c.length - 1; i++) if (distSeg(x, y, c[i], c[i + 1]) <= 7) on = true;
  set(x, y, on ? [255, 255, 255] : [47, 91, 234]);
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(new URL('../extension/public/icon128.png', import.meta.url),
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote extension/public/icon128.png');
