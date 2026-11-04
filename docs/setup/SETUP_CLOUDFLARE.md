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
