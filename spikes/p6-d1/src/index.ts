// SPIKE P6 (throwaway): one D1 batch per request = event insert + counter update.
// Local only (wrangler dev --local). Never deployed.
interface Env { DB: D1Database }

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/seed') {
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO users(id,google_sub,email,created_at) VALUES('u1','sub1','me@example.test',?)").bind(now),
        env.DB.prepare("INSERT OR IGNORE INTO tracked_emails(id,user_id,client_request_id,mode,created_at) VALUES('e1','u1','c1','single',?)").bind(now),
        env.DB.prepare("INSERT OR IGNORE INTO recipients(id,email_id,recipient_key,original_field,pixel_token) VALUES('r1','e1','k1','to','tok1')"),
      ]);
      return json({ ok: true });
    }
    if (url.pathname === '/event') {
      const counted = url.searchParams.get('counted') === '1' ? 1 : 0;
      const cls = counted ? 'proxy_open' : 'prefetch_suspected';
      const id = crypto.randomUUID();
      const now = Date.now();
      const t0 = performance.now();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO tracking_events(id,user_id,email_id,recipient_id,type,classification,classifier_version,counted,occurred_at)
                        VALUES(?, 'u1','e1','r1','open',?,1,?,?)`).bind(id, cls, counted, now),
        env.DB.prepare(`UPDATE recipients SET open_count = open_count + ?, first_open_at = COALESCE(first_open_at, CASE WHEN ?=1 THEN ? END),
                        last_open_at = CASE WHEN ?=1 THEN ? ELSE last_open_at END WHERE id='r1'`).bind(counted, counted, now, counted, now),
      ]);
      return json({ ok: true, ms: performance.now() - t0 });
    }
    if (url.pathname === '/bad') {
      // constraint check: invalid classification must be rejected
      try {
        await env.DB.prepare(`INSERT INTO tracking_events(id,user_id,email_id,recipient_id,type,classification,classifier_version,counted,occurred_at)
                              VALUES('bad','u1','e1','r1','open','bogus',1,0,0)`).run();
        return json({ rejected: false });
      } catch (e) { return json({ rejected: true, error: String(e).slice(0, 120) }); }
    }
    if (url.pathname === '/stats') {
      const r = await env.DB.prepare(`SELECT (SELECT open_count FROM recipients WHERE id='r1') AS counter,
              (SELECT count(*) FROM tracking_events WHERE counted=1) AS counted_events,
              (SELECT count(*) FROM tracking_events) AS all_events`).first();
      return json(r);
    }
    return json({ error: 'not_found' }, 404);
  },
};
