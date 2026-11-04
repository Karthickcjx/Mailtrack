import { describe, expect, it } from 'vitest';
import { extractLinks, htmlToText, insertPixelAtTop, isTrackingToken, isUlid, randomToken, rewriteLinks, ulid, validateTargetUrl } from './index';

describe('randomToken / isTrackingToken', () => {
  it('produces 22-char base64url tokens that are unique', () => {
    const set = new Set(Array.from({ length: 2000 }, () => randomToken()));
    expect(set.size).toBe(2000);
    for (const t of set) expect(isTrackingToken(t)).toBe(true);
  });
  it.each(['', 'short', 'a'.repeat(23), "x' OR 1=1 --xxxxxxxxxx", '../../etc/passwdxxxxxx', 'abc/def+ghi=jklmnopqrs', null, 42])('rejects %j', (v) => {
    expect(isTrackingToken(v)).toBe(false);
  });
});

describe('ulid', () => {
  it('is 26 Crockford chars, sortable by time and monotonic within one ms', () => {
    const a = ulid(1000), b = ulid(1000), c = ulid(2000);
    for (const x of [a, b, c]) expect(isUlid(x)).toBe(true);
    expect(a < b && b < c).toBe(true);
  });
});

describe('validateTargetUrl', () => {
  it.each([
    ['https://example.com/x?y=1#z', 'https://example.com/x?y=1#z'],
    ['http://example.com', 'http://example.com/'],
    ['  https://EXAMPLE.com/Path ', 'https://example.com/Path'],
  ])('accepts %s', (raw, out) => expect(validateTargetUrl(raw)).toEqual({ ok: true, url: out }));
  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd',
    'mailto:a@b.c', 'tel:123', '#anchor', '/relative', 'https://user:pw@example.com/', 'https://exa mple.com',
    'https://example.com/\u0000x', 'java\tscript:alert(1)', 'https://' + 'a'.repeat(2050) + '.com', '', 'not a url',
  ])('rejects %j', (raw) => expect(validateTargetUrl(raw).ok).toBe(false));
});

describe('extractLinks / rewriteLinks', () => {
  const html = '<p><a href="https://a.test/1?x=1&amp;y=2">one</a> <a href=\'https://b.test/2\'>two</a> <a href="mailto:x@y.z">mail</a> <a href="javascript:alert(1)">bad</a> <a name="n">no href</a> <a href=https://c.test/3>three</a></p>';

  it('finds only http(s) links, decoding entities, in order', () => {
    expect(extractLinks(html)).toEqual([
      { index: 0, url: 'https://a.test/1?x=1&y=2' },
      { index: 1, url: 'https://b.test/2' },
      { index: 2, url: 'https://c.test/3' },
    ]);
  });

  it('rewrites the same links in the same order and leaves everything else byte-identical', () => {
    const out = rewriteLinks(html, (i) => `https://t.test/c/TOKEN${i}?a=1&b=2`);
    expect(out).toContain('<a href="https://t.test/c/TOKEN0?a=1&amp;b=2">one</a>');
    expect(out).toContain('<a href="https://t.test/c/TOKEN1?a=1&amp;b=2">two</a>');
    expect(out).toContain('<a href="https://t.test/c/TOKEN2?a=1&amp;b=2">three</a>');
    expect(out).toContain('<a href="mailto:x@y.z">mail</a>');
    expect(out).toContain('<a href="javascript:alert(1)">bad</a>');
    expect(out).toContain('<a name="n">no href</a>');
  });

  it('null replacement leaves a link untouched', () => {
    expect(rewriteLinks('<a href="https://a.test/">x</a>', () => null)).toBe('<a href="https://a.test/">x</a>');
  });

  it('cannot be tricked into breaking out of the attribute', () => {
    const out = rewriteLinks('<a href="https://a.test/">x</a>', () => 'https://t.test/c/"><script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('insertPixelAtTop / htmlToText', () => {
  it('inserts the pixel first, after <body> when present, and escapes the URL', () => {
    expect(insertPixelAtTop('<html><body class="x"><p>a</p></body></html>', 'https://t.test/o/A.gif')).toMatch(/<body class="x"><img src="https:\/\/t\.test\/o\/A\.gif"/);
    expect(insertPixelAtTop('<p>a</p>', 'https://t.test/o/"x.gif')).toMatch(/^<img src="https:\/\/t\.test\/o\/&quot;x\.gif"/);
  });
  it('produces readable text with links spelled out', () => {
    expect(htmlToText('<div>Hello<br>see <a href="https://a.test/">the docs</a></div><p>Bye &amp; thanks</p>')).toBe('Hello\nsee the docs (https://a.test/)\nBye & thanks');
  });
});

import { trackingUrlProblem } from './url';
describe('trackingUrlProblem (can mail clients reach this tracking URL?)', () => {
  it.each([
    'http://127.0.0.1:8787/o/x.gif', 'https://127.0.0.1/o/x.gif', 'https://localhost/o/x.gif', 'https://a.localhost/o/x.gif', 'http://t.example.com/o/x.gif',
    'https://10.0.0.5/o', 'https://172.16.3.1/o', 'https://192.168.1.2/o', 'https://169.254.1.1/o', 'https://100.64.0.1/o', 'https://0.0.0.0/o',
    'https://[::1]/o', 'https://[fd00::1]/o', 'https://[fe80::1]/o', 'https://tracker/o', 'https://pc.local/o', 'https://svc.internal/o', 'not a url',
  ])('rejects %s', (u) => expect(trackingUrlProblem(u)).not.toBeNull());
  it.each(['https://t.example.workers.dev/o/x.gif', 'https://track.example.com/c/abc', 'https://8.8.8.8/o', 'https://[2001:4860::8888]/o', 'https://t.example.test/o/x.gif'])(
    'accepts %s', (u) => expect(trackingUrlProblem(u)).toBeNull());
  it('explains loopback http precisely', () => expect(trackingUrlProblem('http://127.0.0.1:8787/o/x.gif')).toBe('uses http, not https'));
});
