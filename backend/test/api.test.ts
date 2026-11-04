// Backend integration tests: real SQL on node:sqlite with the real migrations; Google tokeninfo is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isTrackingToken } from '@tracklet/shared';
import { createApp, GIF, inQuietHours, runRetention, type Env } from '../src/app';
import { TestD1 } from './d1';

const CLIENT_ID = '123-test.apps.googleusercontent.com';
const ORIGIN = 'chrome-extension://hhejoehmmjbjahinnpgnfhfakbkhilcd';
const BASE = 'https://t.example.test';
const SUB = '111111111111111111111';

let logs: string[] = [];
let db: TestD1, env: Env, clock: number, pending: Promise<unknown>[], tokeninfo: Record<string, unknown>;
let app: ReturnType<typeof createApp>;
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {}, props: {} });

async function req(path: string, init: RequestInit & { ip?: string } = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', init.ip ?? '203.0.113.7');
  const res = await app.request(path, { ...init, headers }, env, ctx() as unknown as ExecutionContext);
  await Promise.all(pending.splice(0));
  return res;
}
const json = async (r: Response) => r.json() as Promise<any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

async function session(sub = SUB): Promise<string> {
  tokeninfo = { aud: CLIENT_ID, sub, email: 'me@example.test', email_verified: 'true', scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send' };
  const r = await req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ google_access_token: 'ya29.fake' }) });
  expect(r.status).toBe(200);
  return (await json(r)).session_token;
}
const authed = (tok: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${tok}`, origin: ORIGIN, 'content-type': 'application/json', ...extra });
const key = (n: number) => `k${String(n).padStart(42, '0')}`;
const registerBody = (o: Record<string, unknown> = {}) => ({
  client_request_id: `req-${Math.random().toString(36).slice(2, 12)}`, mode: 'single', subject: null, track_opens: true, track_clicks: true, disclosure_added: false,
  recipients: [{ recipient_key: key(1), original_field: 'to', address: null }],
  links: [{ index: 0, url: 'https://example.com/a?x=1#y' }, { index: 1, url: 'https://example.org/b' }], ...o,
});
async function register(tok: string, o: Record<string, unknown> = {}) {
  const r = await req('/v1/emails', { method: 'POST', headers: authed(tok), body: JSON.stringify(registerBody(o)) });
  return { status: r.status, body: await json(r) };
}
async function markSent(tok: string, emailId: string, recipientId: string, sentAt: number) {
  await req(`/v1/emails/${emailId}/recipients/${recipientId}`, { method: 'PATCH', headers: authed(tok), body: JSON.stringify({ send_status: 'sending' }) });
  return req(`/v1/emails/${emailId}/recipients/${recipientId}`, { method: 'PATCH', headers: authed(tok), body: JSON.stringify({ send_status: 'sent', gmail_message_id: 'abc123', gmail_thread_id: 'thr123', sent_at: sentAt }) });
}
const pixelPath = (u: string) => new URL(u).pathname;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

beforeEach(() => {
  db = new TestD1();
  clock = Date.UTC(2026, 10, 4, 12, 0, 0);
  pending = [];
  env = {
    DB: db as unknown as D1Database, APP_VERSION: 'test', SESSION_SIGNING_KEY: 's'.repeat(40), IP_HASH_SALT: 'salt-'.repeat(5),
    GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_GOOGLE_SUBS: SUB, EXTENSION_ORIGIN: ORIGIN, PUBLIC_BASE_URL: BASE,
  };
  logs = [];
  app = createApp({ googleFetch: async () => ({ status: 200, json: async () => tokeninfo }), now: () => clock, log: (l) => logs.push(l) });
});

describe('health / config / CORS', () => {
  it('health ok, unknown route 404 JSON', async () => {
    expect(await json(await req('/health'))).toEqual({ status: 'ok', service: 'tracklet-backend', version: 'test' });
    expect((await req('/nope')).status).toBe(404);
  });
  it('misconfigured secrets → 500 on /v1 without leaking which', async () => {
    env.SESSION_SIGNING_KEY = 'short';
    const r = await req('/v1/preferences', { headers: { origin: ORIGIN } });
    expect(r.status).toBe(500);
    expect(await json(r)).toEqual({ error: 'internal' });
  });
  it('rejects foreign origins; preflight only for the extension origin', async () => {
    expect((await req('/v1/preferences', { headers: { origin: 'https://evil.test' } })).status).toBe(403);
    const pf = await req('/v1/emails', { method: 'OPTIONS', headers: { origin: ORIGIN } });
    expect(pf.status).toBe(204);
    expect(pf.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('session + authentication', () => {
  it('issues a session for an allowlisted, verified token and creates default prefs', async () => {
    const tok = await session();
    const prefs = await json(await req('/v1/preferences', { headers: authed(tok) }));
    expect(prefs).toMatchObject({ store_subjects: false, store_addresses: false, notify_first_only: true });
  });
  it.each([
    [{ aud: 'other-client' }, 401], [{ email_verified: 'false' }, 401], [{ scope: 'openid' }, 401], [{ sub: '999' }, 403],
  ])('rejects tokeninfo %j with %i', async (patch, status) => {
    tokeninfo = { aud: CLIENT_ID, sub: SUB, email: 'me@example.test', email_verified: 'true', scope: 'openid email', ...patch };
    const r = await req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ google_access_token: 'ya29.x' }) });
    expect(r.status).toBe(status);
  });
  it('google tokeninfo failure → 401', async () => {
    app = createApp({ googleFetch: async () => ({ status: 400, json: async () => ({}) }), now: () => clock });
    expect((await req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ google_access_token: 'bad' }) })).status).toBe(401);
  });
  it('rejects missing, tampered, wrong-key and expired sessions', async () => {
    const tok = await session();
    expect((await req('/v1/preferences', { headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await req('/v1/preferences', { headers: authed(tok.slice(0, -2) + 'xx') })).status).toBe(401);
    const parts = tok.split('.');
    const forged = [parts[0], Buffer.from(JSON.stringify({ sub: '01ARZ3NDEKTSV4RRFFQ69G5FAV', iat: 0, exp: 9e9 })).toString('base64url'), parts[2]].join('.');
    expect((await req('/v1/preferences', { headers: authed(forged) })).status).toBe(401);
    clock += 31 * 86_400_000;
    expect((await req('/v1/preferences', { headers: authed(tok) })).status).toBe(401);
  });
  it.each([[''], [' '], [','], [' , ,'], [undefined]])('allowlist %j denies every account (fails closed)', async (value) => {
    const tok = await session();   // issued while SUB was allowlisted
    (env as { ALLOWED_GOOGLE_SUBS?: string }).ALLOWED_GOOGLE_SUBS = value;
    const r = await req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ google_access_token: 'ya29.x' }) });
    expect(r.status).toBe(403);
    expect((await req('/v1/preferences', { headers: authed(tok) })).status).toBe(403);   // existing sessions too
  });
  it('allowlist compares tokeninfo `sub` exactly (no email, no prefix/case/whitespace-insensitive match)', async () => {
    for (const list of ['me@example.test', SUB.slice(0, -1), `${SUB}0`, SUB.toUpperCase() === SUB ? `x${SUB}` : SUB.toUpperCase()]) {
      env.ALLOWED_GOOGLE_SUBS = list;
      const r = await req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ google_access_token: 'ya29.x' }) });
      expect(r.status, list).toBe(403);
    }
    env.ALLOWED_GOOGLE_SUBS = ` other , ${SUB} `;   // comma-separated, surrounding whitespace trimmed
    expect((await req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ google_access_token: 'ya29.x' }) })).status).toBe(200);
  });
  it('removing a sub from the allowlist revokes existing sessions immediately', async () => {
    const tok = await session();
    env.ALLOWED_GOOGLE_SUBS = 'someone-else';
    expect((await req('/v1/preferences', { headers: authed(tok) })).status).toBe(403);
  });
});

describe('register tracked email', () => {
  it('returns unpredictable per-recipient pixel and click URLs that contain no address', async () => {
    const tok = await session();
    const { status, body } = await register(tok, { mode: 'individual_group', recipients: [{ recipient_key: key(1), original_field: 'to', address: null }, { recipient_key: key(2), original_field: 'cc', address: null }] });
    expect(status).toBe(201);
    const tokens: string[] = [];
    for (const r of body.recipients) {
      const pt = pixelPath(r.pixel_url).match(/^\/o\/([^.]+)\.gif$/)![1]!;
      tokens.push(pt, ...r.links.map((l: { click_url: string }) => new URL(l.click_url).pathname.split('/')[2]!));
      expect(r.pixel_url.startsWith(`${BASE}/o/`)).toBe(true);
      expect(r.links.map((l: { index: number }) => l.index)).toEqual([0, 1]);
    }
    expect(tokens.every(isTrackingToken)).toBe(true);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(JSON.stringify(body)).not.toMatch(/@/);
    expect(db.q('SELECT address, subject FROM recipients JOIN tracked_emails e ON e.id = email_id')).toEqual([{ address: null, subject: null }, { address: null, subject: null }]);
  });
  it('is idempotent on client_request_id', async () => {
    const tok = await session();
    const b = registerBody();
    const a = await req('/v1/emails', { method: 'POST', headers: authed(tok), body: JSON.stringify(b) });
    const again = await req('/v1/emails', { method: 'POST', headers: authed(tok), body: JSON.stringify(b) });
    expect(a.status).toBe(201);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual(await json(a));
    expect(db.q('SELECT COUNT(*) AS n FROM tracked_emails')[0]).toEqual({ n: 1 });
  });
  it('no pixel when track_opens is false; no links when track_clicks is false', async () => {
    const tok = await session();
    const { body } = await register(tok, { track_opens: false, track_clicks: false });
    expect(body.recipients[0].pixel_url).toBeNull();
    expect(body.recipients[0].links).toEqual([]);
  });
  it.each([
    [{ subject: 'Secret' }, 'subject must be null'],
    [{ recipients: [{ recipient_key: key(1), original_field: 'to', address: 'a@b.c' }] }, 'address must be null'],
    [{ links: [{ index: 0, url: 'javascript:alert(1)' }] }, 'links[0].url'],
    [{ links: [{ index: 0, url: 'https://u:p@x.test/' }] }, 'links[0].url'],
    [{ links: [{ index: 0, url: 'https://a.test/' }, { index: 0, url: 'https://b.test/' }] }, 'links[1].index'],
    [{ recipients: [{ recipient_key: 'short', original_field: 'to', address: null }] }, 'recipient_key'],
    [{ mode: 'single', recipients: [{ recipient_key: key(1), original_field: 'to', address: null }, { recipient_key: key(2), original_field: 'to', address: null }] }, 'single mode'],
    [{ mode: 'individual_group', recipients: [{ recipient_key: key(1), original_field: 'to', address: null }, { recipient_key: key(1), original_field: 'to', address: null }] }, 'duplicate'],
    [{ recipients: Array.from({ length: 21 }, (_, i) => ({ recipient_key: key(i), original_field: 'to', address: null })), mode: 'individual_group' }, 'recipients count'],
    [{ client_request_id: "x'; DROP TABLE users;--" }, 'client_request_id'],
  ])('rejects %j', async (patch, msg) => {
    const tok = await session();
    const { status, body } = await register(tok, patch);
    expect(status).toBe(400);
    expect(JSON.stringify(body.details)).toContain(msg);
    expect(db.q('SELECT COUNT(*) AS n FROM tracked_emails')[0]).toEqual({ n: 0 });
  });
  it('stores subject/address only after the user opts in', async () => {
    const tok = await session();
    await req('/v1/preferences', { method: 'PUT', headers: authed(tok), body: JSON.stringify({ notify_open: true, notify_click: true, notify_first_only: true, include_suspected: false, quiet_start_min: null, quiet_end_min: null, timezone: 'UTC', store_subjects: true, store_addresses: true, disclosure_enabled: false, disclosure_text: null }) });
    const { status } = await register(tok, { subject: 'Hello', recipients: [{ recipient_key: key(1), original_field: 'to', address: 'a@b.test' }] });
    expect(status).toBe(201);
  });
  it('malformed JSON → 400; oversized body → 413', async () => {
    const tok = await session();
    expect((await req('/v1/emails', { method: 'POST', headers: authed(tok), body: '{bad' })).status).toBe(400);
    expect((await req('/v1/emails', { method: 'POST', headers: authed(tok, { 'content-length': String(200_000) }), body: 'x' })).status).toBe(413);
  });
});

describe('recipient status machine + ownership', () => {
  it('enforces transitions, aggregates email status, and hides other users\' records', async () => {
    const tok = await session();
    const { body } = await register(tok, { mode: 'individual_group', recipients: [{ recipient_key: key(1), original_field: 'to', address: null }, { recipient_key: key(2), original_field: 'to', address: null }] });
    const [r1, r2] = body.recipients;
    const patch = (rid: string, b: object, t = tok) => req(`/v1/emails/${body.email_id}/recipients/${rid}`, { method: 'PATCH', headers: authed(t), body: JSON.stringify(b) });
    expect((await patch(r1.recipient_id, { send_status: 'sent' })).status).toBe(409);   // pending → sent not allowed
    expect(await json(await markSent(tok, body.email_id, r1.recipient_id, clock))).toEqual({ email_status: 'sending' });
    expect((await patch(r1.recipient_id, { send_status: 'failed' })).status).toBe(409);  // sent is terminal
    expect((await patch(r1.recipient_id, { send_status: 'sent', gmail_message_id: 'zzz' })).status).toBe(409);
    await patch(r2.recipient_id, { send_status: 'sending' });
    expect(await json(await patch(r2.recipient_id, { send_status: 'failed', send_error: 'gmail_429' }))).toEqual({ email_status: 'partial' });
    env.ALLOWED_GOOGLE_SUBS = `${SUB},222`;
    const other = await session('222');
    expect((await patch(r2.recipient_id, { send_status: 'sending' }, other)).status).toBe(404);
    expect((await req(`/v1/emails/${body.email_id}`, { headers: authed(other) })).status).toBe(404);
  });
});

describe('open pixel', () => {
  async function sentEmail(sentAt = clock - 3_600_000) {
    const tok = await session();
    const { body } = await register(tok);
    const r = body.recipients[0];
    await markSent(tok, body.email_id, r.recipient_id, sentAt);
    return { tok, emailId: body.email_id, r, pixel: pixelPath(r.pixel_url) };
  }

  it('unknown and malformed tokens get the identical GIF and record nothing', async () => {
    for (const p of ['/o/AAAAAAAAAAAAAAAAAAAAAA.gif', "/o/x'%20OR%201=1.gif", '/o/..%2F..%2Fetc.gif']) {
      const r = await req(p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/gif');
      expect(r.headers.get('cache-control')).toContain('no-store');
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(GIF);
    }
    expect(db.q('SELECT COUNT(*) AS n FROM tracking_events')[0]).toEqual({ n: 0 });
  });

  it('records a human-likely open, updates counters, and never stores the raw IP', async () => {
    const { pixel } = await sentEmail();
    await req(pixel, { headers: { 'user-agent': CHROME_UA }, ip: '198.51.100.23' });
    const [e] = db.q<Record<string, unknown>>('SELECT * FROM tracking_events');
    expect(e).toMatchObject({ type: 'open', classification: 'human_likely', counted: 1, ua_family: 'Chrome' });
    expect(String(e!.ip_hash)).not.toContain('198.51.100.23');
    expect(JSON.stringify(db.q('SELECT * FROM tracking_events'))).not.toContain('198.51.100.23');
    expect(db.q('SELECT open_count FROM recipients')[0]).toEqual({ open_count: 1 });
  });

  it('classifies Gmail proxy, prefetch-in-grace, HEAD, scanners and duplicates', async () => {
    const { pixel } = await sentEmail(clock - 10_000);   // 10 s after send → within 15 s grace
    await req(pixel, { headers: { 'user-agent': CHROME_UA } });
    clock += 60_000;
    await req(pixel, { method: 'HEAD' });
    await req(pixel, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } });
    await req(pixel, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } });
    await req(pixel, { headers: { 'user-agent': 'python-requests/2.31' } });
    expect(db.q('SELECT classification, counted FROM tracking_events ORDER BY id').map((x) => `${x.classification}:${x.counted}`))
      .toEqual(['prefetch_suspected:0', 'prefetch_suspected:0', 'proxy_open:1', 'duplicate:0', 'prefetch_suspected:0']);
    expect(db.q('SELECT open_count FROM recipients')[0]).toEqual({ open_count: 1 });
  });

  it('caps events per token per day (log-flood protection)', async () => {
    const { pixel } = await sentEmail();
    for (let i = 0; i < 105; i++) { clock += 61_000; await req(pixel, { headers: { 'user-agent': CHROME_UA }, ip: `198.51.100.${i % 250}` }); }
    expect(db.q('SELECT COUNT(*) AS n FROM tracking_events')[0]).toEqual({ n: 100 });
  });

  it('a later sender view reclassifies a nearby open as self_suspected and reverses the counter', async () => {
    const { tok, pixel } = await sentEmail();
    await req(pixel, { headers: { 'user-agent': 'GoogleImageProxy' } });
    expect(db.q('SELECT open_count FROM recipients')[0]).toEqual({ open_count: 1 });
    clock += 30_000;
    expect((await req('/v1/views', { method: 'POST', headers: authed(tok), body: JSON.stringify({ gmail_thread_id: 'thr123' }) })).status).toBe(204);
    expect(db.q('SELECT classification, counted FROM tracking_events')[0]).toEqual({ classification: 'self_suspected', counted: 0 });
    expect(db.q('SELECT open_count, first_open_at FROM recipients')[0]).toEqual({ open_count: 0, first_open_at: null });
    // an open right after the view is self_suspected at ingestion
    clock += 10_000;
    await req(pixel, { headers: { 'user-agent': 'GoogleImageProxy' }, ip: '192.0.2.99' });
    expect(db.q('SELECT classification FROM tracking_events ORDER BY id DESC LIMIT 1')[0]).toEqual({ classification: 'self_suspected' });
  });
});

describe('click redirect', () => {
  async function sentEmail(sentAt = clock - 3_600_000) {
    const tok = await session();
    const { body } = await register(tok);
    const r = body.recipients[0];
    await markSent(tok, body.email_id, r.recipient_id, sentAt);
    return { tok, emailId: body.email_id, r };
  }

  it('302s to the exact stored URL; a human click is counted and implies an open', async () => {
    const { r } = await sentEmail();
    const res = await req(pixelPath(r.links[0].click_url), { headers: { 'user-agent': CHROME_UA } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/a?x=1#y');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(db.q('SELECT type, classification, counted FROM tracking_events ORDER BY id').map((x) => `${x.type}:${x.classification}:${x.counted}`))
      .toEqual(['click:human_likely:1', 'implied_open:human_likely:1']);
    expect(db.q('SELECT open_count, click_count FROM recipients')[0]).toEqual({ open_count: 1, click_count: 1 });
  });

  it('unknown/malformed tokens → 404 text, never a redirect; no open-redirect via query params', async () => {
    for (const p of ['/c/AAAAAAAAAAAAAAAAAAAAAA', '/c/%3Cscript%3E', '/c/AAAAAAAAAAAAAAAAAAAAAA?url=https://evil.test', '/c/..%2F..']) {
      const res = await req(p);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/plain');
    }
    const { r } = await sentEmail();
    const res = await req(`${pixelPath(r.links[0].click_url)}?url=https://evil.test&next=https://evil.test`);
    expect(res.headers.get('location')).toBe('https://example.com/a?x=1#y');
  });

  it('re-validates the stored target: a tampered javascript: target is never redirected to', async () => {
    const { r } = await sentEmail();
    db.db.prepare("UPDATE tracked_links SET target_url = 'javascript:alert(1)'").run();
    const res = await req(pixelPath(r.links[0].click_url));
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('flags scanner patterns: click within 5 s of send, HEAD, and a multi-link burst', async () => {
    const { r } = await sentEmail(clock - 2_000);
    await req(pixelPath(r.links[0].click_url), { headers: { 'user-agent': CHROME_UA } });   // 2 s after send
    clock += 60_000;
    await req(pixelPath(r.links[0].click_url), { method: 'HEAD', ip: '192.0.2.1' });
    clock += 60_000;
    await req(pixelPath(r.links[0].click_url), { headers: { 'user-agent': CHROME_UA }, ip: '192.0.2.2' });
    clock += 500;
    await req(pixelPath(r.links[1].click_url), { headers: { 'user-agent': CHROME_UA }, ip: '192.0.2.2' });   // 0.5 s later, other link
    expect(db.q("SELECT classification FROM tracking_events WHERE type = 'click' ORDER BY id").map((x) => x.classification))
      .toEqual(['scanner_suspected', 'scanner_suspected', 'human_likely', 'scanner_suspected']);
  });
});

describe('events feed, analytics and notifications', () => {
  it('cursor paging; notify respects first-only, suspected and quiet hours', async () => {
    const tok = await session();
    const { body } = await register(tok);
    const r = body.recipients[0];
    await markSent(tok, body.email_id, r.recipient_id, clock - 3_600_000);
    const px = pixelPath(r.pixel_url);
    await req(px, { headers: { 'user-agent': 'GoogleImageProxy' }, ip: '192.0.2.1' });
    clock += 120_000;
    await req(px, { headers: { 'user-agent': 'GoogleImageProxy' }, ip: '192.0.2.1' });   // second open
    await req(px, { method: 'HEAD', ip: '192.0.2.3' });                                     // suspected
    const feed = await json(await req('/v1/events', { headers: authed(tok) }));
    expect(feed.events.map((e: { notify: boolean; classification: string }) => `${e.classification}:${e.notify}`))
      .toEqual(['proxy_open:true', 'proxy_open:false', 'prefetch_suspected:false']);
    const next = await json(await req(`/v1/events?since=${feed.next_cursor}`, { headers: authed(tok) }));
    expect(next.events).toEqual([]);
    expect((await req("/v1/events?since=x' OR 1=1", { headers: authed(tok) })).status).toBe(400);
  });

  it('quiet hours wrap midnight in the user timezone', () => {
    const p = { notify_open: true, notify_click: true, notify_first_only: true, include_suspected: false, quiet_start_min: 22 * 60, quiet_end_min: 7 * 60, timezone: 'UTC', store_subjects: false, store_addresses: false, disclosure_enabled: false, disclosure_text: null };
    expect(inQuietHours(p, Date.UTC(2026, 0, 1, 23, 0))).toBe(true);
    expect(inQuietHours(p, Date.UTC(2026, 0, 1, 6, 59))).toBe(true);
    expect(inQuietHours(p, Date.UTC(2026, 0, 1, 12, 0))).toBe(false);
  });

  it('dashboard rates are null with no sent recipients (never fabricated), real otherwise', async () => {
    const tok = await session();
    expect((await json(await req('/v1/dashboard', { headers: authed(tok) }))).totals).toMatchObject({ emails_sent: 0, open_rate: null, click_rate: null });
    const { body } = await register(tok);
    await markSent(tok, body.email_id, body.recipients[0].recipient_id, clock - 3_600_000);
    await req(pixelPath(body.recipients[0].pixel_url), { headers: { 'user-agent': CHROME_UA } });
    const d = await json(await req('/v1/dashboard?range=7d', { headers: authed(tok) }));
    expect(d.totals).toMatchObject({ emails_sent: 1, sent_recipients: 1, opened_recipients: 1, open_rate: 1, click_rate: 0 });
    expect((await req('/v1/dashboard?range=1y', { headers: authed(tok) })).status).toBe(400);
  });

  it('email list filters + detail with suspected toggle + thread status', async () => {
    const tok = await session();
    const a = (await register(tok)).body;
    const b = (await register(tok)).body;
    await markSent(tok, a.email_id, a.recipients[0].recipient_id, clock - 3_600_000);
    await req(pixelPath(a.recipients[0].pixel_url), { headers: { 'user-agent': CHROME_UA } });
    await req(pixelPath(a.recipients[0].pixel_url), { method: 'HEAD', ip: '192.0.2.9' });
    const opened = await json(await req('/v1/emails?filter=opened', { headers: authed(tok) }));
    expect(opened.items.map((x: { email_id: string }) => x.email_id)).toEqual([a.email_id]);
    const all = await json(await req('/v1/emails?limit=1', { headers: authed(tok) }));
    expect(all.items).toHaveLength(1);
    expect(all.next_cursor).toBe(b.email_id);
    const det = await json(await req(`/v1/emails/${a.email_id}`, { headers: authed(tok) }));
    expect(det.totals).toMatchObject({ opened_recipients: 1, suspected_events: 1 });
    expect(det.recipients[0].status_label).toBe('likely_opened');
    const det2 = await json(await req(`/v1/emails/${a.email_id}?include_suspected=false`, { headers: authed(tok) }));
    expect(det2.events.every((e: { counted: boolean }) => e.counted)).toBe(true);
    const ts = await json(await req('/v1/threads/status?ids=thr123,nope,bad!id', { headers: authed(tok) }));
    expect(Object.keys(ts)).toEqual(['thr123']);
  });
});

describe('deletion, rate limits, retention', () => {
  it('DELETE email cascades to recipients, links and events; DELETE me/data removes everything', async () => {
    const tok = await session();
    const { body } = await register(tok);
    await markSent(tok, body.email_id, body.recipients[0].recipient_id, clock - 3_600_000);
    await req(pixelPath(body.recipients[0].pixel_url), { headers: { 'user-agent': CHROME_UA } });
    expect((await req(`/v1/emails/${body.email_id}`, { method: 'DELETE', headers: authed(tok) })).status).toBe(204);
    for (const t of ['tracked_emails', 'recipients', 'tracked_links', 'tracking_events']) expect(db.q(`SELECT COUNT(*) AS n FROM ${t}`)[0]).toEqual({ n: 0 });
    await register(tok);
    expect((await req('/v1/me/data', { method: 'DELETE', headers: authed(tok) })).status).toBe(204);
    expect(db.q('SELECT COUNT(*) AS n FROM tracked_emails')[0]).toEqual({ n: 0 });
  });

  it('per-IP API rate limit (120/min) returns 429, and resets in the next window', async () => {
    const tok = await session();   // 1 request used
    let last = 0;
    for (let i = 0; i < 120; i++) last = (await req('/v1/preferences', { headers: authed(tok) })).status;
    expect(last).toBe(429);
    clock += 60_000;
    expect((await req('/v1/preferences', { headers: authed(tok) })).status).toBe(200);
  });

  it('registration rate limit (100/hour per user) cannot be bypassed by changing IP', async () => {
    const tok = await session();
    let last = 0;
    for (let i = 0; i < 101; i++) {
      last = (await req('/v1/emails', { method: 'POST', headers: authed(tok), body: JSON.stringify(registerBody()), ip: `198.51.100.${i % 250}` })).status;
    }
    expect(last).toBe(429);
  });

  it('retention deletes old events/views/caps but keeps counters', async () => {
    const tok = await session();
    const { body } = await register(tok);
    await markSent(tok, body.email_id, body.recipients[0].recipient_id, clock - 3_600_000);
    await req(pixelPath(body.recipients[0].pixel_url), { headers: { 'user-agent': CHROME_UA } });
    await runRetention(db as unknown as D1Database, clock + 181 * 86_400_000);
    expect(db.q('SELECT COUNT(*) AS n FROM tracking_events')[0]).toEqual({ n: 0 });
    expect(db.q('SELECT open_count FROM recipients')[0]).toEqual({ open_count: 1 });
  });
});

describe('error logging hygiene', () => {
  it('unhandled errors return a generic 500 and log no request data', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tok = await session();
    (env.DB as unknown as { prepare: unknown }).prepare = () => { throw new Error(`boom ${tok}`); };
    const r = await req('/v1/preferences', { headers: authed(tok) });
    expect(r.status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(tok);
    spy.mockRestore();
  });
});

describe('auth diagnostics (safe: stage, presence, counts, match; never sub/email/token/header)', () => {
  const post = () => req('/v1/auth/session', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ google_access_token: 'ya29.DIAG' }) });
  const last = () => JSON.parse(logs[logs.length - 1]!.replace('[tracklet-auth] ', '')) as Record<string, unknown>;
  const assertSafe = () => {
    const all = logs.join(' | ');
    expect(all).not.toContain(SUB);
    expect(all).not.toMatch(/me@example.test|ya29|Bearer|authorization/i);
  };

  it('empty allowlist: denied at the session stage, variable reported absent', async () => {
    env.ALLOWED_GOOGLE_SUBS = '';
    expect((await post()).status).toBe(403);
    expect(last()).toEqual({ stage: 'session:allowlist_denied', allowlist_present: false, allowlist_entries: 0, entry_lengths: [], entries_quoted: false, sub_present: true, sub_length: SUB.length, sub_matches: false });
    assertSafe();
  });

  it('truncated or quoted paste is visible through lengths / quote flag only', async () => {
    env.ALLOWED_GOOGLE_SUBS = `${SUB.slice(0, -1)}, "${SUB}"`;
    expect((await post()).status).toBe(403);
    expect(last()).toMatchObject({ allowlist_present: true, allowlist_entries: 2, entry_lengths: [SUB.length - 1, SUB.length + 2], entries_quoted: true, sub_matches: false });
    assertSafe();
  });

  it('success is logged as issued with the match', async () => {
    expect((await post()).status).toBe(200);
    expect(last()).toEqual({ stage: 'session:issued', allowlist_entries: 1, sub_matches: true, new_user: true });
    assertSafe();
  });

  it('a later API request denied by the allowlist is distinguished from the sign-in stage', async () => {
    const tok = await session();
    env.ALLOWED_GOOGLE_SUBS = 'someone-else';
    expect((await req('/v1/preferences', { headers: authed(tok) })).status).toBe(403);
    expect(last()).toMatchObject({ stage: 'request:allowlist_denied', allowlist_entries: 1, sub_matches: false });
    expect((await req('/v1/preferences', { headers: authed('garbage') })).status).toBe(401);
    expect(last()).toEqual({ stage: 'request:session_invalid', session_header_present: true });
    assertSafe();
  });

  it('token claim failures name the failing check (401, not 403)', async () => {
    tokeninfo = { ...tokeninfo, aud: 'other-client' };
    expect((await post()).status).toBe(401);
    expect(last()).toEqual({ stage: 'session:token_claims_invalid', aud_matches: false, email_verified: true, openid_scope: true, email_scope: true, sub_present: true });
    assertSafe();
  });
});

describe('tracking diagnostics (did a pixel/click request arrive? never the token, IP or raw UA)', () => {
  const trackLines = () => logs.filter((l) => l.startsWith('[tracklet-track] ')).map((l) => JSON.parse(l.slice('[tracklet-track] '.length)) as Record<string, unknown>);

  it('logs arrival, whether the token is known, and the classification', async () => {
    const tok = await session();
    const { body } = await register(tok);
    const r = body.recipients[0];
    await markSent(tok, body.email_id, r.recipient_id, clock);
    clock += 60_000;
    await req(pixelPath(r.pixel_url), { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } });
    await req(pixelPath(r.pixel_url).replace(/\/o\/[^.]+/, '/o/AAAAAAAAAAAAAAAAAAAAAA'), { headers: { 'user-agent': CHROME_UA } });
    expect(trackLines()).toEqual([
      { type: 'open', token_known: true, classification: 'proxy_open', counted: true, ua_family: 'GoogleImageProxy', ms_since_send: 60_000 },
      { type: 'open', token_known: false },
    ]);
    const all = logs.join(' | ');
    const token = pixelPath(r.pixel_url).match(/\/o\/([^.]+)\.gif/)![1]!;
    expect(all).not.toContain(token);
    expect(all).not.toMatch(/203\.0\.113\.7|ggpht\.com|Windows NT/);
  });

  it('registration warns (once per email) when PUBLIC_BASE_URL is unreachable by mail clients', async () => {
    env.PUBLIC_BASE_URL = 'http://127.0.0.1:8787';
    const tok = await session();
    expect((await register(tok)).status).toBe(201);
    expect(logs.filter((l) => l.includes('register:public_base_url_unreachable'))).toEqual([
      '[tracklet-auth] {"stage":"register:public_base_url_unreachable","reason":"uses http, not https"}',
    ]);
  });
});
