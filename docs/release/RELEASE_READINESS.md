# Tracklet — Release Readiness (MVP, 2026-11-04)

**Verdict: the code is ready for a private live trial. It is NOT release-ready until the gated steps in §4 are done.**
Everything that can be verified without sending real email or deploying has been verified (§2). The remaining steps need your approval or your hands.

Status vocabulary:
- **Implemented**: the code exists and typechecks.
- **Unit-tested**: tested in isolation.
- **Mock-tested**: tested with fakes for Google or Chrome.
- **Locally integration-tested**: tested against the real backend app or workerd with local D1.
- **Live-tested**: tested in real Chrome, Gmail or Google.
- **Blocked**: waiting on something outside the code.
- **Awaiting approval**: needs your go-ahead.

## 1. Baseline audit (start of MVP work)

The branch was `phase-p-and-0` at `1f2bbc2`, and every commit was local.

| Area | Starting state | Gap closed in MVP |
|---|---|---|
| Extension | Phase 0 skeleton (no permissions). Native Gmail adapter (P2, live-tested). Send/MIME only in `spikes/` | Product service worker, content script, send pipeline, popup and dashboard |
| Backend | `/health` only | Full API, tracking endpoints, classification, retention, rate limits |
| Shared | Scope constants | IDs and tokens, URL validation, link rewriting, wire types |
| Tests | Spike suites | +47 backend, +121 extension, +37 shared product tests |
| Docs | Architecture, API and schema docs, setup guides, spike results | README, SECURITY_REVIEW, RELEASE_READINESS |

## 2. Feature status

| Feature | Status | Evidence |
|---|---|---|
| OAuth (3 approved scopes, consent only from extension pages, sign-out revoke) | Implemented · Mock-tested · **Live-tested in spike** (P1.7 revoke PASS with evidence; P1.1–1.3, 1.4a and 1.5 PASS as reported) | `auth.ts`, `manifest.test.ts`, static guards, `spikes/RESULTS.md` |
| Backend session (tokeninfo validation, allowlist on every request) | Implemented · Locally integration-tested | `api.test.ts`; synthetic workerd run |
| Gmail compose integration (Send tracked / Preview, new composes only, group confirm, discard after send) | Implemented · Built content script tested under strict TT on fixture | `tt.test.ts`. The adapter itself was live-tested in P2. **Product build not yet live in Gmail** |
| MIME (RFC 2047, `Date`, multipart/alternative, pixel at top) | Implemented · Unit-tested | `mime-hooks.test.ts`, `send.test.ts` |
| Safe batch sending (validation, lock, stop on failure, uncertain responses never retried, 429/401 handling) | Implemented · Mock-tested (28 + 6) | `send.test.ts`, `mime-hooks.test.ts` |
| Dry run (no network) | Implemented · Mock-tested · Spike dry run manually tested in Chrome | runtime `fetch` assertion |
| Open tracking (pixel, classification, cap, self-view) | Implemented · Locally integration-tested (app + workerd) | `api.test.ts`; workerd run |
| Click tracking (exact 302, no open redirect, 404 after delete) | Implemented · Locally integration-tested (app + workerd) | same |
| Notifications (poll cursor, dedupe, summary, quiet hours, first-only) | Implemented · Mock-tested · Locally integration-tested (e2e) | `core.test.ts`, `e2e-local.test.ts` |
| Thread marks in Gmail list | Implemented · Fixture-tested | P2 native adapter tests; `threadStatus` on workerd |
| Dashboard and popup (React: stats, list, search, filter, detail, events, settings, delete) | Implemented · Typechecked · Built · Guarded (no HTML sinks) | **Not rendered against data in a browser yet** |
| Privacy (no readable subjects or addresses server-side, hashed IP, retention, delete all) | Implemented · Locally integration-tested | workerd: subject/address `null`; 0 rows after delete |
| Security hardening | Reviewed | [docs/release/SECURITY_REVIEW.md](SECURITY_REVIEW.md): no High or Critical findings; Lows accepted |

## 3. Verification run (2026-11-04)

| Check | Result |
|---|---|
| `npm run typecheck` (shared, extension + e2e, backend, spikes) | ✅ clean |
| `npm test` (Vitest, 20 files) | ✅ **306 passed**, 0 failed, 0 skipped. Product: backend 47, extension 121, shared 37. Spikes and harness: 101, including 1 test of the product content-script build under strict TT |
| `npm run build` | ✅ `dist/`: manifest, background, content (IIFE, 9.7 KB), popup, dashboard, icon |
| `npm run secret-scan` | ✅ 132 files, 0 findings |
| `npm audit` | ✅ 0 vulnerabilities |
| Static-guard negative control (injected `innerHTML=` and `fetch` into `content.ts`) | ✅ guards failed as expected; file restored |
| `wrangler dev` (workerd + local D1), anonymous checks | ✅ health 200; unknown/malformed pixel → GIF; unknown click → 404; CORS from the extension → 204, from another origin → 403; no session → 401; bogus Google token → 401 |
| `wrangler dev`, synthetic authenticated flow | ✅ **17/17**: register → sending → sent; sent is terminal (409); pixel; exact 302; scanner opens uncounted; events, detail, dashboard rates, thread label; delete → click 404 and detail 404. The synthetic user and data were removed afterwards |

## 4. Remaining gates

| # | Gate | Type | What you need to do |
|---|---|---|---|
| G1 | Review and commit the MVP changes | Awaiting approval | Review the diff, then approve a commit. Nothing has been committed or pushed |
| G2 | Live product test in Gmail with **dry run only** | Manual | Load `extension/dist`, sign in from the popup, compose to yourself, click **Preview tracking**. No email is sent |
| G3 | Live **send** to your own test address | Awaiting approval | Explicit approval to send real email (recommend 1 recipient, then a 2-recipient group to yourself) |
| G4 | Deploy the backend (https `workers.dev`) | Awaiting approval | Create the Cloudflare D1 database and set secrets (`wrangler secret put …`), then deploy. Free tier; no paid services. Without this, opens and clicks from real clients can't reach `127.0.0.1` |
| G5 | Real open and click from Gmail web, Gmail mobile and Outlook | Blocked on G3 and G4 | Open the test emails and click a link; check the dashboard and notifications |
| G6 | P1.6 | Pending (manual) | Values still to be supplied |
| G7 | P1.8: Testing-mode 7-day expiry | Pending: **due 2026-11-10** | Check silent sign-in still works after 7 days |
| G8 | Shut down the leftover Google Cloud project `tracklet-personal-513614` | Manual | Automation lacked the permission; do it in the Cloud console |
| — | P1.4b: second account in one profile | Blocked (Chrome platform) | Product rule: one Chrome profile per Gmail account |
| — | Chrome Web Store publication | Out of scope | Not planned for personal use; would need Google OAuth verification of `gmail.send` |

## 5. Known limitations

- **Supported messages.** Only **new** messages without attachments are tracked; replies and forwards use normal Send.
- **Group sends** become separate copies. Cc and To are not visible to other recipients, and Reply-All reaches only the sender.
- **Open accuracy.** Opens are estimates (image blocking, Apple Mail Privacy Protection, proxies, scanners, forwarding). Scanner opens are labelled "possibly automatic" and not counted.
- **Dashboard on other devices.** Subjects and addresses exist only on the sending browser profile, so other devices show placeholders.
- **Leftover drafts.** If Gmail's Discard control can't be found after a send, a draft may remain (the user is told).
- **Gmail DOM selectors** live in one place (`SELECTORS`) and may need updates when Gmail changes.
- **Sessions** last up to 30 days but live in session storage, so they are re-minted silently after a browser restart. There is no server-side session revocation list; removing the user from the allowlist revokes access immediately.
- **Scale.** Built for personal use: per-IP and per-user D1 rate limits, and an allowlist of Google accounts.

## 6. Release checklist

- [x] Only the approved OAuth scopes; no client secret
- [x] Minimal Chrome permissions; strict extension CSP
- [x] Stable extension ID pinned; private key outside Git
- [x] No HTML sinks or Trusted Types policies in product code; the built content script is TT-clean
- [x] Typecheck, tests, build, secret scan and audit all green
- [x] Backend smoke-tested on workerd with local D1
- [x] Security review written; no High or Critical findings
- [x] README, troubleshooting, limitations and privacy notes
- [ ] G1 commit (approval)
- [ ] G2 live dry run in Gmail
- [ ] G3 live send to self (approval)
- [ ] G4 backend deploy (approval) and `TRACKLET_API_BASE` set to the https URL, then rebuild
- [ ] G5 live open and click across clients
- [ ] G7 P1.8 on 2026-11-10
