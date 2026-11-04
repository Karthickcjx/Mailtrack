# P6 temporary dev Worker (P6.3–P6.6)

**Status: prepared, NOT deployed.** Deploy only after you confirm that the Cloudflare account is ready (docs/setup/SETUP_CLOUDFLARE.md).
This is a dev spike, not production. It uses synthetic data only (`syn-*` tokens; anything else returns 404).

| Safety control | How |
|---|---|
| Synthetic data only | Pixel route rejects non-`syn-` tokens; the DB CHECK constraint enforces `token LIKE 'syn-%'` |
| No raw request data stored | Only token, method and timestamps; no IP, UA or headers |
| Guarded endpoints | `/rl` and `/stats` require `x-spike-key` (constant-time compare); `/stats` returns aggregates only |
| Rate limiting | `[[ratelimits]]` binding `RL`, 5 req / 10 s per key per location (what P6.3 tests) |
| Kill switch | `EXPIRES_AT` = 2026-11-17: every route returns 410 afterwards |
| No preview URLs | `preview_urls = false` |
| Cleanup | Steps C1–C4 below; target: everything deleted the same day |

Local verification already done (2026-11-03, `wrangler dev --local`): see spikes/RESULTS.md P6 "local rehearsal".

## Deploy (run by Claude only after your go-ahead; commands shown for transparency)
All commands run from `spikes/p6-dev-worker/`, using the repo's wrangler (`../../node_modules/.bin/wrangler`).
1. `wrangler login`. This opens a browser; **you** approve the Cloudflare OAuth prompt.
2. `wrangler whoami`. Confirm the account and that the workers.dev subdomain is the neutral one.
3. `wrangler d1 create tracklet-dev-spike`, then copy the printed `database_id` into `wrangler.toml`. Don't commit the real ID; restore the placeholder at cleanup.
4. `wrangler d1 migrations apply tracklet-dev-spike --remote`
5. `wrangler secret put SPIKE_KEY`, pasting a fresh random value (e.g. `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`). Never commit it.
6. `wrangler deploy`. If the `ratelimits` binding is rejected on the Free plan, **that is the P6.3 result**. Record the error, comment out the `[[ratelimits]]` block, and redeploy. The Worker returns 501 `binding: absent` on `/rl`.

## Tests
| Test | Command | Pass criteria |
|---|---|---|
| P6.6 URL + certificate | `curl -sv https://t-dev-spike.<subdomain>.workers.dev/health 2>&1 \| grep -E "subject:\|issuer:\|HTTP/"` | 200 with a valid certificate for `*.<subdomain>.workers.dev` |
| P6.4 latency | `SPIKE_KEY=… node ../p6-dev-worker/loadtest.mjs https://t-dev-spike.<subdomain>.workers.dev 200` | p95 < 100 ms (from your network). Check CPU time in the dashboard (Workers → t-dev-spike → Metrics): < 5 ms |
| P6.5 `waitUntil` | same output: `allRowsWritten: true` | 200/200 rows |
| P6.3 rate limit | same output: `rateLimitStatuses` | Binding accepted at deploy, then 200×5 followed by 429. Binding rejected = RECORDED (Free-plan limitation; fallback D1 counter) |
| Guard | `statsWithoutKeyStatus: 403`, `nonSyntheticTokenStatus: 404` | Both as stated |

## Cleanup (same day)
- C1 `wrangler delete --name t-dev-spike`
- C2 `wrangler d1 delete tracklet-dev-spike`
- C3 Restore the placeholder `database_id` in `wrangler.toml`; confirm `git diff` is clean.
- C4 Dashboard check: Workers & Pages shows no `t-dev-spike`; D1 shows no `tracklet-dev-spike`.
