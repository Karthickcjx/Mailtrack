import { describe, expect, it } from 'vitest';
import { buildMime, encodeHeaderWord, formatAddress, insertPixelAtTop, toRaw } from './mime';

const base = {
  from: { email: 'a@example.test', name: 'Sender A' },
  to: { email: 'b@example.test' },
  subject: 'Résumé ✓ 測試',
  html: '<p>Hi <a href="https://example.com/x?y=1#z">link</a></p>',
  text: 'Hi link https://example.com/x?y=1#z',
  messageId: '<01JTEST@tracklet.invalid>',
  boundary: 'BOUNDARY',
};

describe('P3 MIME builder (offline)', () => {
  it('encodes non-ASCII subject as RFC 2047 and round-trips', () => {
    const enc = encodeHeaderWord(base.subject);
    expect(enc).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = enc.split(/\r\n /).map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(base.subject);
  });

  it('keeps ASCII subjects verbatim', () => expect(encodeHeaderWord('Hello')).toBe('Hello'));

  it('splits long non-ASCII subjects into encoded-words of <= 75 chars', () => {
    const enc = encodeHeaderWord('é'.repeat(200));
    for (const w of enc.split('\r\n ')) expect(w.length).toBeLessThanOrEqual(75);
  });

  it('builds a single-recipient multipart/alternative message with CRLF', () => {
    const m = buildMime(base);
    expect(m).toContain('To: <b@example.test>\r\n');
    expect(m).not.toMatch(/^Cc:|^Bcc:/m);
    expect(m).toContain('Content-Type: multipart/alternative; boundary="BOUNDARY"');
    expect(m.split('\r\n\r\n')[0]).not.toMatch(/[^\r]\n/);
    for (const line of m.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    expect(m.trimEnd().endsWith('--BOUNDARY--')).toBe(true);
  });

  it('adds threading headers for copies 2..N only', () => {
    expect(buildMime(base)).not.toContain('In-Reply-To');
    const m2 = buildMime({ ...base, messageId: '<02@tracklet.invalid>', inReplyTo: '<01JTEST@tracklet.invalid>' });
    expect(m2).toContain('In-Reply-To: <01JTEST@tracklet.invalid>');
    expect(m2).toContain('References: <01JTEST@tracklet.invalid>');
  });

  it('rejects header injection in subject and addresses', () => {
    expect(() => buildMime({ ...base, subject: 'x\r\nBcc: evil@example.test' })).toThrow();
    expect(() => formatAddress({ email: 'b@example.test>\r\nBcc: e@x' })).toThrow();
  });

  it('quotes ASCII display names and encodes non-ASCII names', () => {
    expect(formatAddress({ email: 'a@x.test', name: 'A "B"' })).toBe('"A \\"B\\"" <a@x.test>');
    expect(formatAddress({ email: 'a@x.test', name: 'Zoë' })).toMatch(/^=\?UTF-8\?B\?.+\?= <a@x\.test>$/);
  });

  it('produces base64url raw without padding characters that break the API', () => {
    expect(toRaw(buildMime(base))).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('inserts the pixel as the first body element', () => {
    expect(insertPixelAtTop('<html><body class="x"><p>a</p></body></html>', 'https://t/o/AB.gif'))
      .toMatch(/<body class="x"><img src="https:\/\/t\/o\/AB\.gif"/);
    expect(insertPixelAtTop('<p>a</p>', 'https://t/o/AB.gif')).toMatch(/^<img /);
  });
});
