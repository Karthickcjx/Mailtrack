# VERIFIED PLATFORM FACTS (checked 2026-11-03 against official documentation)

Everything here was read from the cited official page on 2026-11-03. Each item is marked:
- **Verified**: stated on the page.
- **Not stated**: the page doesn't cover it; it stays an assumption or a prototype item.
- **Inference**: my conclusion from verified statements.

Platform docs change. Re-check before each phase that depends on a fact.

---

## 1. Google OAuth

Sources:
- G1 https://developers.google.com/identity/protocols/oauth2
- G2 https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow
- G3 https://developers.google.com/identity/protocols/oauth2/web-server
- G4 https://developers.google.com/identity/protocols/oauth2/native-app

| # | Fact | Status | Source |
|---|---|---|---|
| O1 | The implicit flow "is considered insecure for browser-based single-page applications", "is provided only for legacy support and troubleshooting", and interacting with it directly "is strongly discouraged"; modern apps "should use the Authorization Code flow with PKCE instead." | Verified | G2 |
| O2 | The implicit-flow response carries `access_token` and `expires_in` (example 3600 s) in the URL fragment; no refresh token is described for `response_type=token`. `prompt=none` and `login_hint` are documented parameters. | Verified | G2 |
| O3 | The Web application client type is for "server-side or JavaScript web apps. Don't use this application type for any other application, such as native or mobile apps." | Verified | G1 |
| O4 | Whether a Web application client can exchange a code with PKCE and **no** client secret | Not stated | G3 |
| O5 | "For Chrome extensions, use the Chrome Extension application type." Client types include Android, Chrome Extension, iOS, Desktop app, Web application, TVs/limited input. | Verified | G1 |
| O6 | "The client_secret is not applicable to requests from clients registered as Android, iOS, or Chrome applications." | Verified | G4 |
| O7 | Desktop apps "are public clients and cannot keep secrets confidential. Always use PKCE". Custom URI schemes are no longer supported. Loopback redirect is deprecated for Android, Chrome app and iOS client types. | Verified | G4 |
| O8 | **Testing-mode expiry:** an External project in "Testing" "is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile (userinfo.email, userinfo.profile, openid…)". Because we request `gmail.send`, **the 7-day expiry applies to us.** | Verified | G1 |
| O9 | Other refresh-token invalidation: user revoked; unused 6 months; **"The user changed passwords and the refresh token contains Gmail scopes"**; too many live tokens (100 per account per client; the oldest is silently invalidated); time-based access expired; admin restriction. | Verified | G1 |
| O10 | Revoking an access token also revokes its refresh token, and revocation removes all scopes granted to the project. | Verified | G1, G4 |

## 2. Chrome Identity, alarms, service worker

Sources:
- C1 https://developer.chrome.com/docs/extensions/reference/api/identity
- C2 https://developer.chrome.com/docs/extensions/how-to/integrate/oauth
- C3 https://developer.chrome.com/docs/extensions/reference/api/alarms
- C4 https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

| # | Fact | Status | Source |
|---|---|---|---|
| C-a | `launchWebAuthFlow` redirect URLs match `https://<app-id>.chromiumapp.org/*`. With `interactive:false`, it errors if the initial navigation doesn't complete the flow. `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` exist (Chrome 113+). | Verified | C1 |
| C-b | `getAuthToken`: "If not specified, the function will use an account from the Chrome profile: the Sync account if there is one, or otherwise the first Google web account." `TokenDetails.account` can select another account. "The Identity API caches access tokens in memory, so it's ok to call `getAuthToken` non-interactively any time a token is required." | Verified | C1 |
| C-c | getAuthToken setup: manifest `oauth2.client_id` + `oauth2.scopes`, plus the `identity` permission; OAuth client type **Chrome Extension** with the extension ID in "Item ID". | Verified | C2 |
| C-d | Stable extension ID (official method): upload a zip to the Chrome Developer Dashboard **without publishing**, copy the public key, and put it in manifest `"key"`. | Verified | C2 |
| C-e | Whether `getAuthToken` works only in Google Chrome | Not stated (irrelevant now: Q13 = Chrome only) | C1 |
| C-f | Alarms minimum period: 30 s since Chrome 120. | Verified | C4 |
| C-g | `persistAcrossSessions` (Chrome 150+, default true). In earlier versions behaviour across restarts "can be unpredictable". The docs recommend checking `alarms.get()` on startup and recreating. | Verified | C3 |
| C-h | The service worker stops "After 30 seconds of inactivity. Receiving an event or calling an extension API resets this timer"; also when one request takes over 5 minutes, or "When a fetch() response takes more than 30 seconds to arrive". `launchWebAuthFlow` is exempt from the 5-minute limit (Chrome 116). Globals are lost on shutdown. | Verified | C4 |
| C-i | Whether a `fetch()` resets the idle timer | Not stated → persist the send queue (already planned) | C4 |

## 3. Gmail API

Sources:
- M1 https://developers.google.com/workspace/gmail/api/auth/scopes
- M2 https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
- M3 https://developers.google.com/workspace/gmail/api/guides/threads
- M4 https://developers.google.com/workspace/gmail/api/guides/sending
- M5 https://developers.google.com/workspace/gmail/api/reference/quota
- M6 https://support.google.com/mail/answer/22839

| # | Fact | Status | Source |
|---|---|---|---|
| M-a | `gmail.send` = **Sensitive** ("Send email on your behalf"). `gmail.labels` = Non-sensitive. `gmail.readonly`, `gmail.metadata`, `gmail.compose`, `gmail.modify`, `gmail.insert` and `https://mail.google.com/` = **Restricted**. | Verified | M1 |
| M-b | `messages.send` accepts `mail.google.com`, `gmail.modify`, `gmail.compose` or `gmail.send`. | Verified | M2 |
| M-c | `messages.send` "Sends the specified message to the recipients in the To, Cc, and Bcc headers." | Verified | M2 |
| M-d | To join a thread: `threadId` specified; "The References and In-Reply-To headers must be set in compliance with the RFC 2822 standard"; "The Subject headers must match." | Verified | M3, M4 |
| M-e | Whether a client-supplied `Message-ID` is kept; Bcc header handling; maximum message size | Not stated → prototype P3 | M2, M4 |
| M-f | `messages.send` costs **100** quota units. Per-user limit: **6,000 units per minute per project** (so about 60 sends/minute). Note: "As of May 1, 2026, the usage limits for this API were updated… Cloud projects created on or after May 1, 2026 are subject to the new API quotas." The table may not reflect the quota of a newly created project; **check the project's Quotas page.** | Verified | M5 |
| M-g | Limit of 500 recipients per message (API). | Verified | M5 |
| M-h | Consumer Gmail: errors when sending to "more than 500 recipients in a single email and or more than 500 emails sent in a day." | Verified | M6 |

## 4. Google OAuth verification and testing

Sources:
- V1 https://support.google.com/cloud/answer/15549945 (Manage App Audience)
- V2 https://support.google.com/cloud/answer/7454865 (Unverified apps)
- V3 https://support.google.com/cloud/answer/13464323 (When verification is not needed)
- V4 https://support.google.com/cloud/answer/13464325 (Restricted scope verification)
- V5 https://support.google.com/cloud/answer/13463073 (Sensitive scope verification)

| # | Fact | Status | Source |
|---|---|---|---|
| V-a | "Projects configured with a publishing status of Testing are limited to up to 100 test users". "Authorizations by a test user will expire seven days from the time of consent." Exception: only name/email/profile scopes. | Verified | V1 |
| V-b | External: "available to any user with a Google Account". Internal: limited to "members of the organization" of a Google Cloud Organization. | Verified | V1 |
| V-c | Consumer @gmail.com accounts cannot use Internal | Inference (they are not organization members) | V1 |
| V-d | The unverified-app screen appears for sensitive or restricted scopes without verification. Cap: "100 new users in total", lifetime of the project, cannot be reset. | Verified | V2 |
| V-e | Verification is not mandatory for: personal use ("fewer than 100 users"); apps in development/testing/staging; service-account-only data; Internal (organization-owned project, consent screen set to internal); admin-trusted apps. | Verified | V3 |
| V-f | Restricted scopes: "If you store restricted scope data on servers (or transmit), then you must go through a security assessment." Sensitive scopes "require additional OAuth App Verification". No security assessment is mentioned for sensitive scopes on the pages read. | Verified | M1, V4, V5 |
| V-g | The term "CASA" and the assessment cost or tier | Not stated on pages read | — |
| V-h | Classification of `openid` / `userinfo.email` | Not on the Gmail scope page. Inference from G1/V1: they are the basic identity scopes exempt from the testing expiry. | G1, V1 |

## 5. Cloudflare Workers and D1 (Free plan)

Sources:
- W1 https://developers.cloudflare.com/workers/platform/limits/
- W2 https://developers.cloudflare.com/workers/platform/pricing/
- W3 https://developers.cloudflare.com/d1/platform/limits/
- W4 https://developers.cloudflare.com/d1/platform/pricing/
- W5 https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- W6 https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- W7 https://developers.cloudflare.com/workers/configuration/cron-triggers/

| # | Fact (Free plan) | Status | Source |
|---|---|---|---|
| W-a | 100,000 requests/day, reset at midnight UTC. When exceeded, Cloudflare returns **Error 1027** (fail closed) or bypasses the Worker (fail open), per the route setting. | Verified | W1 |
| W-b | CPU time per HTTP request: **10 ms**; per cron run: 10 ms. | Verified | W1, W2 |
| W-c | 50 subrequests per invocation; 6 simultaneous outgoing connections; 128 MB memory; 64 MiB script; 1 s startup. | Verified | W1 |
| W-d | **5 Cron Triggers per account.** | Verified | W1 |
| W-e | `waitUntil()` "can extend execution for up to 30 seconds after the response is sent". | Verified | W1 |
| W-f | D1: **500 MB max per database**, 5 GB total per account, 10 databases, **5 million rows read/day**, **100,000 rows written/day** (reset 00:00 UTC). When exceeded, "you will not be able to run queries" until reset. | Verified | W3, W4 |
| W-g | D1: **50 queries per Worker invocation**, and a `db.batch()` counts as one query. 30 s max query; 100 bound parameters; 100 KB statement; 2 MB row. | Verified | W3 |
| W-h | Rate Limiting binding: `period` must be 10 or 60 s; "approximate", "eventually consistent", "apply separately in each Cloudflare location". | Verified | W5 |
| W-i | Whether the Rate Limiting binding is available on the Free plan | **Not stated** → P6 | W5 |
| W-j | workers.dev URL: `<worker-name>.<account-subdomain>.workers.dev`; the subdomain is changed in the dashboard (Workers & Pages → "Change" next to "Your subdomain"). Worker name ≤ 63 chars `[a-z0-9-]`. workers.dev is meant for personal/hobby projects; production should use routes or custom domains. | Verified | W6 |
| W-k | Whether WAF / rate-limiting rules apply to workers.dev | Not stated on W6. The rev 2 claim ("zone rules don't apply") remains an **inference**; we don't rely on WAF rules either way. | W6 |
