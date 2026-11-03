# PROTOTYPE TEST PLAN — Phase P (spikes P1–P6)

Purpose: prove or disprove the unverified behaviours before the feature phases.
- Spike code is throwaway, lives in `spikes/`, and is written only after approval.
- Results go to `spikes/RESULTS.md`, using the template at the end.

Accounts:
- **A** = your tracking Gmail (sender).
- **B** = the second Gmail account (recipient).

"Fact refs" point to `VERIFIED_PLATFORM_FACTS.md`.

## Prerequisite matrix
| Spike | Google Cloud project | Cloudflare account | Other needs | Can start now? |
|---|---|---|---|---|
| P1 OAuth | **Yes** (section E client) | No | Extension ID (Phase 0 key) | No |
| P2 Gmail UI adapter | No | No | gmail.js: nothing. InboxSDK: vendor App ID registration (Q16) | **Yes** (gmail.js part and InboxSDK licence/docs review) |
| P3 MIME + threading | **Yes** (`gmail.send` token) | No | P1 done | No |
| P4 Gmail proxy caching | No | No* | Public HTTPS pixel URL; accounts A and B | **Yes*** |
| P5 Self-open neutralisation | No | No* | Same as P4, plus a minimal unpacked extension (content script only) | **Yes*** |
| P6 Workers/D1 behaviour | No (local part) / **Yes** (deployed part) | Local: no. Deployed: **yes** | Wrangler (installed in Phase 0) | Local part after Phase 0 |

\* P4/P5 need a **public HTTPS** URL that logs requests. Options that need no Cloudflare account:
- (a) `cloudflared` "quick tunnel" (`*.trycloudflare.com`; free, no account) in front of a tiny local logger. This needs the `cloudflared` binary, which **requires your approval** (Q17).
- (b) Defer P4/P5 until the Cloudflare account exists and use a dev Worker.

---

## P1 — OAuth token acquisition and lifecycle
Fact refs: O1, O5, O6, O8, O9, C-a, C-b, C-c, V-a, V-d.
Variant tested: **E-1 Chrome Extension client + `getAuthToken`** if Q14 is approved; otherwise E-2 `launchWebAuthFlow`.

| ID | Steps | Expected | Pass criteria |
|---|---|---|---|
| P1.1 | Load the minimal extension (manifest `key`, `identity` permission, `oauth2.client_id` and the 3 scopes). In chrome://extensions confirm the ID. | The ID equals the Item ID in the OAuth client. | Exact match. |
| P1.2 | Ensure account A is the Chrome-profile Sync account (or the first web account). From the popup call `getAuthToken({interactive:true})`. | Unverified-app screen, then consent listing "Send email on your behalf", then a token returned. | Token received; no client secret anywhere in the extension directory (`grep -ri secret` finds nothing). |
| P1.3 | Call `getAuthToken({interactive:false})` 5 times over 10 minutes. | Cached token returned with no UI (C-b). | 5/5 succeed silently. |
| P1.4 | Profile with **two** Google accounts, where A is *not* the Sync account. Call with `account:{id}` for A (C-b). | Token for A. | Token's `email` (tokeninfo) = A; otherwise record a limitation. |
| P1.5 | Wait for the token to expire (≥ 60 min) or remove it with `removeCachedAuthToken`, then call non-interactively. | A new token without UI. | Succeeds. |
| P1.6 | Call `https://oauth2.googleapis.com/tokeninfo?access_token=…` with curl. | `aud` = client ID, `email` = A, `scope` contains the 3 scopes. | All three match. |
| P1.7 | Revoke at myaccount.google.com/permissions, then call non-interactively. | Error; the interactive call re-prompts. | Behaviour recorded. |
| P1.8 | Day 8 after consent (Testing-mode expiry, O8/V-a), call non-interactively. | Fails, or re-prompts. | Behaviour and UX recorded (calendar reminder). |
| P1.9 *(only if E-2)* | `launchWebAuthFlow` with `prompt=none&login_hint=A`, `interactive:false`. | A silent token while the Google session is valid. | ≥ 4/5 succeed. |

**Overall pass:** P1.1–P1.6 pass. P1.7/P1.8 are documented, not pass/fail.

## P2 — Gmail UI adapter (InboxSDK vs gmail.js)
Fact refs: none official (third-party libraries).

| ID | Steps | Expected | Pass criteria |
|---|---|---|---|
| P2.1 | Read each project's `LICENSE` on its official GitHub repository and the npm package metadata (no install). | A permissive licence. | MIT/Apache/BSD-type, compatible with personal use. |
| P2.2 | Read the InboxSDK documentation for App ID registration terms and data collection or telemetry. | Terms documented. | No mandatory sharing of email content; telemetry acceptable or disableable. |
| P2.3 | Build a minimal unpacked extension with each library and load it into Gmail (account A). In DevTools, record **all network requests to non-Google hosts** during 5 minutes of use. | Ideally none. | Every host is listed and justified. Any request sending email data is a fail. |
| P2.4 | Check that MV3 loads with no remotely hosted code: all JS in the package, no `eval`, CSP intact. | Extension loads with no CSP errors. | No remote script loads observed in P2.3. |
| P2.5 | Add a "Send tracked" button to the compose toolbar (new compose only). | Button visible. | Visible in a new compose; hidden in reply and forward. |
| P2.6 | From the button handler, read To/Cc/Bcc (addresses and names), subject and HTML body (with signature), plus attachment presence. | Exact values. | 10/10 test composes read correctly, including Unicode and 3 recipients across To/Cc/Bcc. |
| P2.7 | Programmatically close or discard the compose after a "send". | The compose closes. | Record whether a draft remains in Drafts; pass if it can be removed **without** restricted scopes. |
| P2.8 | Attach a status chip to Sent-list thread rows for given thread IDs. | Chip shows. | Works on Sent and in a search view (InboxSDK). For gmail.js, record the effort. |
| P2.9 | Reload Gmail 10 times and switch between inbox and Sent. | No errors. | 0 uncaught exceptions from the adapter. |

**Decision rule (D12):** InboxSDK if P2.1–P2.4 pass and it's better on P2.5–P2.8; else gmail.js if P2.1, P2.3–P2.7 pass; else the own compose page.

## P3 — MIME construction and per-recipient threading
Fact refs: M-b, M-c, M-d, M-e, M-f, M-g, M-h.
Uses the P1 token and calls `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` from the spike.

| ID | Steps | Expected | Pass criteria |
|---|---|---|---|
| P3.1 | Send a single-recipient copy A→B: multipart/alternative, a Unicode subject `Résumé ✓ 測試` (RFC 2047), an HTML body containing a 1×1 `<img>` at the top and two links. | Delivered. | B shows the subject, HTML and links correctly; the text part is visible in "Show original". |
| P3.2 | Send 3 copies (to B, B+alias `B+cc@gmail.com`, `B+bcc@gmail.com`), each with only its own recipient in `To`. Copy 1 carries our own `Message-ID: <ulid@tracklet.invalid>`; copies 2–3 carry `In-Reply-To` + `References` = copy 1's id, `threadId` = copy 1's returned threadId, identical Subject (M-d). | 3 deliveries. | Each delivered copy shows exactly one recipient. |
| P3.3 | In A's Sent, open "Show original" for copy 1. | — | Record whether our `Message-ID` was **kept or replaced** (M-e). |
| P3.4 | Inspect A's Sent view. | Ideally one thread with 3 messages. | Record grouped or separate. If separate, record whether passing only `threadId` changes it. |
| P3.5 | In B, inspect the threading of the 3 received copies, then reply to one. | — | The reply goes only to A. Record which of A's threads it lands in. |
| P3.6 | Send with a `Bcc:`-only header (no To). | Delivered. | Record the To display at the recipient (M-e). |
| P3.7 | Send 10 copies in a loop, 600 ms apart, and record response times and any 429s. | All 200. | No quota errors at ~1.7 sends/s (M-f: 6,000 units/min ≈ 60 sends/min). |
| P3.8 | Try a `From:` header that differs from A. | Rewritten or rejected. | Behaviour recorded (the builder always uses A). |

**Overall pass:** P3.1, P3.2, P3.5 and P3.7 pass. P3.3/P3.4 decide the threading approach (record and adapt).

## P4 — Gmail image proxy caching and repeat opens
Needs: a public HTTPS logger at `https://<host>/o/<token>.gif` returning a no-store 1×1 GIF and logging the time, method, UA, and the `cf-connecting-ip`/`x-forwarded-for` header **hashed**.

| ID | Steps | Expected | Pass criteria |
|---|---|---|---|
| P4.1 | From A's Gmail web compose, insert the image by URL (Insert photo → Web address) with token `p4a`, and send to B. *(No API needed.)* | — | — |
| P4.2 | B opens the message in Gmail web. | 1 request, UA contains `GoogleImageProxy`. | Logged within 10 s of opening. |
| P4.3 | B closes and re-opens after 1 min, 10 min and 1 h (and the next day). | — | Record hits per re-open: refetched or cached. |
| P4.4 | B opens on the Gmail Android/iOS app. | Proxy fetch. | Logged; record the UA. |
| P4.5 | Repeat P4.1–4.3 with response headers `Cache-Control: no-store` vs `max-age=0` vs none (tokens `p4b`, `p4c`). | — | Record which policy maximises refetch. |
| P4.6 | A sends; nobody opens for 30 minutes. | No request. | 0 hits, which confirms no delivery-time prefetch by Gmail. |

**Outcome:** a documented repeat-open policy, deciding whether `open_count` beyond the first is shown as "≥ n".

## P5 — Self-open neutralisation in the sender's Gmail
Needs: the P4 logger plus a minimal unpacked extension whose content script on `mail.google.com` (no OAuth needed) watches for `<img>` elements whose `src` contains the logger host (directly or after `#` in a googleusercontent URL) and sets `src` to a data-URI placeholder. It also logs a "view" with a timestamp to the console.

| ID | Steps | Expected | Pass criteria |
|---|---|---|---|
| P5.1 | **Without** the extension: A opens its own Sent copy of a P4-style email. | 1 proxy hit. | Confirms a self-open is visible to the server. |
| P5.2 | **With** the extension: A opens 20 different Sent messages containing pixels (various tokens). | Ideally 0 hits. | Count hits. **Pass if ≥ 16/20 are suppressed (≥ 80%).** |
| P5.3 | Inspect the DOM: record the exact `src` format of proxied images (is the original URL present after `#`?). | — | Format documented. |
| P5.4 | For any hits that weren't suppressed, compare the logger timestamp with the extension's view timestamp. | Within a few seconds. | All hits within ±90 s of a view, which validates the view-signal fallback window. |
| P5.5 | A opens the Sent message in the Gmail mobile app. | A hit (not suppressible). | Recorded as a known limitation. |

## P6 — Workers and D1 behaviour
Fact refs: W-a … W-k.

| ID | Steps | Expected | Pass criteria |
|---|---|---|---|
| P6.1 *(local)* | `wrangler dev` with a local D1; apply `0001_init.sql`. | Applies. | No errors. |
| P6.2 *(local)* | Spike handler: insert an event and update counters in one `db.batch()`; run 1,000 times. | — | Constraints are enforced, and counters equal the inserted counted events. |
| P6.3 *(deployed, needs the Cloudflare account)* | Add a `ratelimit` binding (`period: 60`) and deploy to a dev Worker. | Deploys if the binding is available on Free. | **Record available or not (W-i)**; if not, use the D1 fixed-window fallback. |
| P6.4 *(deployed)* | Send 200 requests at the pixel route; measure p50/p95 latency and CPU time (dashboard metrics). | p95 < 100 ms, CPU < 5 ms. | Met. |
| P6.5 *(deployed)* | Check that `waitUntil` work finishes after the response (the event row appears). | The row exists. | 200/200 rows. |
| P6.6 *(deployed)* | Confirm the workers.dev URL format and HTTPS certificate. | `https://t.<sub>.workers.dev`. | A valid certificate. |

---

## Results template (`spikes/RESULTS.md`)
```
## P<n>.<m> <title>
Date / Chrome version / accounts:
Steps executed:
Observed:
Result: PASS | FAIL | RECORDED
Impact on architecture (decision IDs):
```
