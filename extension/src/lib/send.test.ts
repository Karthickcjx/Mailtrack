// Mocked Gmail API tests for the production sender. No network: Gmail is a scripted fake `fetch`. No real email is sent.
import { describe, expect, it, vi } from 'vitest';
import { BatchSender, dryRun, GMAIL_SEND_URL, MAX_429_RETRIES, MAX_BACKOFF_MS, validateRecipients, type BatchInput, type SendDeps } from './send';

const TOKEN_A = 'ya29.FAKE-TOKEN-A';   // short on purpose: real-token pattern (20+ chars) stays scanner-detectable
const TOKEN_B = 'ya29.FAKE-TOKEN-B';

type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error | (() => Promise<never>);
const ok = (n: number) => ({ status: 200, body: JSON.stringify({ id: `msg-${n}`, threadId: 'thread-1', labelIds: ['SENT'] }) });

function harness(replies: Reply[], tokens: string[] = [TOKEN_A, TOKEN_B]) {
  const calls: { url: string; auth: string; body: { raw: string; threadId?: string } }[] = [];
  const sleeps: number[] = [];
  let ids = 0;
  const tokenQueue = [...tokens];
  const deps: SendDeps = {
    fetch: vi.fn(async (url, init) => {
      calls.push({ url, auth: init.headers.authorization!, body: JSON.parse(init.body) });
      const r = replies.shift();
      if (!r) throw new Error('unexpected extra request');
      if (typeof r === 'function') return r();
      if (r instanceof Error) throw r;
      const h = r.headers ?? {};
      return { status: r.status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => r.body ?? '' };
    }),
    getToken: vi.fn(async () => tokenQueue.shift() ?? TOKEN_B),
    invalidateToken: vi.fn(async () => {}),
    sleep: vi.fn(async (ms: number) => { sleeps.push(ms); }),
    newMessageId: () => `<id-${++ids}@tracklet.invalid>`,
  };
  return { deps, calls, sleeps, sender: new BatchSender(deps) };
}

const input = (recipients: string[], extra: Partial<BatchInput> = {}): BatchInput => ({
  from: { email: 'me@example.test' }, recipients, subject: 'P3 Résumé ✓ 測試',
  html: (i) => `<p>copy ${i + 1}</p>`, text: (i) => `copy ${i + 1}`, pixelUrl: 'https://example.com/p.gif', spacingMs: 1000, ...extra,
});
const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
const leaksToken = (v: unknown) => /ya29\.|FAKE-TOKEN/.test(JSON.stringify(v));

describe('recipient validation (before any request)', () => {
  it.each([
    [[], 'no recipients'],
    [Array.from({ length: 21 }, (_, i) => `r${i}@x.test`), 'too many'],
    [['not-an-email'], 'invalid'],
    [['a@x'], 'invalid'],
    [['a@x.test\r\nBcc: evil@x.test'], 'invalid'],
    [['A@X.test', 'a@x.test'], 'duplicate'],
  ])('%j → rejected (%s), no fetch', async (recipients, msg) => {
    expect(validateRecipients(recipients).ok).toBe(false);
    const h = harness([]);
    const r = await h.sender.send(input(recipients as string[]));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(new RegExp(msg));
    expect(h.deps.fetch).not.toHaveBeenCalled();
    expect(h.deps.getToken).not.toHaveBeenCalled();
  });

  it('accepts valid distinct addresses (trimmed)', () => {
    expect(validateRecipients([' a@x.test ', 'b+cc@x.test', 'c.d@sub.x.test'])).toEqual({ ok: true, recipients: ['a@x.test', 'b+cc@x.test', 'c.d@sub.x.test'] });
  });
});

describe('happy path: 3 per-recipient copies', () => {
  it('sends 3 requests with correct URL, auth, single To each, threading and spacing', async () => {
    const h = harness([ok(1), ok(2), ok(3)]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test', 'c@x.test']));
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'sent', 'sent']);
    expect(h.calls).toHaveLength(3);
    for (const c of h.calls) { expect(c.url).toBe(GMAIL_SEND_URL); expect(c.auth).toBe(`Bearer ${TOKEN_A}`); }
    const mimes = h.calls.map((c) => decode(c.body.raw));
    expect(mimes[0]).toMatch(/\r\nTo: <a@x\.test>\r\n/);
    expect(mimes[1]).toMatch(/\r\nTo: <b@x\.test>\r\n/);
    expect(mimes[2]).toMatch(/\r\nTo: <c@x\.test>\r\n/);
    for (const m of mimes) expect(m).not.toMatch(/^(Cc|Bcc):/m);
    // threading: copy 1 has no threadId / In-Reply-To; copies 2..N reference copy 1
    expect(h.calls[0]!.body.threadId).toBeUndefined();
    expect(mimes[0]).not.toMatch(/In-Reply-To/);
    expect(h.calls[1]!.body.threadId).toBe('thread-1');
    expect(h.calls[2]!.body.threadId).toBe('thread-1');
    expect(mimes[1]).toMatch(/In-Reply-To: <id-1@tracklet\.invalid>/);
    expect(mimes[2]).toMatch(/References: <id-1@tracklet\.invalid>/);
    expect(r.firstMessageId).toBe('<id-1@tracklet.invalid>');
    // pixel inserted at top of HTML part; spacing between copies only
    expect(mimes[0]).toContain(Buffer.from('<img src="https://example.com/p.gif"').toString('base64').slice(0, 20));
    expect(h.sleeps).toEqual([1000, 1000]);
    expect(leaksToken(r)).toBe(false);
  });
});

describe('stop safely on first failure (partial failures)', () => {
  it('copy 2 → 400: copy 2 failed, copy 3 skipped, no third request', async () => {
    const h = harness([ok(1), { status: 400, body: JSON.stringify({ error: { message: 'Invalid To header' } }) }]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test', 'c@x.test']));
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'failed', 'skipped']);
    expect(r.results[1]!.error).toContain('Invalid To header');
    expect(h.calls).toHaveLength(2);
  });

  it('5xx is "uncertain": not retried, batch stops', async () => {
    const h = harness([{ status: 503, body: 'Service Unavailable' }]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['uncertain', 'skipped']);
    expect(r.results[0]!.attempts).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('network error is "uncertain": not retried, batch stops', async () => {
    const h = harness([ok(1), new Error('Failed to fetch')]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test', 'c@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'uncertain', 'skipped']);
    expect(r.results[1]!.attempts).toBe(1);
    expect(h.calls).toHaveLength(2);
  });

  it('non-JSON error body (HTML 502) keeps the results log and records a snippet', async () => {
    const h = harness([ok(1), { status: 502, body: '<html><body>Bad Gateway</body></html>' }]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results[0]).toMatchObject({ status: 'sent', id: 'msg-1' });
    expect(r.results[1]).toMatchObject({ status: 'uncertain', http: 502 });
    expect(r.results[1]!.error).toContain('Bad Gateway');
  });

  it('2xx with non-JSON / missing id is "uncertain" (never assumed sent, never retried)', async () => {
    const h = harness([{ status: 200, body: 'OK' }]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['uncertain', 'skipped']);
    expect(h.calls).toHaveLength(1);
  });

  it('a failing response body read does not throw away the results log', async () => {
    const h = harness([ok(1), { status: 400 }]);
    (h.deps.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'msg-1', threadId: 't' }) }))
      .mockImplementationOnce(async () => ({ status: 500, headers: { get: () => null }, text: async () => { throw new Error('stream reset'); } }));
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'uncertain']);
  });
});

describe('401: at most one silent token refresh per batch', () => {
  it('401 then success: invalidates old token, retries the same copy once with the new token', async () => {
    const h = harness([{ status: 401, body: '{"error":{"message":"Invalid Credentials"}}' }, ok(1), ok(2)]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.ok).toBe(true);
    expect(h.deps.invalidateToken).toHaveBeenCalledTimes(1);
    expect(h.deps.invalidateToken).toHaveBeenCalledWith(TOKEN_A);
    expect(h.deps.getToken).toHaveBeenCalledTimes(2);
    expect((h.deps.getToken as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[0] === false)).toBe(true); // never interactive
    expect(h.calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`, `Bearer ${TOKEN_B}`]);
    expect(r.results[0]!.attempts).toBe(2);
    expect(leaksToken(r)).toBe(false);
  });

  it('401 twice: only one refresh, copy failed, batch stops', async () => {
    const h = harness([{ status: 401 }, { status: 401 }]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['failed', 'skipped']);
    expect(r.results[0]!.error).toMatch(/after token refresh/);
    expect(h.deps.invalidateToken).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2);
  });

  it('refresh budget is per batch: a later 401 on copy 2 is not refreshed again', async () => {
    const h = harness([{ status: 401 }, ok(1), { status: 401 }]);
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'failed']);
    expect(h.deps.invalidateToken).toHaveBeenCalledTimes(1);
  });
});

describe('429: bounded backoff', () => {
  it('honours Retry-After (capped) and then succeeds', async () => {
    const h = harness([{ status: 429, headers: { 'retry-after': '2' } }, { status: 429, headers: { 'retry-after': '3600' } }, ok(1)]);
    const r = await h.sender.send(input(['a@x.test']));
    expect(r.ok).toBe(true);
    expect(h.sleeps).toEqual([2000, MAX_BACKOFF_MS]);
    expect(r.results[0]!.attempts).toBe(3);
  });

  it('gives up after MAX_429_RETRIES with exponential default backoff; never exceeds cap', async () => {
    const h = harness(Array.from({ length: MAX_429_RETRIES + 1 }, () => ({ status: 429 })));
    const r = await h.sender.send(input(['a@x.test', 'b@x.test']));
    expect(r.results.map((x) => x.status)).toEqual(['failed', 'skipped']);
    expect(r.results[0]!.error).toMatch(/after max backoff retries/);
    expect(h.sleeps).toEqual([1000, 2000, 4000]);
    expect(h.calls).toHaveLength(MAX_429_RETRIES + 1);
    expect(Math.max(...h.sleeps)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

describe('duplicate / concurrent send prevention', () => {
  it('a second send while one is in flight is rejected without any request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const h = harness([ok(1)]);
    (h.deps.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { await gate; return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'msg-1', threadId: 't' }) }; });
    const first = h.sender.send(input(['a@x.test']));
    await Promise.resolve();
    expect(h.sender.busy).toBe(true);
    const second = await h.sender.send(input(['a@x.test']));
    expect(second).toMatchObject({ ok: false, reason: expect.stringMatching(/busy/) });
    release();
    expect((await first).ok).toBe(true);
    expect(h.deps.fetch).toHaveBeenCalledTimes(1);
    expect(h.sender.busy).toBe(false);
  });

  it('the lock is released after a failure, so a new batch can be started deliberately', async () => {
    const h = harness([{ status: 400 }, ok(1)]);
    expect((await h.sender.send(input(['a@x.test']))).ok).toBe(false);
    expect(h.sender.busy).toBe(false);
    expect((await h.sender.send(input(['a@x.test']))).ok).toBe(true);
  });
});

describe('token secrecy', () => {
  it('tokens never appear in results, even when errors echo them', async () => {
    const h = harness([{ status: 400, body: `bad token ${TOKEN_A}` }]);
    const r = await h.sender.send(input(['a@x.test']));
    expect(r.results[0]!.error).toContain('[REDACTED]');
    expect(leaksToken(r)).toBe(false);
    const h2 = harness([new Error(`fetch failed for Bearer ${TOKEN_A}`)]);
    expect(leaksToken(await h2.sender.send(input(['a@x.test'])))).toBe(false);
  });

  it('scrubs the actual token value even when it does not look like a Google ya29 token', async () => {
    const OPAQUE = 'opaque-access-token-QWERTY-123456';
    const h = harness([{ status: 403, body: `denied for ${OPAQUE}` }], [OPAQUE]);
    const r = await h.sender.send(input(['a@x.test']));
    expect(JSON.stringify(r)).not.toContain(OPAQUE);
    expect(r.results[0]!.error).toContain('[REDACTED]');
  });

  it('token acquisition failure stops before any request', async () => {
    const h = harness([]);
    (h.deps.getToken as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('OAuth2 not granted or revoked.'));
    const r = await h.sender.send(input(['a@x.test']));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^token: .*not granted/) });
    expect(h.deps.fetch).not.toHaveBeenCalled();
  });
});

describe('dry run (never sends)', () => {
  it('builds and decodes every copy without calling fetch', () => {
    let n = 0;
    const d = dryRun(input(['a@x.test', 'b@x.test']), () => `<id-${++n}@tracklet.invalid>`);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.copies).toHaveLength(2);
    expect(d.copies[0]!.decodedMime).toMatch(/\r\nTo: <a@x\.test>\r\n/);
    expect(d.copies[0]!.decodedMime).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(d.copies[1]!.inReplyTo).toBe('<id-1@tracklet.invalid>');
    expect(d.copies[1]!.request.body).toHaveProperty('threadId');
    expect(d.copies[0]!.request.body).not.toHaveProperty('threadId');
    expect(JSON.stringify(d)).not.toMatch(/Bearer|authorization/i);
  });

  it('runtime proof: dryRun never invokes the global fetch (or any network)', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('dryRun must not fetch'); });
    try {
      let n = 0;
      const d = dryRun(input(['a@x.test', 'b@x.test', 'c@x.test']), () => `<id-${++n}@tracklet.invalid>`);
      expect(d.ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('dryRun has no way to reach a fetch: it takes no deps and its source references none', async () => {
    expect(dryRun.length).toBe(2);   // (input, newMessageId) only — no injected fetch
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./send.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function dryRun'), src.indexOf('function scrub'));
    expect(body).not.toMatch(/fetch|deps|BatchSender|\.send\(/);
  });

  it('reports validation errors instead of building', () => {
    const d = dryRun(input(['a@x.test', 'A@x.test']), () => '<x@y>');
    expect(d).toMatchObject({ ok: false, errors: [expect.stringMatching(/duplicate/)] });
  });
});
