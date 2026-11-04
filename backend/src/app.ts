// Tracklet backend (Cloudflare Worker + D1). docs/design/API_SPEC.md rev 2.
// Privacy defaults: no email bodies, no raw IPs (monthly-salted HMAC), no subjects/addresses unless the
// user opts in. Public endpoints (/o, /c) set no cookies and reveal nothing about token validity.
import { Hono, type Context } from 'hono';
import {
  GOOGLE_TOKENINFO_URL, trackingUrlProblem, isTrackingToken, isUlid, LIMITS, randomToken, ulid, validateTargetUrl,
  type HealthResponse, type PatchRecipientRequest, type Preferences, type RegisterEmailRequest, type StatusLabel,
} from '@tracklet/shared';
import { classify, CLASSIFIER_VERSION, CLICK_BURST_MS, DEDUPE_MS, isCounted, SELF_VIEW_WINDOW_MS, uaFamily } from './classify';
import { hmacHex, signSession, verifySession } from './crypto';

export interface Env {
  DB: D1Database;
  APP_VERSION?: string;
  SESSION_SIGNING_KEY: string;
  IP_HASH_SALT: string;
  GOOGLE_CLIENT_ID: string;
  ALLOWED_GOOGLE_SUBS: string;       // comma-separated Google account `sub`s
  EXTENSION_ORIGIN: string;           // chrome-extension://<id>
  PUBLIC_BASE_URL: string;            // https://<worker host> (no trailing slash)
}

export interface Deps {
  /** Fetch used ONLY for Google tokeninfo. Injected so tests never hit the network. */
  googleFetch: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
  now: () => number;
  /** Auth diagnostics sink (default console.warn). Receives only stage names, counts, booleans and lengths. */
  log?: (line: string) => void;
}

/**
 * Safe auth diagnostics: never the sub, email, token or Authorization header.
 * Lengths let you spot a truncated or quoted paste without revealing the value.
 */
export function allowlistDiag(env: { ALLOWED_GOOGLE_SUBS?: string }, sub: string | null) {
  const entries = allowedSubs(env);
  return {
    allowlist_present: typeof env.ALLOWED_GOOGLE_SUBS === 'string' && env.ALLOWED_GOOGLE_SUBS.trim() !== '',
    allowlist_entries: entries.length,
    entry_lengths: entries.map((e) => e.length),
    entries_quoted: entries.some((e) => /^["']|["']$/.test(e)),
    sub_present: !!sub,
    sub_length: sub ? sub.length : 0,
    sub_matches: !!sub && entries.includes(sub),
  };
}

type Vars = { userId: string };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
/**
 * Allowlisted Google account IDs: the `sub` field returned by Google tokeninfo for the user's access token.
 * Fails closed: unset, empty, or only separators/whitespace → nobody is allowed. Entries are matched exactly.
 */
export function allowedSubs(env: { ALLOWED_GOOGLE_SUBS?: string }): string[] {
  return String(env.ALLOWED_GOOGLE_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const SESSION_TTL_S = 30 * 24 * 3600;
const RETENTION_EVENTS_MS = 180 * 24 * 3600 * 1000;
const err = (c: C, code: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500, details?: unknown) =>
  c.json({ error: code, ...(details ? { details } : {}) }, status, { 'cache-control': 'no-store' });

const DEFAULT_PREFS: Preferences = {
  notify_open: true, notify_click: true, notify_first_only: true, include_suspected: false,
  quiet_start_min: null, quiet_end_min: null, timezone: 'UTC',
  store_subjects: false, store_addresses: false, disclosure_enabled: false, disclosure_text: null,
};

function configError(env: Env): string | null {
  if (!env.SESSION_SIGNING_KEY || env.SESSION_SIGNING_KEY.length < 32) return 'SESSION_SIGNING_KEY';
  if (!env.IP_HASH_SALT || env.IP_HASH_SALT.length < 16) return 'IP_HASH_SALT';
  if (!env.GOOGLE_CLIENT_ID) return 'GOOGLE_CLIENT_ID';
  if (!env.EXTENSION_ORIGIN?.startsWith('chrome-extension://')) return 'EXTENSION_ORIGIN';
  if (!/^https?:\/\/[^/]+$/.test(env.PUBLIC_BASE_URL ?? '')) return 'PUBLIC_BASE_URL';
  return null;
}

async function ipHash(env: Env, ip: string | null, now: number): Promise<string | null> {
  if (!ip) return null;
  const month = new Date(now).toISOString().slice(0, 7);   // salt rotates monthly → no long-term linking
  return (await hmacHex(`${env.IP_HASH_SALT}:${month}`, ip)).slice(0, 32);
}

/** Fixed-window counter in D1. Returns true if the request is allowed. */
async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number, now: number): Promise<boolean> {
  const window = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(
    'INSERT INTO api_rate_limits(key, window, hits) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET hits = hits + 1 RETURNING hits',
  ).bind(key, window).first<{ hits: number }>();
  return (row?.hits ?? 1) <= limit;
}

function boolish(v: unknown): v is boolean { return typeof v === 'boolean'; }

function validateRegister(b: unknown, prefs: Preferences): { ok: true; v: RegisterEmailRequest } | { ok: false; details: string[] } {
  const d: string[] = [];
  const o = (b ?? {}) as Record<string, unknown>;
  if (typeof o.client_request_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(o.client_request_id)) d.push('client_request_id');
  if (o.mode !== 'single' && o.mode !== 'individual_group') d.push('mode');
  if (o.subject !== null && (typeof o.subject !== 'string' || o.subject.length > LIMITS.maxSubject)) d.push('subject');
  if (o.subject !== null && !prefs.store_subjects) d.push('subject must be null unless store_subjects is enabled');
  for (const k of ['track_opens', 'track_clicks', 'disclosure_added'] as const) if (!boolish(o[k])) d.push(k);
  const rs = Array.isArray(o.recipients) ? o.recipients : null;
  if (!rs || rs.length < 1 || rs.length > LIMITS.maxRecipients) d.push('recipients count');
  if (rs && o.mode === 'single' && rs.length !== 1) d.push('single mode requires exactly 1 recipient');
  if (rs && o.mode === 'individual_group' && rs.length < 2) d.push('individual_group requires 2+ recipients');
  const keys = new Set<string>();
  for (const [i, r] of (rs ?? []).entries()) {
    const x = (r ?? {}) as Record<string, unknown>;
    if (typeof x.recipient_key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x.recipient_key)) d.push(`recipients[${i}].recipient_key`);
    else if (keys.has(x.recipient_key)) d.push(`recipients[${i}] duplicate`); else keys.add(x.recipient_key);
    if (x.original_field !== 'to' && x.original_field !== 'cc' && x.original_field !== 'bcc') d.push(`recipients[${i}].original_field`);
    if (x.address !== null && x.address !== undefined) {
      if (!prefs.store_addresses) d.push(`recipients[${i}].address must be null unless store_addresses is enabled`);
      else if (typeof x.address !== 'string' || x.address.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(x.address)) d.push(`recipients[${i}].address`);
    }
  }
  const ls = Array.isArray(o.links) ? o.links : null;
  if (!ls || ls.length > LIMITS.maxLinks) d.push('links count');
  const idx = new Set<number>();
  for (const [i, l] of (ls ?? []).entries()) {
    const x = (l ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(x.index) || (x.index as number) < 0 || idx.has(x.index as number)) d.push(`links[${i}].index`); else idx.add(x.index as number);
    if (!validateTargetUrl(x.url).ok) d.push(`links[${i}].url`);
  }
  return d.length ? { ok: false, details: d } : { ok: true, v: o as unknown as RegisterEmailRequest };
}

async function loadPrefs(db: D1Database, userId: string): Promise<Preferences> {
  const r = await db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').bind(userId).first<Record<string, unknown>>();
  if (!r) return { ...DEFAULT_PREFS };
  return {
    notify_open: !!r.notify_open, notify_click: !!r.notify_click, notify_first_only: !!r.notify_first_only,
    include_suspected: !!r.include_suspected, quiet_start_min: (r.quiet_start_min as number) ?? null, quiet_end_min: (r.quiet_end_min as number) ?? null,
    timezone: String(r.timezone ?? 'UTC'), store_subjects: !!r.store_subjects, store_addresses: !!r.store_addresses,
    disclosure_enabled: !!r.disclosure_enabled, disclosure_text: (r.disclosure_text as string) ?? null,
  };
}

function minutesInTz(now: number, tz: string): number {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    return Number(p.find((x) => x.type === 'hour')?.value) * 60 + Number(p.find((x) => x.type === 'minute')?.value);
  } catch { return new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes(); }
}
export function inQuietHours(prefs: Preferences, now: number): boolean {
  if (prefs.quiet_start_min === null || prefs.quiet_end_min === null) return false;
  const m = minutesInTz(now, prefs.timezone);
  const s = prefs.quiet_start_min, e = prefs.quiet_end_min;
  return s <= e ? m >= s && m < e : m >= s || m < e;
}

function statusLabel(r: { send_status: string; open_count: number; click_count: number }, suspectedOnly: boolean): StatusLabel {
  if (r.send_status !== 'sent') return 'not_sent';
  if (r.click_count > 0) return 'clicked';
  if (r.open_count > 0) return 'likely_opened';
  return suspectedOnly ? 'suspected_only' : 'sent';
}

export function createApp(deps: Deps) {
  /** Tracking-request diagnostics: never the token, IP, raw user agent, or any address. */
  const trackLog = (type: string, fields: Record<string, unknown>) =>
    (deps.log ?? ((l: string) => console.warn(l)))(`[tracklet-track] ${JSON.stringify({ type, ...fields })}`);
  const authLog = (stage: string, fields: Record<string, unknown> = {}) =>
    (deps.log ?? ((l: string) => console.warn(l)))(`[tracklet-auth] ${JSON.stringify({ stage, ...fields })}`);
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.onError((e, c) => {
    console.error('[tracklet] unhandled', e instanceof Error ? e.name : 'error');   // no request data logged
    return c.json({ error: 'internal' }, 500, { 'cache-control': 'no-store' });
  });

  app.get('/health', (c) => {
    const body: HealthResponse = { status: 'ok', service: 'tracklet-backend', version: c.env?.APP_VERSION ?? 'dev' };
    return c.json(body, 200, { 'cache-control': 'no-store' });
  });

  // ---------------- Public: open pixel ----------------
  app.on(['GET', 'HEAD'], '/o/:file', async (c) => {
    const headers = {
      'content-type': 'image/gif', 'content-length': String(GIF.length),
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0, private', expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
      'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff',
    };
    const token = c.req.param('file').replace(/\.gif$/, '');
    if (isTrackingToken(token)) c.executionCtx.waitUntil(recordEvent(c, 'open', token).catch(() => {}));
    return new Response(c.req.method === 'HEAD' ? null : GIF, { status: 200, headers });   // identical for unknown tokens
  });

  // ---------------- Public: click redirect ----------------
  app.on(['GET', 'HEAD'], '/c/:token', async (c) => {
    const token = c.req.param('token');
    const notFound = () => new Response('This link is unavailable.', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
    });
    if (!isTrackingToken(token)) return notFound();
    const row = await c.env.DB.prepare('SELECT target_url FROM tracked_links WHERE click_token = ?').bind(token).first<{ target_url: string }>();
    const target = row ? validateTargetUrl(row.target_url) : null;   // re-validated on the way out
    if (!target || !target.ok) return notFound();
    c.executionCtx.waitUntil(recordEvent(c, 'click', token).catch(() => {}));
    return new Response(null, { status: 302, headers: { location: target.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  });

  async function recordEvent(c: C, type: 'open' | 'click', token: string): Promise<void> {
    const db = c.env.DB;
    const now = deps.now();
    const day = Math.floor(now / 86_400_000);
    const cap = await db.prepare(
      'INSERT INTO token_daily_caps(token, day, hits) VALUES (?, ?, 1) ON CONFLICT(token, day) DO UPDATE SET hits = hits + 1 RETURNING hits',
    ).bind(token, day).first<{ hits: number }>();
    if ((cap?.hits ?? 1) > LIMITS.maxEventsPerTokenPerDay) { trackLog(type, { token_known: null, capped: true }); return; }   // log-flood protection

    const target = type === 'open'
      ? await db.prepare(`SELECT r.id AS recipient_id, r.email_id, r.sent_at, e.user_id, e.gmail_thread_id, NULL AS link_id, NULL AS link_index
                          FROM recipients r JOIN tracked_emails e ON e.id = r.email_id WHERE r.pixel_token = ?`).bind(token).first<Record<string, unknown>>()
      : await db.prepare(`SELECT r.id AS recipient_id, r.email_id, r.sent_at, e.user_id, e.gmail_thread_id, l.id AS link_id, l.link_index
                          FROM tracked_links l JOIN recipients r ON r.id = l.recipient_id JOIN tracked_emails e ON e.id = r.email_id
                          WHERE l.click_token = ?`).bind(token).first<Record<string, unknown>>();
    if (!target) { trackLog(type, { token_known: false }); return; }
    const recipientId = String(target.recipient_id);
    const ua = (c.req.header('user-agent') ?? '').slice(0, 128);
    const cf = (c.req.raw as unknown as { cf?: { country?: string; asn?: number } }).cf;
    const ipH = await ipHash(c.env, c.req.header('cf-connecting-ip') ?? null, now);
    const fam = uaFamily(ua);
    const sentAt = typeof target.sent_at === 'number' ? target.sent_at : null;

    const selfView = type === 'open' && target.gmail_thread_id
      ? await db.prepare('SELECT 1 AS x FROM sender_views WHERE user_id = ? AND gmail_thread_id = ? AND viewed_at BETWEEN ? AND ? LIMIT 1')
          .bind(target.user_id, target.gmail_thread_id, now - SELF_VIEW_WINDOW_MS, now + SELF_VIEW_WINDOW_MS).first()
      : null;
    const dup = await db.prepare(`SELECT 1 AS x FROM tracking_events WHERE recipient_id = ? AND type = ? AND occurred_at > ?
                                  AND IFNULL(ip_hash,'') = ? AND IFNULL(ua_family,'') = ? AND IFNULL(link_id,'') = ? LIMIT 1`)
      .bind(recipientId, type, now - DEDUPE_MS, ipH ?? '', fam, (target.link_id as string) ?? '').first();
    const burst = type === 'click'
      ? await db.prepare(`SELECT 1 AS x FROM tracking_events WHERE recipient_id = ? AND type = 'click' AND occurred_at > ? AND link_id <> ? LIMIT 1`)
          .bind(recipientId, now - CLICK_BURST_MS, target.link_id).first()
      : null;

    const cls = classify({
      type, method: c.req.method, ua, asn: typeof cf?.asn === 'number' ? cf.asn : null,
      msSinceSend: sentAt === null ? null : now - sentAt, selfViewNearby: !!selfView, duplicateRecent: !!dup, otherLinkClickedRecently: !!burst,
    });
    const counted = isCounted(cls);
    trackLog(type, { token_known: true, classification: cls, counted, ua_family: fam, ms_since_send: sentAt === null ? null : now - sentAt });
    const base = [target.user_id, target.email_id, recipientId] as const;
    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO tracking_events(id, user_id, email_id, recipient_id, link_id, type, classification, classifier_version, counted,
                  occurred_at, ms_since_send, http_method, ua_family, ua_truncated, ip_hash, country, asn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(ulid(now), ...base, target.link_id ?? null, type, cls, CLASSIFIER_VERSION, counted ? 1 : 0, now, sentAt === null ? null : now - sentAt,
          c.req.method, fam, ua || null, ipH, cf?.country ?? null, cf?.asn ?? null),
    ];
    if (counted && type === 'open') {
      stmts.push(db.prepare('UPDATE recipients SET open_count = open_count + 1, first_open_at = COALESCE(first_open_at, ?), last_open_at = ? WHERE id = ?').bind(now, now, recipientId));
    }
    if (counted && type === 'click') {
      stmts.push(db.prepare('UPDATE tracked_links SET click_count = click_count + 1, first_click_at = COALESCE(first_click_at, ?) WHERE id = ?').bind(now, target.link_id));
      stmts.push(db.prepare('UPDATE recipients SET click_count = click_count + 1 WHERE id = ?').bind(recipientId));
      const hasOpen = await db.prepare('SELECT first_open_at FROM recipients WHERE id = ?').bind(recipientId).first<{ first_open_at: number | null }>();
      if (!hasOpen?.first_open_at) {   // a human-likely click implies the message was opened
        stmts.push(db.prepare(`INSERT INTO tracking_events(id, user_id, email_id, recipient_id, link_id, type, classification, classifier_version, counted,
                    occurred_at, ms_since_send, http_method, ua_family, ua_truncated, ip_hash, country, asn) VALUES (?,?,?,?,NULL,'implied_open',?,?,1,?,?,?,?,?,?,?,?)`)
          .bind(ulid(now), ...base, cls, CLASSIFIER_VERSION, now, sentAt === null ? null : now - sentAt, c.req.method, fam, ua || null, ipH, cf?.country ?? null, cf?.asn ?? null));
        stmts.push(db.prepare('UPDATE recipients SET open_count = open_count + 1, first_open_at = COALESCE(first_open_at, ?), last_open_at = ? WHERE id = ?').bind(now, now, recipientId));
      }
    }
    await db.batch(stmts);
  }

  // ---------------- Private API (/v1) ----------------
  app.use('/v1/*', async (c, next) => {
    const missing = configError(c.env);
    if (missing) { console.error('[tracklet] misconfigured', missing); return err(c, 'internal', 500); }
    const origin = c.req.header('origin');
    if (origin && origin !== c.env.EXTENSION_ORIGIN) return err(c, 'forbidden', 403);
    if (c.req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': c.env.EXTENSION_ORIGIN, 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE',
        'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600', vary: 'origin' } });
    }
    const len = Number(c.req.header('content-length') ?? '0');
    if (len > LIMITS.maxBodyBytes) return err(c, 'too_large', 413);
    const now = deps.now();
    const ipH = await ipHash(c.env, c.req.header('cf-connecting-ip') ?? 'local', now);
    if (!(await rateLimit(c.env.DB, `ip:${ipH}`, LIMITS.apiRequestsPerMinute, 60_000, now))) return err(c, 'rate_limited', 429);
    await next();
    if (origin) { c.res.headers.set('access-control-allow-origin', c.env.EXTENSION_ORIGIN); c.res.headers.set('vary', 'origin'); }
    c.res.headers.set('cache-control', 'no-store');
  });

  async function readJson(c: C): Promise<unknown | typeof BAD> {
    const text = await c.req.text();
    if (text.length > LIMITS.maxBodyBytes) return BAD;
    try { return JSON.parse(text); } catch { return BAD; }
  }
  const BAD = Symbol('bad');

  app.post('/v1/auth/session', async (c) => {
    const body = await readJson(c);
    const tok = body !== BAD && typeof (body as { google_access_token?: unknown })?.google_access_token === 'string'
      ? (body as { google_access_token: string }).google_access_token : null;
    if (!tok || tok.length > 4096) return err(c, 'validation_failed', 400, ['google_access_token']);
    let info: Record<string, unknown>;
    try {
      const r = await deps.googleFetch(`${GOOGLE_TOKENINFO_URL}?access_token=${encodeURIComponent(tok)}`);
      if (r.status !== 200) { authLog('session:tokeninfo_rejected', { http_status: r.status }); return err(c, 'unauthorized', 401); }
      info = (await r.json()) as Record<string, unknown>;
    } catch { authLog('session:tokeninfo_unreachable'); return err(c, 'unauthorized', 401); }
    const scope = String(info.scope ?? '').split(' ');
    const sub = String(info.sub ?? '');
    const checks = {
      aud_matches: info.aud === c.env.GOOGLE_CLIENT_ID, email_verified: String(info.email_verified) === 'true',
      openid_scope: scope.includes('openid'), email_scope: scope.some((s) => s === 'email' || s.endsWith('/userinfo.email')), sub_present: !!sub,
    };
    if (!Object.values(checks).every(Boolean)) { authLog('session:token_claims_invalid', checks); return err(c, 'unauthorized', 401); }
    if (!allowedSubs(c.env).includes(sub)) { authLog('session:allowlist_denied', allowlistDiag(c.env, sub)); return err(c, 'forbidden', 403); }
    const now = deps.now();
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(sub).first<{ id: string }>();
    const userId = existing?.id ?? ulid(now);
    if (existing) await c.env.DB.prepare('UPDATE users SET email = ?, last_seen_at = ? WHERE id = ?').bind(String(info.email), now, userId).run();
    else await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO users(id, google_sub, email, created_at, last_seen_at) VALUES (?,?,?,?,?)').bind(userId, sub, String(info.email), now, now),
      c.env.DB.prepare('INSERT INTO notification_preferences(user_id, updated_at) VALUES (?, ?)').bind(userId, now),
    ]);
    const exp = Math.floor(now / 1000) + SESSION_TTL_S;
    const session = await signSession(c.env.SESSION_SIGNING_KEY, { sub: userId, iat: Math.floor(now / 1000), exp });
    authLog('session:issued', { allowlist_entries: allowedSubs(c.env).length, sub_matches: true, new_user: !existing });
    return c.json({ session_token: session, expires_at: exp * 1000, user: { id: userId, email: String(info.email) } });
  });

  // Session auth for everything else under /v1
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/auth/session') return next();
    const h = c.req.header('authorization') ?? '';
    const claims = h.startsWith('Bearer ') ? await verifySession(c.env.SESSION_SIGNING_KEY, h.slice(7), deps.now()) : null;
    if (!claims || !isUlid(claims.sub)) { authLog('request:session_invalid', { session_header_present: h.startsWith('Bearer ') }); return err(c, 'unauthorized', 401); }
    const user = await c.env.DB.prepare('SELECT google_sub FROM users WHERE id = ?').bind(claims.sub).first<{ google_sub: string }>();
    if (!user) { authLog('request:user_not_found'); return err(c, 'forbidden', 403); }
    if (!allowedSubs(c.env).includes(user.google_sub)) { authLog('request:allowlist_denied', allowlistDiag(c.env, user.google_sub)); return err(c, 'forbidden', 403); }   // re-checked every request
    c.set('userId', claims.sub);
    return next();
  });

  app.post('/v1/emails', async (c) => {
    const userId = c.get('userId');
    const now = deps.now();
    if (!(await rateLimit(c.env.DB, `user:${userId}:register`, LIMITS.registrationsPerHour, 3_600_000, now))) return err(c, 'rate_limited', 429);
    const body = await readJson(c);
    if (body === BAD) return err(c, 'validation_failed', 400, ['body']);
    const prefs = await loadPrefs(c.env.DB, userId);
    const v = validateRegister(body, prefs);
    if (!v.ok) return err(c, 'validation_failed', 400, v.details);
    const req = v.v;
    const existing = await c.env.DB.prepare('SELECT id FROM tracked_emails WHERE user_id = ? AND client_request_id = ?').bind(userId, req.client_request_id).first<{ id: string }>();
    if (existing) return c.json(await registeredView(c, existing.id), 200);   // idempotent replay

    const emailId = ulid(now);
    const stmts: D1PreparedStatement[] = [c.env.DB.prepare(
      `INSERT INTO tracked_emails(id, user_id, client_request_id, subject, mode, status, track_opens, track_clicks, disclosure_added, created_at)
       VALUES (?,?,?,?,?,'pending',?,?,?,?)`).bind(emailId, userId, req.client_request_id, req.subject, req.mode, req.track_opens ? 1 : 0, req.track_clicks ? 1 : 0, req.disclosure_added ? 1 : 0, now)];
    for (const r of req.recipients) {
      const rid = ulid(now);
      stmts.push(c.env.DB.prepare('INSERT INTO recipients(id, email_id, recipient_key, address, original_field, pixel_token) VALUES (?,?,?,?,?,?)')
        .bind(rid, emailId, r.recipient_key, r.address ?? null, r.original_field, randomToken()));
      if (req.track_clicks) for (const l of req.links) {
        stmts.push(c.env.DB.prepare('INSERT INTO tracked_links(id, email_id, recipient_id, click_token, link_index, target_url) VALUES (?,?,?,?,?,?)')
          .bind(ulid(now), emailId, rid, randomToken(), l.index, (validateTargetUrl(l.url) as { url: string }).url));
      }
    }
    await c.env.DB.batch(stmts);
    const why = trackingUrlProblem(`${c.env.PUBLIC_BASE_URL}/o/x.gif`);
    if (why) authLog('register:public_base_url_unreachable', { reason: why });   // the extension refuses to send these
    return c.json(await registeredView(c, emailId), 201);
  });

  async function registeredView(c: C, emailId: string) {
    const base = c.env.PUBLIC_BASE_URL;
    const email = await c.env.DB.prepare('SELECT track_opens FROM tracked_emails WHERE id = ?').bind(emailId).first<{ track_opens: number }>();
    const rs = await c.env.DB.prepare('SELECT id, recipient_key, pixel_token FROM recipients WHERE email_id = ? ORDER BY id').bind(emailId).all<{ id: string; recipient_key: string; pixel_token: string }>();
    const ls = await c.env.DB.prepare('SELECT recipient_id, link_index, click_token FROM tracked_links WHERE email_id = ? ORDER BY link_index').bind(emailId).all<{ recipient_id: string; link_index: number; click_token: string }>();
    return {
      email_id: emailId,
      recipients: rs.results.map((r) => ({
        recipient_id: r.id, recipient_key: r.recipient_key,
        pixel_url: email?.track_opens ? `${base}/o/${r.pixel_token}.gif` : null,
        links: ls.results.filter((l) => l.recipient_id === r.id).map((l) => ({ index: l.link_index, click_url: `${base}/c/${l.click_token}` })),
      })),
    };
  }

  app.patch('/v1/emails/:emailId/recipients/:recipientId', async (c) => {
    const userId = c.get('userId');
    const { emailId, recipientId } = c.req.param();
    if (!isUlid(emailId) || !isUlid(recipientId)) return err(c, 'not_found', 404);
    const body = await readJson(c);
    const b = (body === BAD ? {} : body) as Partial<PatchRecipientRequest>;
    if (!['sending', 'sent', 'failed'].includes(String(b.send_status))) return err(c, 'validation_failed', 400, ['send_status']);
    if (b.gmail_message_id !== undefined && (typeof b.gmail_message_id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(b.gmail_message_id))) return err(c, 'validation_failed', 400, ['gmail_message_id']);
    if (b.gmail_thread_id !== undefined && (typeof b.gmail_thread_id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(b.gmail_thread_id))) return err(c, 'validation_failed', 400, ['gmail_thread_id']);
    if (b.send_error !== undefined && (typeof b.send_error !== 'string' || b.send_error.length > 200)) return err(c, 'validation_failed', 400, ['send_error']);
    const r = await c.env.DB.prepare(`SELECT r.send_status, r.gmail_message_id FROM recipients r JOIN tracked_emails e ON e.id = r.email_id
                                      WHERE r.id = ? AND r.email_id = ? AND e.user_id = ?`).bind(recipientId, emailId, userId).first<{ send_status: string; gmail_message_id: string | null }>();
    if (!r) return err(c, 'not_found', 404);   // also covers other users' records (no existence leak)
    const allowed: Record<string, string[]> = { pending: ['sending', 'failed'], sending: ['sent', 'failed'], failed: ['sending'], sent: ['sent'] };
    if (!allowed[r.send_status]!.includes(b.send_status!)) return err(c, 'conflict', 409, [`${r.send_status} -> ${b.send_status}`]);
    if (r.send_status === 'sent') {
      if (b.gmail_message_id && b.gmail_message_id !== r.gmail_message_id) return err(c, 'conflict', 409, ['different gmail_message_id']);
    } else {
      const now = deps.now();
      const sentAt = b.send_status === 'sent' ? (Number.isFinite(b.sent_at) ? Math.min(b.sent_at!, now) : now) : null;
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE recipients SET send_status = ?, gmail_message_id = COALESCE(?, gmail_message_id), send_error = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?')
          .bind(b.send_status, b.gmail_message_id ?? null, b.send_status === 'failed' ? (b.send_error ?? 'failed') : null, sentAt, recipientId),
        c.env.DB.prepare('UPDATE tracked_emails SET gmail_thread_id = COALESCE(gmail_thread_id, ?), sent_at = COALESCE(sent_at, ?) WHERE id = ?')
          .bind(b.gmail_thread_id ?? null, sentAt, emailId),
      ]);
    }
    const agg = await c.env.DB.prepare(`SELECT SUM(send_status='sent') AS sent, SUM(send_status='failed') AS failed, SUM(send_status IN ('sending','pending')) AS open, COUNT(*) AS n
                                        FROM recipients WHERE email_id = ?`).bind(emailId).first<{ sent: number; failed: number; open: number; n: number }>();
    const status = agg!.open > 0 ? (agg!.sent + agg!.failed > 0 ? 'sending' : 'pending') : agg!.failed === 0 ? 'sent' : agg!.sent === 0 ? 'failed' : 'partial';
    await c.env.DB.prepare('UPDATE tracked_emails SET status = ? WHERE id = ?').bind(status, emailId).run();
    return c.json({ email_status: status });
  });

  app.get('/v1/emails', async (c) => {
    const userId = c.get('userId');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 25) || 25, 1), 100);
    const cursor = c.req.query('cursor');
    const filter = c.req.query('filter') ?? 'all';
    if (cursor && !isUlid(cursor)) return err(c, 'validation_failed', 400, ['cursor']);
    const where = { all: '', opened: 'AND opened > 0', unopened: 'AND opened = 0', clicked: 'AND clicks > 0' }[filter as 'all'];
    if (where === undefined) return err(c, 'validation_failed', 400, ['filter']);
    const rows = await c.env.DB.prepare(`SELECT * FROM (
        SELECT e.id AS email_id, e.subject, e.mode, e.status, e.created_at, e.sent_at, e.gmail_thread_id,
          COUNT(r.id) AS recipients, SUM(r.open_count > 0) AS opened, SUM(r.click_count) AS clicks,
          (SELECT MAX(occurred_at) FROM tracking_events t WHERE t.email_id = e.id AND t.counted = 1) AS last_activity_at
        FROM tracked_emails e LEFT JOIN recipients r ON r.email_id = e.id
        WHERE e.user_id = ? AND (? IS NULL OR e.id < ?) GROUP BY e.id) WHERE 1=1 ${where} ORDER BY email_id DESC LIMIT ?`)
      .bind(userId, cursor ?? null, cursor ?? null, limit + 1).all<Record<string, unknown>>();
    const items = rows.results.slice(0, limit).map((r) => ({
      email_id: r.email_id, subject: r.subject ?? null, mode: r.mode, status: r.status, created_at: r.created_at, sent_at: r.sent_at ?? null,
      gmail_thread_id: r.gmail_thread_id ?? null, recipients: Number(r.recipients), opened_recipients: Number(r.opened ?? 0),
      clicks: Number(r.clicks ?? 0), last_activity_at: r.last_activity_at ?? null,
    }));
    return c.json({ items, next_cursor: rows.results.length > limit ? items[items.length - 1]!.email_id : null });
  });

  app.get('/v1/emails/:emailId', async (c) => {
    const userId = c.get('userId');
    const emailId = c.req.param('emailId');
    if (!isUlid(emailId)) return err(c, 'not_found', 404);
    const e = await c.env.DB.prepare('SELECT * FROM tracked_emails WHERE id = ? AND user_id = ?').bind(emailId, userId).first<Record<string, unknown>>();
    if (!e) return err(c, 'not_found', 404);
    const includeSuspected = c.req.query('include_suspected') !== 'false';
    const rs = await c.env.DB.prepare('SELECT * FROM recipients WHERE email_id = ? ORDER BY id').bind(emailId).all<Record<string, unknown>>();
    const ev = await c.env.DB.prepare(`SELECT t.id, t.type, t.recipient_id, t.classification, t.counted, t.occurred_at, t.ua_family, t.country, l.link_index
                                       FROM tracking_events t LEFT JOIN tracked_links l ON l.id = t.link_id WHERE t.email_id = ? ${includeSuspected ? '' : 'AND t.counted = 1'}
                                       ORDER BY t.id DESC LIMIT 200`).bind(emailId).all<Record<string, unknown>>();
    const links = await c.env.DB.prepare(`SELECT link_index, MIN(target_url) AS url, SUM(click_count) AS clicks, SUM(click_count > 0) AS unique_recipients
                                          FROM tracked_links WHERE email_id = ? GROUP BY link_index ORDER BY link_index`).bind(emailId).all<Record<string, unknown>>();
    const suspectedByRecipient = new Map<string, number>();
    for (const x of ev.results) if (!x.counted) suspectedByRecipient.set(String(x.recipient_id), (suspectedByRecipient.get(String(x.recipient_id)) ?? 0) + 1);
    const recipients = rs.results.map((r) => ({
      recipient_id: r.id, recipient_key: r.recipient_key, address: r.address ?? null, original_field: r.original_field,
      send_status: r.send_status, send_error: r.send_error ?? null, sent_at: r.sent_at ?? null,
      open_count: Number(r.open_count), first_open_at: r.first_open_at ?? null, last_open_at: r.last_open_at ?? null, click_count: Number(r.click_count),
      status_label: statusLabel(r as { send_status: string; open_count: number; click_count: number }, (suspectedByRecipient.get(String(r.id)) ?? 0) > 0),
    }));
    return c.json({
      email_id: e.id, subject: e.subject ?? null, mode: e.mode, status: e.status, created_at: e.created_at, sent_at: e.sent_at ?? null, gmail_thread_id: e.gmail_thread_id ?? null,
      totals: {
        recipients: recipients.length, sent_recipients: recipients.filter((r) => r.send_status === 'sent').length,
        opened_recipients: recipients.filter((r) => r.open_count > 0).length, opens: recipients.reduce((s, r) => s + r.open_count, 0),
        clicks: recipients.reduce((s, r) => s + r.click_count, 0), suspected_events: ev.results.filter((x) => !x.counted).length,
      },
      recipients,
      links: links.results.map((l) => ({ index: l.link_index, url: l.url, clicks: Number(l.clicks ?? 0), unique_recipients: Number(l.unique_recipients ?? 0) })),
      events: ev.results.map((x) => ({ id: x.id, type: x.type, recipient_id: x.recipient_id, link_index: x.link_index ?? null, classification: x.classification,
        counted: !!x.counted, occurred_at: x.occurred_at, ua_family: x.ua_family ?? null, country: x.country ?? null })),
    });
  });

  app.delete('/v1/emails/:emailId', async (c) => {
    const userId = c.get('userId');
    const emailId = c.req.param('emailId');
    if (!isUlid(emailId)) return err(c, 'not_found', 404);
    const r = await c.env.DB.prepare('DELETE FROM tracked_emails WHERE id = ? AND user_id = ?').bind(emailId, userId).run();
    if (!r.meta.changes) return err(c, 'not_found', 404);
    return c.body(null, 204);
  });

  app.delete('/v1/me/data', async (c) => {
    const userId = c.get('userId');
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM tracked_emails WHERE user_id = ?').bind(userId),
      c.env.DB.prepare('DELETE FROM sender_views WHERE user_id = ?').bind(userId),
    ]);
    return c.body(null, 204);
  });

  app.get('/v1/events', async (c) => {
    const userId = c.get('userId');
    const since = c.req.query('since');
    if (since && !isUlid(since)) return err(c, 'validation_failed', 400, ['since']);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 200);
    const rows = await c.env.DB.prepare(`SELECT t.id, t.type, t.email_id, t.recipient_id, t.classification, t.counted, t.occurred_at, t.ua_family, t.country, l.link_index
                                         FROM tracking_events t LEFT JOIN tracked_links l ON l.id = t.link_id
                                         WHERE t.user_id = ? AND (? IS NULL OR t.id > ?) ORDER BY t.id ASC LIMIT ?`)
      .bind(userId, since ?? null, since ?? null, limit + 1).all<Record<string, unknown>>();
    const prefs = await loadPrefs(c.env.DB, userId);
    const quiet = inQuietHours(prefs, deps.now());
    const page = rows.results.slice(0, limit);
    const events = [];
    for (const x of page) {
      let notify = !quiet && (!!x.counted || prefs.include_suspected) && x.classification !== 'duplicate' && x.classification !== 'self_suspected';
      if (x.type === 'implied_open') notify = false;   // the click that implied it is already notified
      if (x.type === 'open') notify &&= prefs.notify_open;
      if (x.type === 'click') notify &&= prefs.notify_click;
      if (notify && prefs.notify_first_only && x.type !== 'click') {
        const earlier = await c.env.DB.prepare(`SELECT 1 AS x FROM tracking_events WHERE recipient_id = ? AND counted = 1 AND type IN ('open','implied_open') AND id < ? LIMIT 1`)
          .bind(x.recipient_id, x.id).first();
        notify = !earlier;
      }
      events.push({ id: x.id, type: x.type, email_id: x.email_id, recipient_id: x.recipient_id, link_index: x.link_index ?? null,
        classification: x.classification, counted: !!x.counted, occurred_at: x.occurred_at, ua_family: x.ua_family ?? null, country: x.country ?? null, notify });
    }
    return c.json({ events, next_cursor: page.length ? page[page.length - 1]!.id : since ?? null, more: rows.results.length > limit });
  });

  app.get('/v1/dashboard', async (c) => {
    const userId = c.get('userId');
    const range = c.req.query('range') ?? '30d';
    const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
    if (!days) return err(c, 'validation_failed', 400, ['range']);
    const from = deps.now() - days * 86_400_000;
    const t = await c.env.DB.prepare(`SELECT COUNT(DISTINCT e.id) AS emails, COUNT(r.id) AS recipients, SUM(r.send_status='sent') AS sent_recipients,
                                      SUM(r.open_count > 0) AS opened, SUM(r.click_count) AS clicks, SUM(r.click_count > 0) AS clicked
                                      FROM tracked_emails e LEFT JOIN recipients r ON r.email_id = e.id WHERE e.user_id = ? AND e.created_at >= ?`)
      .bind(userId, from).first<Record<string, number | null>>();
    const suspected = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM tracking_events WHERE user_id = ? AND counted = 0 AND occurred_at >= ?').bind(userId, from).first<{ n: number }>();
    const sentR = Number(t?.sent_recipients ?? 0);
    return c.json({
      range,
      totals: {
        emails_sent: Number(t?.emails ?? 0), recipients: Number(t?.recipients ?? 0), sent_recipients: sentR,
        opened_recipients: Number(t?.opened ?? 0), clicks: Number(t?.clicks ?? 0), clicked_recipients: Number(t?.clicked ?? 0),
        // rates only when there is a denominator; never fabricated
        open_rate: sentR ? Number(t?.opened ?? 0) / sentR : null, click_rate: sentR ? Number(t?.clicked ?? 0) / sentR : null,
        suspected_events: Number(suspected?.n ?? 0),
      },
      accuracy_note: 'Open rates include proxy-loaded opens and exclude suspected automated events. Opens are estimates.',
    });
  });

  app.get('/v1/threads/status', async (c) => {
    const userId = c.get('userId');
    const ids = (c.req.query('ids') ?? '').split(',').filter((x) => /^[A-Za-z0-9]{1,64}$/.test(x)).slice(0, 50);
    const out: Record<string, unknown> = {};
    for (const id of ids) {
      const r = await c.env.DB.prepare(`SELECT e.id AS email_id, COUNT(r.id) AS recipients, SUM(r.open_count > 0) AS opened, SUM(r.click_count) AS clicks
                                        FROM tracked_emails e JOIN recipients r ON r.email_id = e.id WHERE e.user_id = ? AND e.gmail_thread_id = ? GROUP BY e.id ORDER BY e.id DESC LIMIT 1`)
        .bind(userId, id).first<Record<string, number | string>>();
      if (r) out[id] = { email_id: r.email_id, recipients: Number(r.recipients), opened_recipients: Number(r.opened ?? 0),
        label: Number(r.clicks ?? 0) > 0 ? 'clicked' : Number(r.opened ?? 0) > 0 ? 'likely_opened' : 'sent' };
    }
    return c.json(out);
  });

  app.post('/v1/views', async (c) => {
    const userId = c.get('userId');
    const body = await readJson(c);
    const tid = body !== BAD ? (body as { gmail_thread_id?: unknown }).gmail_thread_id : null;
    if (typeof tid !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(tid)) return err(c, 'validation_failed', 400, ['gmail_thread_id']);
    const now = deps.now();
    if (!(await rateLimit(c.env.DB, `user:${userId}:view:${tid}`, 1, 10_000, now))) return c.body(null, 204);
    const stmts = [c.env.DB.prepare('INSERT INTO sender_views(id, user_id, gmail_thread_id, viewed_at) VALUES (?,?,?,?)').bind(ulid(now), userId, tid, now)];
    // Retroactively reclassify counted opens within the window as self-opens and reverse their counters.
    const opens = await c.env.DB.prepare(`SELECT t.id, t.recipient_id FROM tracking_events t JOIN tracked_emails e ON e.id = t.email_id
                                          WHERE e.user_id = ? AND e.gmail_thread_id = ? AND t.type = 'open' AND t.counted = 1 AND t.occurred_at BETWEEN ? AND ?`)
      .bind(userId, tid, now - SELF_VIEW_WINDOW_MS, now + SELF_VIEW_WINDOW_MS).all<{ id: string; recipient_id: string }>();
    for (const o of opens.results) {
      stmts.push(c.env.DB.prepare("UPDATE tracking_events SET classification = 'self_suspected', counted = 0 WHERE id = ?").bind(o.id));
      stmts.push(c.env.DB.prepare('UPDATE recipients SET open_count = MAX(open_count - 1, 0) WHERE id = ?').bind(o.recipient_id));
    }
    await c.env.DB.batch(stmts);
    for (const rid of new Set(opens.results.map((o) => o.recipient_id))) {
      await c.env.DB.prepare(`UPDATE recipients SET first_open_at = (SELECT MIN(occurred_at) FROM tracking_events WHERE recipient_id = ? AND counted = 1 AND type IN ('open','implied_open')),
                              last_open_at = (SELECT MAX(occurred_at) FROM tracking_events WHERE recipient_id = ? AND counted = 1 AND type IN ('open','implied_open')) WHERE id = ?`)
        .bind(rid, rid, rid).run();
    }
    return c.body(null, 204);
  });

  app.get('/v1/preferences', async (c) => c.json(await loadPrefs(c.env.DB, c.get('userId'))));

  app.put('/v1/preferences', async (c) => {
    const userId = c.get('userId');
    const body = await readJson(c);
    if (body === BAD) return err(c, 'validation_failed', 400, ['body']);
    const b = body as Record<string, unknown>;
    const d: string[] = [];
    for (const k of ['notify_open', 'notify_click', 'notify_first_only', 'include_suspected', 'store_subjects', 'store_addresses', 'disclosure_enabled']) if (!boolish(b[k])) d.push(k);
    for (const k of ['quiet_start_min', 'quiet_end_min']) if (b[k] !== null && !(Number.isInteger(b[k]) && (b[k] as number) >= 0 && (b[k] as number) < 1440)) d.push(k);
    try { new Intl.DateTimeFormat('en', { timeZone: String(b.timezone) }); } catch { d.push('timezone'); }
    if (b.disclosure_text !== null && (typeof b.disclosure_text !== 'string' || b.disclosure_text.length > 200)) d.push('disclosure_text');
    if (d.length) return err(c, 'validation_failed', 400, d);
    await c.env.DB.prepare(`INSERT INTO notification_preferences(user_id, notify_open, notify_click, notify_first_only, include_suspected, quiet_start_min, quiet_end_min,
                            timezone, store_subjects, store_addresses, disclosure_enabled, disclosure_text, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                            ON CONFLICT(user_id) DO UPDATE SET notify_open=excluded.notify_open, notify_click=excluded.notify_click, notify_first_only=excluded.notify_first_only,
                            include_suspected=excluded.include_suspected, quiet_start_min=excluded.quiet_start_min, quiet_end_min=excluded.quiet_end_min, timezone=excluded.timezone,
                            store_subjects=excluded.store_subjects, store_addresses=excluded.store_addresses, disclosure_enabled=excluded.disclosure_enabled,
                            disclosure_text=excluded.disclosure_text, updated_at=excluded.updated_at`)
      .bind(userId, +b.notify_open!, +b.notify_click!, +b.notify_first_only!, +b.include_suspected!, b.quiet_start_min ?? null, b.quiet_end_min ?? null,
        String(b.timezone), +b.store_subjects!, +b.store_addresses!, +b.disclosure_enabled!, b.disclosure_text ?? null, deps.now()).run();
    if (c.req.query('purge') === 'true') {
      if (!b.store_subjects) await c.env.DB.prepare('UPDATE tracked_emails SET subject = NULL WHERE user_id = ?').bind(userId).run();
      if (!b.store_addresses) await c.env.DB.prepare('UPDATE recipients SET address = NULL WHERE email_id IN (SELECT id FROM tracked_emails WHERE user_id = ?)').bind(userId).run();
    }
    return c.json(await loadPrefs(c.env.DB, userId));
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

/** Daily retention (cron). */
export async function runRetention(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM tracking_events WHERE occurred_at < ?').bind(now - RETENTION_EVENTS_MS),
    db.prepare('DELETE FROM sender_views WHERE viewed_at < ?').bind(now - 86_400_000),
    db.prepare('DELETE FROM token_daily_caps WHERE day < ?').bind(Math.floor(now / 86_400_000) - 2),
    db.prepare('DELETE FROM api_rate_limits WHERE window < ?').bind(now - 2 * 3_600_000),
  ]);
}
