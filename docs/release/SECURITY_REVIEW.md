# Tracklet — Security Review (MVP, 2026-11-04)

Scope: the product code in `extension/`, `backend/` and `shared/`, as of branch `phase-p-and-0` with uncommitted MVP changes. Spikes under `spikes/` are out of scope except where noted.
Method: manual code review, automated static guards, 47 backend integration tests on a SQLite D1 shim, a synthetic smoke run against real `workerd` with local D1, a strict Trusted Types run of the built content script in headless Chrome, `npm audit` and the repository secret scan.

**Result: no open High or Critical findings.** The Low and Informational items are listed in §9.

## 1. Assets and trust boundaries

| Asset | Where it lives | Who can read it |
|---|---|---|
| Google access token (`gmail.send`, `openid`, `userinfo.email`) | Chrome's identity cache | The service worker only. It is never sent to the content script, the backend (except once, to exchange it for a session), logs or replies. |
| Backend session (HS256 JWT, 30-day expiry) | `chrome.storage.session` (in memory, cleared when the browser restarts) | Service worker |
| Subjects, recipient addresses, link anchor text | `chrome.storage.local` (`meta:*`) | This browser profile only |
| Per-recipient key | Backend | Opaque `HMAC-SHA256(local secret, address)`. The backend never sees the secret. |
| Tracking tokens (pixel and click) | Backend, and inside sent emails | 128-bit random values. They can't be guessed or enumerated. |
| IP address | Never stored | Only a monthly-salted `HMAC(IP_HASH_SALT, ip)` is stored |

Trust boundaries:
1. **Gmail page → content script.** Gmail's DOM is untrusted data.
2. **Content script → service worker.** Messages are checked by sender origin and against a type allowlist.
3. **Service worker → backend.** CORS is locked to the extension origin, plus a bearer session.
4. **Anyone on the internet → `/o/*` and `/c/*`.** These endpoints are unauthenticated by design.

## 2. OAuth and authentication

- **Scopes.** Only the three approved scopes are requested. This is enforced by `manifest.test.ts` (exact equality) and by `static-guards.test.ts`, which bans any other `googleapis.com/auth/*` string in product code. No client secret exists. The manifest test also fails on any `secret` field.
- **Sign-in.** Interactive sign-in can only start from an extension page (popup or dashboard). `signIn`, `signOut` and the delete actions are not in `CONTENT_TYPES`, and a guard test checks this. Gmail pages can never trigger a consent prompt.
- **Backend session exchange.** The backend validates the Google token with `tokeninfo`:
  - the audience (`aud`) must equal `GOOGLE_CLIENT_ID`;
  - `email_verified` must be true;
  - the token must carry the `openid` and email scopes;
  - the account must be in the `ALLOWED_GOOGLE_SUBS` allowlist.

  The allowlist is **re-checked on every request**, so removing a user takes effect immediately. Tests cover tampered tokens, expired tokens and removal from the allowlist.
- **Session JWT.**
  - HS256 with a key of at least 32 characters.
  - The signature is verified with `crypto.subtle.verify` (constant time).
  - `alg` is pinned, so `alg: none` is rejected.
  - The `sub` claim must be a ULID.
- **Sign-out** revokes the grant at Google, clears Chrome's token cache and drops the backend session. P1.7 live evidence: revoke returned HTTP 200 and the next silent token failed.

## 3. Sending (Gmail API)

- Recipients are validated before any network request. Limits: at most 20 recipients and 50 links, and a body of at most 64 KB.
- A batch lock blocks concurrent batches. The batch stops at the first failure.
- A 5xx response, a network error, or a 2xx without a message ID is treated as **uncertain** and **never retried**, so no duplicate email is sent. The recipient is marked failed with an "uncertain delivery" note.
- A 429 response gets a bounded backoff (at most 3 retries, 10 s cap). A 401 gets one silent token refresh.
- Each copy goes to exactly one recipient, so recipients can't see each other.
- Group sends need an explicit confirmation dialog.
- Replies and forwards are not tracked in the MVP, which avoids mangling quoted content.
- Dry run (`Preview tracking`) is proven to make no network calls; the test fails if `fetch` is called.

## 4. Tracking endpoints (public)

- **Pixel `/o/{token}.gif`.**
  - Returns the same GIF for valid, unknown and malformed tokens, so the response is not a token-existence oracle.
  - Sends `no-store` and `nosniff`.
  - Events per token are capped at 100 per day, so the endpoint can't be used to fill the database.
- **Click `/c/{token}`.**
  - Redirects with a 302 **only** to the URL stored when the email was registered.
  - The stored URL is validated again at redirect time: http or https only, no embedded credentials, no control characters, at most 2048 characters.
  - Unknown tokens, deleted emails, and tampered `javascript:` targets return 404, so this is not an open redirect.
  - Sends `Referrer-Policy: no-referrer`.

  These cases are tested both in the integration tests and on workerd.
- **Classification.** The backend labels events as scanner, prefetch, proxy, duplicate or self, and `counted` excludes the automated ones. Notifications never fire for `implied_open`, `duplicate` or `self_suspected` events, or during quiet hours.

## 5. Backend API hardening

- **CORS.** `Access-Control-Allow-Origin` is only `chrome-extension://hhejoehmmjbjahinnpgnfhfakbkhilcd`. A preflight from any other origin gets a 403, which was verified on workerd.
- **Authorization.** Ownership is checked in SQL (`e.user_id = ?`). Another user's ID gets a 404, so existence doesn't leak.
- **Recipient state machine.** Allowed transitions are pending → sending → sent or failed, and failed → sending. `sent` is terminal; any other transition returns 409.
- **Idempotency.** Registration is idempotent on `client_request_id`.
- **Input validation.** ULIDs, token shape, enum values and lengths are checked. JSON bodies are size-limited, and a bad body returns 400 without echoing the input.
- **Rate limits.** D1 fixed windows: 120 requests per minute per IP hash, and 100 registrations per hour per user. Both return 429.
- **Error handling.** `onError` logs only the error *name*. No request data, tokens or stack traces are logged, and a test checks this.
- **Response headers.** `cache-control: no-store` on API responses. `x-robots-tag: noindex` on tracking endpoints.
- **Retention.** A daily cron deletes events after 180 days, sender views after 24 hours, and expired caps and rate-limit windows.
- **Deletion.** Deleting one email or all data cascades through foreign keys. This was verified on workerd: 0 rows remain.

## 6. Extension hardening

| Control | Evidence |
|---|---|
| Permissions are limited to `identity`, `storage`, `alarms` and `notifications`. Host permissions cover only `gmail.googleapis.com`, `oauth2.googleapis.com` and the API origin. There is no `tabs`, `scripting`, `webRequest`, `cookies` or `<all_urls>`. | `manifest.test.ts` |
| The API base must be https (http is allowed only on loopback) and must be a bare origin, or the build fails. | `apiHostPattern` tests |
| The content script runs in the ISOLATED world (no page-world injection) and makes no network or storage calls; it only messages the service worker. | static guards |
| No HTML sinks: no `innerHTML=`, `outerHTML=`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML` or `DOMParser`. No `eval`, `new Function` or string timers. No Trusted Types policies. | static guards (55 assertions; negative control confirmed) |
| The **built** `dist/content.js` runs on the compose fixture under `require-trusted-types-for 'script'; trusted-types 'none'` with 0 violations and 0 errors. | `tt.test.ts` (headless Chrome 156) |
| Extension page CSP is `script-src 'self'; object-src 'self'`. React renders text only. | manifest test |
| Message senders are validated: our own extension pages, or Gmail tabs carrying our extension ID. Everything else gets `forbidden`. | `messages.ts`, core tests |
| Replies to pages never contain raw error text or tokens; errors are mapped to fixed messages. | `toReply()` |
| gmail.js, jQuery and InboxSDK are not used in product code. | static guards and D12 isolation tests |
| The stable extension ID is pinned by the public key. The private PEM lives at `~/.tracklet/extension-key.pem`, outside Git. | `manifest.test.ts` |

## 7. Privacy

- By default the backend stores no readable subject or recipient address; both are `NULL`. This was verified on workerd.
- The dashboard shows subjects and addresses from local storage only. On another device the dashboard shows "subject stored only on the device that sent it".
- An optional disclosure line can be added to tracked emails (Settings).
- The accuracy limitations of open tracking are shown on the dashboard and in the detail view, with labels for each event classification.

## 8. Supply chain and secrets

- `npm audit` found 0 vulnerabilities.
- Runtime dependencies are `react` and `react-dom` 18.3.1 (exact versions), `hono` and `@tracklet/shared`. The content script bundle (9.7 KB) has no third-party code apart from the shared helpers.
- The secret scan (`npm run secret-scan`) covers 132 files, including `extension/dist`, with 0 findings. Its patterns have not been weakened.
- `backend/.dev.vars` and `extension/.env.local` are gitignored (confirmed with `git check-ignore`). Only placeholder `.example` files are tracked. The OAuth client ID and the extension public key are public identifiers.

## 9. Findings and residual risks

| # | Severity | Finding | Status |
|---|---|---|---|
| S1 | Low | The backend calls `tokeninfo?access_token=…`, which puts the Google token in a URL query string. This is Google's documented method and runs over TLS to Google, but the token can appear in Google-side request logs. A POST form body would avoid this. | Open, accepted for MVP |
| S2 | Low | IP rate limiting uses D1 fixed windows. A burst at a window boundary can reach twice the limit, and it doesn't defend against large distributed floods. Cloudflare's built-in DDoS protection applies once the backend is deployed. | Accepted |
| S3 | Low | Tracking tokens appear in emails. Anyone the email is forwarded to can trigger opens and clicks attributed to the original recipient. This is inherent to pixel tracking and is documented in the accuracy note. | Accepted (documented) |
| S4 | Info | A scanner user agent on a pixel is labelled `prefetch_suspected` rather than `scanner_suspected` (classifier rule order). Both are uncounted and don't notify. | By design |
| S5 | Info | The 30-day session lives in `chrome.storage.session`, so a browser restart drops it and a new one is minted silently. The allowlist check on every request limits the impact of a stolen JWT, but there is no server-side session revocation list. "Delete all data" plus removal from the allowlist is the kill switch. | Accepted |
| S6 | Info | After a tracked send, the content script clicks Gmail's own "Discard draft" control, found by an `aria-label` / `data-tooltip` prefix. If Gmail changes it, the compose window is closed instead and a draft remains (the user is told). | Accepted |
| S7 | Info (spike) | In the `spikes/p1-oauth` `p3send` path, recipients are read twice, so the confirmed list could differ from the sent list. This is not product code: the product sends exactly the confirmed `ComposeInput`. | Spike only |

## 10. Not yet verified (needs approval or manual action)

- Live Gmail send with the product build. This needs approval to send real email.
- Live open and click tracking from real mail clients. This needs a deployed https backend (the pixel URL is currently `127.0.0.1`), and a deployment needs approval.
- Live Chrome notifications, and the dashboard rendered against real data.
- P1.6 (pending) and P1.8 (7-day Testing-mode expiry, due 2026-11-10). P1.4b is blocked: one Chrome profile per Gmail account.
