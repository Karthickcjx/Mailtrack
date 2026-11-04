// LOCAL END-TO-END INTEGRATION (synthetic): the real extension pipeline + the real backend app on real SQLite.
// Faked: Gmail's send endpoint and Google's tokeninfo. Nothing leaves the process; no email is sent.
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../../../backend/src/app';
import { TestD1 } from '../../../backend/test/d1';
import { Backend } from './backend';
import { loadMeta } from './localStore';
import { poll, type Note } from './notify';
import { BatchSender } from './send';
import { testPlatform, type FakeReply } from './testPlatform';
import { trackedSend } from './trackedSend';

const BASE = 'https://t.example.test';
const ORIGIN = 'chrome-extension://hhejoehmmjbjahinnpgnfhfakbkhilcd';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

let db: TestD1, env: Env, clock: number, app: ReturnType<typeof createApp>, gmailSends: { raw: string; threadId?: string }[];

async function backendCall(url: string, init: { method?: string; body?: string; headers?: Record<string, string> }, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string }> {
  const pending: Promise<unknown>[] = [];
  const res = await app.request(new URL(url).pathname + new URL(url).search,
    { method: init.method ?? 'GET', headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.5', ...(init.headers ?? {}), ...extraHeaders }, ...(init.body !== undefined ? { body: init.body } : {}) },
    env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
  await Promise.all(pending);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

function platform() {
  let gmailId = 0;
  const p = testPlatform({ routes: () => ({ status: 500 }) });
  p.fetch = async (url, init = {}) => {
    let r: FakeReply & { raw?: string };
    if (url.startsWith(BASE)) {
      const b = await backendCall(url, init);
      return { status: b.status, headers: { get: (n) => b.headers.get(n) }, text: async () => b.body };
    }
    if (url.startsWith('https://gmail.googleapis.com/')) {
      const body = JSON.parse(init.body!);
      gmailSends.push(body);
      gmailId++;
      r = { status: 200, body: { id: `gm${gmailId}`, threadId: 'thrE2E', labelIds: ['SENT'] } };
    } else r = { status: 404 };
    return { status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body ?? {}) };
  };
  p.now = () => clock;
  return p;
}

beforeEach(() => {
  db = new TestD1();
  clock = Date.UTC(2026, 10, 4, 12);
  gmailSends = [];
  env = { DB: db as unknown as D1Database, SESSION_SIGNING_KEY: 'k'.repeat(40), IP_HASH_SALT: 'salt'.repeat(5), GOOGLE_CLIENT_ID: 'cid',
    ALLOWED_GOOGLE_SUBS: 'SUB1', EXTENSION_ORIGIN: ORIGIN, PUBLIC_BASE_URL: BASE };
  app = createApp({ now: () => clock, googleFetch: async () => ({ status: 200, json: async () => ({ aud: 'cid', sub: 'SUB1', email: 'me@x.test', email_verified: 'true', scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send' }) }) });
});

describe('local end-to-end: tracked send → open → click → notifications → analytics', () => {
  it('works for a 2-recipient individually tracked email', async () => {
    const p = platform();
    const backend = new Backend(p, BASE);
    const sender = new BatchSender({ fetch: (u, i) => p.fetch(u, i), getToken: (x) => p.getAuthToken(x), invalidateToken: (t) => p.removeCachedAuthToken(t), sleep: async () => {}, newMessageId: (() => { let n = 0; return () => `<e2e${++n}@tracklet.invalid>`; })() });

    // 1) send
    const out = await trackedSend(p, backend, sender, {
      kind: 'new', to: ['ana@example.test'], cc: ['bo@example.test'], bcc: [], subject: 'Proposal ✓',
      html: '<p>See <a href="https://example.com/pricing?q=1">pricing</a></p>', hasAttachments: false, groupConfirmed: true,
    }, 'me@x.test', { disclosure_enabled: false, disclosure_text: null });
    expect(out.ok).toBe(true);
    expect(gmailSends).toHaveLength(2);
    const mimes = gmailSends.map((s) => Buffer.from(s.raw, 'base64url').toString('utf8'));
    expect(mimes[0]).toMatch(/\r\nTo: <ana@example\.test>\r\n/);
    expect(mimes[1]).toMatch(/\r\nTo: <bo@example\.test>\r\n/);
    expect(gmailSends[1]!.threadId).toBe('thrE2E');
    // the backend stored no subject and no address
    expect(db.q('SELECT subject FROM tracked_emails')).toEqual([{ subject: null }]);
    expect(db.q('SELECT address, send_status FROM recipients ORDER BY id')).toEqual([{ address: null, send_status: 'sent' }, { address: null, send_status: 'sent' }]);
    expect(JSON.stringify(db.q('SELECT * FROM recipients'))).not.toMatch(/ana@|bo@/);
    const meta = await loadMeta(p, out.emailId!);
    expect(meta!.recipients.map((r) => r.address)).toEqual(['ana@example.test', 'bo@example.test']);

    // 2) extract each copy's tracking URLs from the actual MIME HTML part
    const htmlOf = (m: string) => Buffer.from(m.split('Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1]!.split('\r\n--')[0]!.replace(/\r\n/g, ''), 'base64').toString('utf8');
    const anaHtml = htmlOf(mimes[0]!), boHtml = htmlOf(mimes[1]!);
    const pixel = anaHtml.match(/<img src="(https:\/\/t\.example\.test\/o\/[A-Za-z0-9_-]{22}\.gif)"/)![1]!;
    const click = boHtml.match(/href="(https:\/\/t\.example\.test\/c\/[A-Za-z0-9_-]{22})"/)![1]!;
    expect(anaHtml).not.toContain('example.com/pricing');
    expect(anaHtml.match(/\/o\/([^.]+)\.gif/)![1]).not.toBe(boHtml.match(/\/o\/([^.]+)\.gif/)![1]);   // per-recipient ids

    // 3) recipient activity an hour later: Ana's Gmail proxy loads the pixel; Bo clicks the link
    clock += 3_600_000;
    await backendCall(pixel, { headers: { 'user-agent': 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' } }, { origin: '' });
    clock += 60_000;
    const redirect = await backendCall(click, { headers: { 'user-agent': CHROME_UA } }, { origin: '', 'cf-connecting-ip': '198.51.100.9' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.com/pricing?q=1');

    // 4) the service-worker poll turns events into notifications, once
    const shown: Note[] = [];
    const r1 = await poll(p, backend, async (n) => { shown.push(n); });
    expect(r1).toMatchObject({ authRequired: false, notified: 2 });
    expect(shown.map((n) => n.message)).toEqual([
      'ana@example.test likely opened "Proposal ✓" (via image proxy)',
      'bo@example.test clicked example.com in "Proposal ✓"',
    ]);
    expect((await poll(p, backend, async (n) => { shown.push(n); })).notified).toBe(0);   // no duplicates
    expect(shown).toHaveLength(2);

    // 5) analytics reflect real backend events
    const detail = await backend.request<{ totals: Record<string, number> }>('GET', `/v1/emails/${out.emailId}`);
    expect(detail.totals).toMatchObject({ recipients: 2, sent_recipients: 2, opened_recipients: 2, clicks: 1 });
    const dash = await backend.request<{ totals: Record<string, number | null> }>('GET', '/v1/dashboard');
    expect(dash.totals).toMatchObject({ emails_sent: 1, opened_recipients: 2, clicked_recipients: 1, open_rate: 1, click_rate: 0.5 });
  });

  it('a Gmail failure on copy 2 is reported to the backend and copy 3 is never sent', async () => {
    const p = platform();
    const realFetch = p.fetch;
    let gmailCalls = 0;
    p.fetch = async (url, init) => {
      if (url.startsWith('https://gmail.googleapis.com/') && ++gmailCalls === 2) return { status: 400, headers: { get: () => null }, text: async () => '{"error":{"message":"Invalid To header"}}' };
      return realFetch(url, init);
    };
    const backend = new Backend(p, BASE);
    const sender = new BatchSender({ fetch: (u, i) => p.fetch(u, i), getToken: (x) => p.getAuthToken(x), invalidateToken: async () => {}, sleep: async () => {}, newMessageId: () => `<${Math.random()}@t.invalid>` });
    const out = await trackedSend(p, backend, sender, {
      kind: 'new', to: ['a@example.test', 'b@example.test', 'c@example.test'], cc: [], bcc: [], subject: 'S', html: '<p>x</p>', hasAttachments: false, groupConfirmed: true,
    }, 'me@x.test', { disclosure_enabled: false, disclosure_text: null });
    expect(out.ok).toBe(false);
    expect(out.batch!.results.map((r) => r.status)).toEqual(['sent', 'failed', 'skipped']);
    expect(db.q('SELECT send_status FROM recipients ORDER BY id').map((r) => r.send_status)).toEqual(['sent', 'failed', 'pending']);
    expect(db.q('SELECT status FROM tracked_emails')[0]).toEqual({ status: 'sending' });
    expect(gmailCalls).toBe(2);
  });
});

// Regression (2026-11-04, real Chrome): emails were sent with pixel URLs on http://127.0.0.1:8787 (backend
// PUBLIC_BASE_URL). Gmail's image proxy fetches from Google's servers, so no pixel request ever reached the
// backend: 0 events. Such sends must be refused BEFORE any Gmail call, with no orphan record left behind.
describe('tracking URLs unreachable by recipients', () => {
  it.each(['http://127.0.0.1:8787', 'http://localhost:8787', 'https://192.168.1.20', 'https://tracklet.local'])('PUBLIC_BASE_URL %s: not sent, nothing left registered', async (base) => {
    env.PUBLIC_BASE_URL = base;
    const p = platform();
    const sender = new BatchSender({ fetch: (u, i) => p.fetch(u, i), getToken: (x) => p.getAuthToken(x), invalidateToken: (t) => p.removeCachedAuthToken(t), sleep: async () => {}, newMessageId: () => '<x@tracklet.invalid>' });
    const out = await trackedSend(p, new Backend(p, BASE), sender, {
      kind: 'new', to: ['ana@example.test'], cc: [], bcc: [], subject: 'S', html: '<p>Hi <a href="https://example.com/">x</a></p>', hasAttachments: false, groupConfirmed: true,
    }, 'me@x.test', { disclosure_enabled: false, disclosure_text: null });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain(`Tracking URLs point to ${new URL(base).origin}`);
    expect(out.summary).toMatch(/public https/);
    expect(out.summary).not.toMatch(/\/o\/|\/c\//);           // no tracking token in the message
    expect(gmailSends).toHaveLength(0);                       // Gmail never called
    expect(db.q('SELECT COUNT(*) AS n FROM tracked_emails')[0]).toEqual({ n: 0 });   // registration removed
    expect(await p.local.get('meta:x')).toBeUndefined();
  });
});
