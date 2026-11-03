# IMPLEMENTATION PLAN — rev 2

Nothing starts without your explicit approval. Rev 2 inserts a **prototype phase (P)** before the feature phases, because several platform behaviours are unverified (ARCHITECTURE §1).

## Decision table (summary)
See ARCHITECTURE §2 for the full table with reasons and trade-offs.

| # | Decision | Selected | Changeable later? |
|---|---|---|---|
| D1 | Account | Consumer Gmail, External app, Testing | Yes |
| D2 | OAuth flow | `launchWebAuthFlow` implicit, no secret | Yes |
| D3 | Host | workers.dev, custom domain later | Yes (old links depend on the workers.dev route) |
| D4/D5 | Recipient tracking | One copy per recipient; group is opt-in | Partly |
| D6 | Cc/Bcc | Each recipient in `To` of their own copy | Platform-limited |
| D7 | Tracked replies | Not in MVP | Yes |
| D8 | Attachments | Blocked in MVP | Yes |
| D9 | Disclosure | Optional, off | Yes |
| D10/D11 | Subjects/addresses on backend | Off by default; stored locally | Yes |
| D12 | Gmail UI | InboxSDK if P2 passes, else gmail.js, fallback own compose page | Yes |
| D14 | Backend | Workers + D1 + Hono | Yes |
| D15 | Notifications | 1-min alarm polling | Yes |
| D16 | Self-open | Layered heuristics, flag not delete | Yes |

---

## Tracking flows

### A. Send (single recipient, or opt-in group)
1. **Gmail compose (new message only):** the adapter adds the "Send tracked" button.
   - On click: read To/Cc/Bcc, subject, HTML body and attachment presence.
   - Abort with a message if there are attachments, it is a reply/forward, or there are >20 recipients.
   - If >1 recipient: show the opt-in dialog explaining separate copies and the loss of Reply-All. Proceed only if confirmed.
2. **Content script:** compute `recipient_key` per address (HMAC with the local `user_secret`). Extract http(s) links from the HTML with indexes.
3. **Service worker:** `POST /v1/emails`, then save local `meta:<id>` and `queue:<id>`.
4. **Content script:** for each recipient, build the personalised HTML: replace hrefs with that recipient's click URLs, insert the pixel `<img>` as the **first** body element, and optionally the disclosure line. Generate text/plain.
5. **Service worker queue,** per recipient sequentially, ≥ 1 s apart (Gmail quota: 6,000 units/min/user, VERIFIED M-f):
   - `PATCH sending`.
   - Build MIME. Copy #1 gets its own `Message-ID`; later copies get `References` plus `threadId`.
   - `messages.send`, then `PATCH sent|failed`.
   - 429/5xx → up to 3 retries with backoff.
   - A 401 from Gmail → renew the token (silent, then interactive).
6. On completion, close the compose. Whether InboxSDK `close()` leaves a draft is checked in P2; if it does, the user is told to discard it.
7. Show a toast with the result (sent / partial with failed recipients).

### B. Open
`/o/{token}.gif` → immediate GIF → background classification → event plus counters → next poll (≤ 60 s) → notification if `notify`.

### C. Click
`/c/{token}` → 302 to the stored URL → background classification → event, plus an implied open if needed → poll → notification.

### D. Self-open filtering
Layers per ARCHITECTURE §5.5: in-page pixel neutralisation, `/v1/views` ±90 s reclassification, and a 15 s grace window. Your mobile or other-browser views are not filtered.

### E. Duplicates and unreliable data
60 s logical dedupe, per-token daily cap, idempotent registration and send-state machine, no automatic resend of recipients stuck in `sending`, all raw events kept with `classifier_version`.

---

## Phase P — Prototype and validation spikes (before Phase 1 features)
> **Rev 3:** detailed steps, expected results and pass criteria for every spike are in `PROTOTYPE_TEST_PLAN.md`, which supersedes the summary table below. Account setup is in `SETUP_GOOGLE_CLOUD.md` and `SETUP_CLOUDFLARE.md`; cited facts are in `VERIFIED_PLATFORM_FACTS.md`. P1 tests the D2 variant chosen in OPEN_QUESTIONS Q14.
Throwaway code in a `spikes/` folder; nothing is shipped from it.

| Spike | Validates | Pass criteria |
|---|---|---|
| P1 OAuth | `launchWebAuthFlow` implicit flow with a Web client and `https://<id>.chromiumapp.org/` redirect; silent renewal with `prompt=none` | A token is obtained without a secret; silent renewal succeeds within the same Google session; behaviour after the 7-day testing expiry is documented |
| P2 Gmail adapter | InboxSDK: `LICENSE`, App ID registration, telemetry endpoints (watched in DevTools), MV3 no-remote-code, compose HTML + recipients + attachment detection, close/discard behaviour, Sent thread-row API. The same checklist for gmail.js | A written go/no-go per library |
| P3 MIME + threading | Unicode subject, HTML + text, sending 3 copies with our own `Message-ID` + `References` + `threadId` | All 3 delivered, each showing only its own recipient; grouping in Sent observed and documented; whether our `Message-ID` is preserved recorded |
| P4 Gmail proxy caching | Open the same message 5 times, over minutes and hours, from a second Gmail account | Number of pixel hits recorded; repeat-open policy decided |
| P5 Self-open | Can the content script neutralise our pixel before Gmail loads it? Does the view signal arrive in time? | Measured success rate over 20 self-views ≥ 80%, or a decision to rely on the view signal only |
| P6 Free tier | Workers Rate Limiting binding available on Free? D1 batch latency from a Worker? | Documented; fallback chosen |

**Dependencies:** your approval; a Google Cloud project and OAuth clients created **by you, or by me with explicit approval** (Q9); a free Cloudflare account; a second test Gmail account; ideally an iCloud and an Outlook.com test inbox.
**Acceptance:** a `spikes/RESULTS.md` with pass/fail per spike; ARCHITECTURE updated where the results differ.

## Phase 0 — Project foundation
- **Deliverables:**
  - npm-workspaces monorepo (`extension`, `backend`, `shared`).
  - TypeScript strict, ESLint, Prettier, Vitest.
  - Vite MV3 build with a fixed manifest `key`.
  - Hono Worker skeleton with `/health`.
  - D1 migration `0001_init.sql` (DATABASE_SCHEMA rev 2).
  - A CI script that greps the built extension for secrets.
- **Dependencies:** approval; Node 20+. *(Can run in parallel with Phase P.)*
- **Acceptance:**
  1. `npm run build` and `npm test` succeed.
  2. The unpacked extension loads with a stable ID.
  3. `wrangler dev` answers `/health` 200.
  4. Migrations apply to local D1 and the schema matches the doc.
  5. The secret-scan check passes.
  6. No runtime dependencies beyond those listed in ARCHITECTURE §8 / the decision table.

## Phase 1 — OAuth and backend session
- **Deliverables:** `launchWebAuthFlow` sign-in (popup), token renewal, `/v1/auth/session` with tokeninfo + allowlist, session storage, `/v1/preferences` with defaults.
- **Dependencies:** Phase 0, P1.
- **Acceptance:**
  - The signed-in email is shown.
  - A non-allowlisted account gets `403`.
  - An expired Google token renews silently or prompts.
  - No client secret exists anywhere.
  - Revoking at myaccount.google.com forces re-consent.

## Phase 2 — Tracked sending (no tracking yet)
- **Deliverables:** `GmailUiAdapter` plus the chosen implementation, compose guards (reply, attachments, >20), the group opt-in dialog, the MIME builder with unit tests, the persisted send queue, registration and status endpoints.
- **Dependencies:** Phase 1, P2, P3.
- **Acceptance:**
  - Single and 3-recipient sends deliver correctly; each copy shows only its own recipient.
  - Formatting and signature are preserved.
  - Killing the service worker mid-send resumes without duplicates.
  - Guards block replies and attachments with clear messages.

## Phase 3 — Open tracking
- **Deliverables:** pixel insertion (top of body), `/o` handler, classifier v1 with fixture tests, token caps, a dev deployment to workers.dev (with approval).
- **Dependencies:** Phase 2, P4.
- **Acceptance:**
  - Gmail recipient open → `proxy_open` within 60 s in the DB.
  - An open within 15 s of sending → `prefetch_suspected`.
  - Unknown token → identical GIF and no row.
  - p95 under 100 ms measured with 100 sequential curl requests.

## Phase 4 — Click tracking
- **Deliverables:** per-recipient link rewriting (skip `mailto`/`tel`/anchors), `/c` handler, scanner rules, implied opens.
- **Dependencies:** Phase 3.
- **Acceptance:**
  - The exact URL is preserved (query and fragment).
  - Tampered or unknown tokens → 404 and no redirect.
  - HEAD, or clicks within 5 s, or 2 links within 2 s → `scanner_suspected`.
  - A click with no prior open creates an `implied_open`.

## Phase 5 — Analytics dashboard
- **Deliverables:** list, detail, dashboard and thread-status endpoints; a React dashboard merging local metadata; a suspected-events toggle; the accuracy note; Sent-list chips (if the adapter supports them).
- **Dependencies:** Phases 3–4.
- **Acceptance:**
  - Totals match a hand-counted fixture.
  - Subjects and addresses appear only from local storage when `store_*` is off.
  - Deleting an email removes its server data and local meta.

## Phase 6 — Notifications and self-open filtering
- **Deliverables:** an alarm poller (recreated on startup/install), a cursor, the notification summary for bursts, quiet hours, first-only, the `/v1/views` signal, and pixel neutralisation from P5.
- **Dependencies:** Phase 5, P5.
- **Acceptance:**
  - Notification within about 60 s of a counted event.
  - Viewing your own Sent copy produces no notification (target ≥ 80% of 20 trials) and the event is stored `self_suspected`.
  - A restart after 2 h produces at most one summary notification.

## Phase 7 — Security, privacy and test hardening
- **Deliverables:** a rate-limit implementation, a per-token cap test, CORS and JWT checks, monthly salt rotation and the retention cron, CSP for extension pages, `npm audit`, a threat-model checklist (token guessing, open redirect, log flood, XSS via stored strings, session theft), the manual client matrix, a privacy note in settings, and a deployment runbook.
- **Dependencies:** Phases 0–6.
- **Acceptance:** all checks green; `npm audit` shows no high or critical issues; data-deletion endpoints verified; the client matrix is recorded in `TESTING.md`.

## Effort estimate (single developer)
| Phase | Days |
|---|---|
| P | 2–3 |
| 0 | 0.5 |
| 1 | 1 |
| 2 | 3 |
| 3 | 1.5 |
| 4 | 1 |
| 5 | 2 |
| 6 | 1.5 |
| 7 | 1.5 |
| **Total** | **≈ 14–15** |
