import { describe, expect, it } from 'vitest';
import { buildReport, coverage, gmailView, isOwnError, MANUAL_CHECKS, REQUIRED_CHECKS, type Result, type ViewRowStats } from './report';

const at = '2026-11-03T00:00:00.000Z';
const r = (id: string, status: Result['status'], detail: unknown = {}): Result => ({ id, status, detail, at });
const read = (o: Partial<{ kind: string; to: string[]; cc: string[]; bcc: string[]; subject: string; htmlLength: number; htmlHasSignatureDiv: boolean; hasAttachments: boolean }>) =>
  r('P2.6 read-fields', 'RECORDED', { kind: 'new', to: [], cc: [], bcc: [], subject: 'x', htmlLength: 0, htmlHasSignatureDiv: false, hasAttachments: false, ...o });
const view = (v: string, rows: number, withId = rows, totalMarks = withId): ViewRowStats => ({ view: v, rows, withId, totalMarks, at });

const FULL: Result[] = [
  r('P2.9 load', 'PASS'),
  r('P2.5 compose-detected', 'PASS', { kind: 'new' }), r('P2.5 button-injected', 'PASS'),
  r('P2.5 compose-detected', 'PASS', { kind: 'reply' }), r('P2.5 compose-detected', 'PASS', { kind: 'forward' }),
  read({ to: ['a***@x'], cc: ['c***@x'], bcc: ['d***@x'], subject: 'P2 Résumé ✓ 測試', htmlLength: 120, htmlHasSignatureDiv: true, hasAttachments: true }),
  r('P2.7 close', 'RECORDED'),
  r('P2.11 view_thread', 'RECORDED', { threadId: 'a' }), r('P2.11 view_thread', 'RECORDED', { threadId: 'b' }), r('P2.11 view_thread', 'RECORDED', { threadId: 'c' }),
  r('P2.3 unexpected-hosts-60s', 'PASS'), r('P2.10 trusted-types-60s', 'PASS'),
];
const FULL_VIEWS = [view('sent', 20), view('inbox', 25), view('search', 5)];

describe('P2 report coverage', () => {
  it('lists every required check exactly once', () => {
    const ids = REQUIRED_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['P2.5-new', 'P2.5-reply', 'P2.5-forward', 'P2.6-to-cc-bcc', 'P2.6-unicode-subject',
      'P2.6-body', 'P2.6-signature', 'P2.6-attachment', 'P2.7-close', 'P2.8-sent', 'P2.8-inbox', 'P2.8-search', 'P2.11-view-thread',
      'P2.3-hosts', 'P2.10-tt', 'P2.12-no-errors', 'P2.9-load']));
  });

  it('reports everything MISSING for an empty run (never claims PASS without evidence)', () => {
    const c = coverage([], []);
    expect(c.missing).toHaveLength(REQUIRED_CHECKS.length);
    expect(c.manual.map((m) => m.check)).toEqual(MANUAL_CHECKS);
  });

  it('reports nothing missing when every check has evidence', () => {
    expect(coverage(FULL, FULL_VIEWS).missing).toEqual([]);
  });

  it('requires To, Cc and Bcc in the SAME read, and needs non-ASCII for the Unicode check', () => {
    const c = coverage([read({ to: ['a'] }), read({ cc: ['b'] }), read({ bcc: ['c'] })], []);
    expect(c.missing).toContain('P2.6-to-cc-bcc');
    expect(coverage([read({ subject: 'plain ascii' })], []).missing).toContain('P2.6-unicode-subject');
  });

  it('row checks require rows > 0, every row with an ID, and a mark per ID', () => {
    expect(coverage([], [view('sent', 0)]).missing).toContain('P2.8-sent');
    expect(coverage([], [view('sent', 10, 9)]).missing).toContain('P2.8-sent');
    expect(coverage([], [view('sent', 10, 10, 9)]).missing).toContain('P2.8-sent');
    expect(coverage([], [view('sent', 10)]).missing).not.toContain('P2.8-sent');
  });

  it('thread-view needs 3 DISTINCT thread IDs', () => {
    const same = [1, 2, 3].map(() => r('P2.11 view_thread', 'RECORDED', { threadId: 'x' }));
    expect(coverage(same, []).missing).toContain('P2.11-view-thread');
  });

  it('an uncaught harness error makes P2.12 missing', () => {
    expect(coverage([...FULL, r('P2.12 uncaught-error', 'FAIL', { message: 'boom' })], FULL_VIEWS).missing).toEqual(['P2.12-no-errors']);
  });

  it('a FAIL result does not satisfy a PASS-gated check', () => {
    const c = coverage([r('P2.9 load', 'FAIL'), r('P2.10 trusted-types-60s', 'FAIL')], []);
    expect(c.missing).toEqual(expect.arrayContaining(['P2.9-load', 'P2.10-tt']));
  });
});

describe('gmailView', () => {
  it.each([
    ['', 'inbox'], ['#inbox', 'inbox'], ['#inbox/FMfcgz123', 'inbox-thread'], ['#sent', 'sent'], ['#sent/FMfcg', 'sent-thread'],
    ['#search/secret+terms', 'search'], ['#search/secret+terms/FMfcg', 'search-thread'], ['#label/Work', 'label'],
    ['#settings/general', 'other'], ['#drafts', 'drafts'],
  ])('%s -> %s', (hash, expected) => expect(gmailView(hash)).toBe(expected));

  it('never leaks search terms or thread IDs into the view name', () => {
    expect(gmailView('#search/john%40example.com')).not.toMatch(/john/);
  });
});

describe('buildReport', () => {
  const json = buildReport({ variant: 'native', buildId: 'native-abc123', adapterName: 'native-dom', userAgent: 'UA Chrome/156',
    startedAt: at, results: [read({ to: ['alice@example.com'] })], viewStats: [], ttViolations: [], unexpectedHosts: {} });
  const parsed = JSON.parse(json);

  it('identifies schema, variant, build and adapter', () => {
    expect(parsed).toMatchObject({ schema: 'tracklet-p2-report/2', variant: 'native', buildId: 'native-abc123', adapter: 'native-dom' });
    expect(parsed.coverage.automated.length).toBe(REQUIRED_CHECKS.length);
  });

  it('redacts email local parts', () => {
    expect(json).not.toContain('alice@');
    expect(json).toContain('a***@example.com');
  });
});

describe('isOwnError (P2.12 filter)', () => {
  it('matches the harness bundle by URL path or stack frame', () => {
    expect(isOwnError('chrome-extension://abc/page.js', undefined, undefined)).toBe(true);
    expect(isOwnError(undefined, 'Error: x\n    at f (chrome-extension://abc/page.js:10:5)', undefined)).toBe(true);
    expect(isOwnError('http://127.0.0.1/sut.js', undefined, 'sut.js')).toBe(true);
  });
  it('ignores Gmail errors and look-alike names', () => {
    expect(isOwnError('https://mail.google.com/_/scs/mail-static/_/js/k=gmail.main.en.abc/m=b', 'at x (https://www.gstatic.com/x.js:1:1)', undefined)).toBe(false);
    expect(isOwnError('https://example.com/homepage.js', undefined, undefined)).toBe(false);
  });
});
