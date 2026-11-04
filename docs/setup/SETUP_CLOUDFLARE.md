# CHECKLIST — Cloudflare account and workers.dev subdomain (performed by you)

Claude does **not** perform these steps. Facts are cited from `docs/design/VERIFIED_PLATFORM_FACTS.md` §5.

## A. Create the account
1. Go to https://dash.cloudflare.com/sign-up.
   - Use an email you control. It doesn't have to be the tracking Gmail account.
   - Enable **two-factor authentication** immediately: My Profile → Authentication.
2. Choose the **Free** plan for Workers. Do **not** add a payment method; the Free plan doesn't need one.
3. You do not need to add a website or domain. A custom domain comes later (D3).

## B. Choose the workers.dev account subdomain (visible to every recipient)
1. Go to **Workers & Pages → Overview**. If this is the first visit, the dashboard asks for a subdomain; otherwise click **Change** next to "Your subdomain" (W-j).
2. Rules for a **neutral** subdomain (Q10):
   - It must not contain your name, company or email.
   - It must not imitate Google, Gmail, Mailtrack, Mailsuite or any brand.
   - Use lowercase letters, digits and hyphens. Example pattern: `lnk-<random-6-chars>` (e.g. `lnk-q7x2m4`).
3. ☐ Record the subdomain: `________________.workers.dev`
4. Planned Worker name, which becomes part of the URL: `t`. URL: `https://t.<subdomain>.workers.dev` (W-j).

## C. Account-level settings
1. ☐ Note the **Account ID** (Workers & Pages → right sidebar). It is not a secret.
2. Do **not** create an API token yet. In Phase 0, `wrangler login` uses a browser OAuth login. A scoped API token is created only if CI deployment is ever needed.
3. Do **not** create D1 databases or Workers manually. Phase 0 does that with `wrangler` after approval.

## D. Limits to be aware of (Free) (W-a … W-g)
| Limit | Value | Our expected use |
|---|---|---|
| Worker requests | 100,000/day (Error 1027 or bypass when exceeded) | < 2,000/day |
| CPU per request | 10 ms | < 5 ms target |
| `waitUntil` after response | ≤ 30 s | < 100 ms |
| Cron Triggers | 5 per account | 1 |
| D1 database size | 500 MB | ~50 MB at 180-day retention |
| D1 rows read / written | 5M / 100k per day | ~20k / ~3k |
| D1 queries per invocation | 50 (a batch = 1) | ≤ 5 |

## E. Hand-off to Claude (safe to share)
- The workers.dev subdomain
- The Account ID

Never share passwords, 2FA codes or API tokens.

## F. Things you must NOT do
- ☐ Do not deploy anything, and do not paste code from elsewhere into the dashboard editor.
- ☐ Do not enable paid add-ons (Workers Paid, Logpush, etc.).

## G. Production deployment (after sections A–C, with your approval)

Everything stays on the Free plan. Run all commands from the repository root unless a step says otherwise.

1. **Log in:** run `cd backend`, then `npx wrangler login` (this opens the browser).
2. **Create the database:** `npx wrangler d1 create tracklet`. Copy the printed `database_id` into `backend/wrangler.toml` under `[[env.production.d1_databases]]`.
3. **Set the public URL:** in `backend/wrangler.toml`, under `[env.production.vars]`, set `PUBLIC_BASE_URL = "https://t.<your-subdomain>.workers.dev"`. Use no trailing slash; the first label comes from `name` in `[env.production]`.
4. **Apply the schema:** `npm run db:migrate:prod --workspace backend`.
5. **Set the secrets.** You'll be prompted for each value; they are never written to disk or Git:
   ```sh
   cd backend
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # use one output per secret
   npx wrangler secret put SESSION_SIGNING_KEY --env production
   npx wrangler secret put IP_HASH_SALT --env production
   npx wrangler secret put ALLOWED_GOOGLE_SUBS --env production   # your Google account ID (README step 6)
   ```
6. **Configure the extension:** create `extension/.env.release.local` (gitignored) containing:
   ```
   TRACKLET_OAUTH_CLIENT_ID=<same as GOOGLE_CLIENT_ID in wrangler.toml>
   TRACKLET_API_BASE=https://t.<your-subdomain>.workers.dev
   ```
7. **Check:** `npm run preflight` must print `preflight: ready`. It rejects placeholders, http or local URLs, an extension ID mismatch, and a client ID mismatch.
8. **Deploy:** `npm run deploy --workspace backend`. This runs the backend preflight first, then `wrangler deploy --env production`.
9. **Verify:** `curl https://t.<your-subdomain>.workers.dev/health` should return `{"status":"ok",…}`.
10. **Build the extension:** `npm run release`. This runs check + preflight + release build. Then reload `extension/dist` in `chrome://extensions`.
11. **Smoke test:** send one tracked email to an address you own and open it. The dashboard should show 1 opened within about a minute. Watch the live logs with `npx wrangler tail --env production` (in `backend/`); `[tracklet-track]` lines confirm pixel requests, and they never contain tokens or addresses.

**Rollback:** run `npx wrangler rollback --env production` (in `backend/`). The extension keeps working against the previous Worker version.
**Revoke access immediately:** remove an ID with `npx wrangler secret put ALLOWED_GOOGLE_SUBS --env production`. Every request re-checks the allowlist.
