// SPIKE P6.3–P6.6 (throwaway): temporary DEV Worker. Synthetic data only.
// - Pixel route accepts ONLY synthetic tokens ("syn-…"); everything else is a 404.
// - /rl and /stats require the SPIKE_KEY secret header; /stats never returns raw rows.
// - Hard expiry: after EXPIRES_AT every route returns 410 (delete the Worker anyway, see README).
interface RateLimit { limit(o: { key: string }): Promise<{ success: boolean }> }
interface Env {
  DB: D1Database;
  RL?: RateLimit;          // optional: binding availability on the Free plan is what P6.3 tests
  SPIKE_KEY?: string;      // set with `wrangler secret put SPIKE_KEY`
  EXPIRES_AT: string;      // ISO date
}

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const SYN_TOKEN = /^syn-[A-Za-z0-9_-]{6,32}$/;
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function authorized(req: Request, env: Env): boolean {
  const k = req.headers.get('x-spike-key');
  if (!env.SPIKE_KEY || !k) return false;
  const a = new TextEncoder().encode(k);
  const b = new TextEncoder().encode(env.SPIKE_KEY);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (Date.now() > Date.parse(env.EXPIRES_AT)) return json({ error: 'expired' }, 410);
    const url = new URL(req.url);

    if (url.pathname === '/health') return json({ status: 'ok', spike: 'p6-dev', expires: env.EXPIRES_AT });

    const m = url.pathname.match(/^\/o\/([^/]+)\.gif$/);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const token = m[1]!;
      if (!SYN_TOKEN.test(token)) return new Response('not found', { status: 404 });
      const receivedAt = Date.now();
      // P6.5: write AFTER the response via waitUntil
      ctx.waitUntil(
        env.DB.prepare('INSERT INTO spike_hits(id, token, method, received_at, written_at) VALUES (?,?,?,?,?)')
          .bind(crypto.randomUUID(), token, req.method, receivedAt, Date.now()).run(),
      );
      return new Response(req.method === 'HEAD' ? null : GIF, {
        headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0, private', 'referrer-policy': 'no-referrer' },
      });
    }

    if (url.pathname === '/rl') {
      if (!authorized(req, env)) return json({ error: 'forbidden' }, 403);
      if (!env.RL) return json({ binding: 'absent' }, 501);
      const key = (url.searchParams.get('key') ?? 'k').slice(0, 32);
      const { success } = await env.RL.limit({ key });
      return json({ binding: 'present', success }, success ? 200 : 429);
    }

    if (url.pathname === '/stats') {
      if (!authorized(req, env)) return json({ error: 'forbidden' }, 403);
      const r = await env.DB.prepare(
        `SELECT count(*) AS hits, count(DISTINCT token) AS tokens, max(written_at - received_at) AS max_write_lag_ms,
                avg(written_at - received_at) AS avg_write_lag_ms FROM spike_hits WHERE token = ?`,
      ).bind(url.searchParams.get('token') ?? '').first();
      return json(r);
    }

    return new Response('not found', { status: 404 });
  },
};
