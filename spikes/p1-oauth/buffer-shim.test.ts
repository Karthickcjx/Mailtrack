// The browser spike runs mime.ts on this shim instead of Node's Buffer. It must be byte-identical.
import { describe, expect, it } from 'vitest';
// @ts-ignore -- plain ESM shim
import { Buffer as Shim } from './buffer-shim.js';
import { buildMime, insertPixelAtTop, toRaw } from '../p3-mime/mime';

const cases: Record<string, string> = {
  empty: '',
  ascii: 'Hello',
  unicode: 'Résumé ✓ 測試 \u{1F600}',
  // regression: 250 KB overflowed the call stack with String.fromCharCode(...bytes)
  large: 'x'.repeat(50_000) + 'é'.repeat(100_000),
  exactChunkBoundary: 'a'.repeat(0x8000 * 3),
};

describe('P1/P3 browser Buffer shim parity with Node Buffer', () => {
  for (const [name, s] of Object.entries(cases)) {
    it(`${name}: base64, base64url, byteLength and decode match`, () => {
      expect(Shim.from(s).toString('base64')).toBe(Buffer.from(s).toString('base64'));
      expect(Shim.from(s).toString('base64url')).toBe(Buffer.from(s).toString('base64url'));
      expect(Shim.byteLength(s)).toBe(Buffer.byteLength(s));
      expect(Shim.from(Buffer.from(s).toString('base64'), 'base64').toString()).toBe(s);
    });
  }

  it('a large full MIME message encodes identically (as the live P3 send would)', () => {
    const html = insertPixelAtTop(`<p>${'Tracklet P2 synthetic body. '.repeat(10_000)}</p>`, 'https://example.com/p.gif');
    const mime = buildMime({ from: { email: 'a@example.test' }, to: { email: 'b@example.test' }, subject: 'Résumé ✓',
      html, text: 'x', messageId: '<1@tracklet.invalid>', boundary: 'B' });
    expect(mime.length).toBeGreaterThan(300_000);
    expect(Shim.from(mime).toString('base64url')).toBe(toRaw(mime));
  });
});
