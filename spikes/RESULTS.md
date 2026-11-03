# Phase 0 + Phase P results (2026-11-03)

Environment: Windows 11, Node 26.13.0, npm 11.20.0, Chrome (local), wrangler 4.156.2 (local mode only), vite 8.3.5, vitest 5.1.0, TypeScript 7.0.2, cloudflared 2026.10.7.
Branch: `phase-p-and-0` (uncommitted).

Legend:
- **PASS**: executed, and the criteria were met.
- **FAIL**: executed (or reviewed), and the criteria were not met.
- **BLOCKED**: cannot run yet; the blocker is named.
- **RECORDED**: an observation with no pass/fail criterion.

---

## Phase 0 — Foundation
| Check | Result | Evidence |
|---|---|---|
| npm-workspaces monorepo (`shared`, `extension`, `backend`) | PASS | `package.json` workspaces |
| `npm run typecheck` (strict TS, 3 workspaces) | PASS | exit 0 |
| `npm test` (vitest) | PASS | 4 files, **16/16 tests** (shared scopes, manifest/ID, health, P3 MIME) |
| `npm run build` (Vite MV3) | PASS | `extension/dist/{manifest.json,background.js,popup.html,popup.js}` |
| Stable extension ID | PASS | `hhejoehmmjbjahinnpgnfhfakbkhilcd`; the test re-derives the ID from the committed public key |
| Private key outside Git | PASS | `~/.tracklet/extension-key.pem`; the generator refuses to write a key inside the repo; `.gitignore` blocks `*.pem` etc. |
| Loads unpacked in Chrome | **BLOCKED** (manual) | You need to load `extension/dist` and confirm the ID (1 minute) |
| Local D1 migration `0001_init.sql` | PASS | `wrangler d1 migrations apply tracklet --local` → 19 commands OK |
| `wrangler dev` `/health` | PASS | `{"status":"ok","service":"tracklet-backend","version":"0.0.1"}`; `/health/db` → 8 tables; unknown route → 404 |
| Secret scan | PASS | 53 files, 0 findings. A planted fake private key was detected (exit 1) and then removed |
| No unapproved runtime deps | PASS | Runtime: `hono` (backend) only. Dev: typescript, vite, vitest, wrangler, @cloudflare/workers-types, @types/chrome, @types/node. Install scripts approved only for `esbuild` and `workerd` (wrangler's local runtime) |
| `npm audit` (at install) | PASS | "found 0 vulnerabilities" |
| OAuth in the product extension | Not yet | Phase 0 manifest has no permissions; `oauth2` is added only when `TRACKLET_OAUTH_CLIENT_ID` is set |

Deviation noted: the extension skeleton uses plain TypeScript, not React yet. React is added in Phase 5 (dashboard), to keep Phase 0 minimal.

---

## P1 — OAuth (`getAuthToken` + Chrome Extension client)
| Test | Result | Notes |
|---|---|---|
| P1.1–P1.8 | **BLOCKED** | Needs the Chrome Extension OAuth client (SETUP_GOOGLE_CLOUD §A–E-1) and your interactive consent in the dedicated profile |
| Harness | Ready | `spikes/p1-oauth` (build verified with a dummy client ID; dist removed). Interactive consent only on a button click. Tokens are never shown, only the length and tokeninfo fields. Scopes are exactly the approved three |

Documentation point for the design (Q14): Chrome caches and renews access tokens, but **consent is still required again** after the Testing-mode 7-day expiry, after revocation, and after a Google password change (VERIFIED O8/O9).

## P2 — Gmail UI adapter
| Test | InboxSDK 2.2.33 | gmail.js 1.1.16 |
|---|---|---|
| P2.1 Licence | npm metadata: `(MIT OR Apache-2.0)`. **But** the shipped bundle header says: "The use of InboxSDK is governed by the Terms of Services located at https://www.inboxsdk.com/terms", and that URL returns **404** (as does `/privacy`). → **FAIL**: the terms can't be reviewed | MIT (`LICENSE.md`) → **PASS** |
| P2.2 Registration / terms / privacy | App ID "necessary to load the SDK" (unregistered shows a warning bar linking to `register.inboxsdk.com`). Terms and privacy unavailable. → **FAIL** | None needed → **PASS** |
| P2.3 External network calls (static scan of shipped JS) | Sends to `https://api.inboxsdk.com/api/v2/errors` (error reports, ≤ 10/min) and an events pipeline (`/api/v2/events/oauth` token, then event upload). Events include `emailHash` = SHA-256(`'inboxsdk:'+email`), origin and session ID. Defaults in code: `globalErrorLogging: true`, `eventTracking: true`. Both can be set false in `load()` options, but they are **undocumented** in the public docs, and the error path (`logger.error`) appears independent of `eventTracking`. → **FAIL** against "no data to vendor" (static evidence; not run) | Hosts in source: github.com, googleblog.com, mail.google.com (constants and comments only); no network calls to third parties → **PASS (static)** |
| P2.4 MV3 / no remote code | NPM build is "NONREMOTE": the platform implementation is bundled, and `loadScript` throws "not usable in Chrome MV3 extensions". 2 `new Function` uses (webpack global shim, a wrapper helper). → PASS with a CSP caveat to verify at runtime | Single source file; page-world injection required → PASS (static) |
| P2.5–P2.11 Runtime (compose detection and button, field reading, close/draft, Sent marks, stability, Trusted Types, thread view, live network) | Rejected (D12), not run | **BLOCKED (manual)**: harness built (round 2, below); needs your Gmail session (RUNBOOK §P2) |
| Maintenance | npm modified 2026-10-27 (active) | Last npm publish 2025-01-01 (~22 months old): **maintenance risk** |

**P2 conclusion (evidence-based):** InboxSDK is **rejected** under the current constraints: its terms aren't reviewable, App ID registration is mandatory, and it sends error and event telemetry including a hashed user email to the vendor by default. gmail.js is the provisional candidate, pending runtime P2.5–P2.9. Its age means a real risk of breakage on Gmail changes, so the extension-hosted compose page (D12 fallback) stays important.

### P2 round 2 (2026-11-03): gmail.js harness, automated part
| Check | Result | Evidence |
|---|---|---|
| Adapter boundary exists | PASS | `extension/src/gmail/adapter.ts` (`GmailUiAdapter`); the harness implements it (`GmailJsAdapter`) |
| Harness builds (esbuild, MAIN-world content script, **no permissions**) | PASS | `spikes/p2-gmailjs/dist/page.js` ≈ 398 KB (gmail-js 1.1.16 + jquery 3.7.1, both exact-pinned, MIT) |
| Static network surface of the bundle | PASS | Only `html.spec.whatwg.org`, `promisesaplus.com`, `www.w3.org` appear, all inside jQuery code comments or strings; the harness has no `fetch`/XHR |
| gmail.js API shape (source review) | RECORDED | `recipients()` → `{to,cc,bcc}` **emails only (no names)**; `close()` = synthetic **Esc** (Gmail normally keeps a draft); `add_compose_button` uses jQuery `.html()`; **no Trusted Types policy** in gmail.js → added live test P2.10 |
| Mapping unit tests (compose kind, recipient normalization and de-dupe, thread-ID parsing) | PASS | `spikes/p2-gmailjs/map.test.ts` 4/4 |
| Spike typecheck (`tsc -p spikes/tsconfig.json`) | PASS | Added to `npm run typecheck` |
| Live P2.3, P2.5–P2.11 | **BLOCKED (manual)** | RUNBOOK §P2 |

### P2 round 3 (2026-11-03): Trusted Types failure investigation
**Reported by you (live Gmail):** `This document requires 'TrustedHTML' assignment. The action has been blocked.` at `page.js:689`.

**Root cause (confirmed by local reproduction):**
- `page.js:689` is **not gmail.js code**. It is the bundled **jQuery 3.7.1** selector engine (Sizzle `setDocument()` → `assert()` feature probe: `el.innerHTML = "<a id='…' href='' disabled='disabled'></a><select …>"`). That probe is inside `try/catch`, so it only produces the console violation you saw.
- The fatal failure comes two probes later: jQuery 3.7.1 `support` feature detection at bundle line 2709 (`div.innerHTML = "<textarea>x</textarea>"`) is **not** inside `try/catch`. Under Trusted Types enforcement it throws an **uncaught TypeError while jQuery initialises**. The whole bundle aborts, so gmail.js and the harness never run.
- So the triggering library operation is **jQuery 3.7.1's module-initialisation feature tests**, which gmail.js depends on (gmail.js's constructor requires jQuery).
- Also found: my round-2 harness's P2.10 probe tried `trustedTypes.createPolicy('default', s => s)`, which is a **permissive policy and is forbidden**. It has been **removed**. The harness now only *observes* `securitypolicyviolation` events.

**Reproduction method:** `spikes/p2-gmailjs/tt/run-tt.mjs` serves a fixture page with a strict CSP (`require-trusted-types-for 'script'; trusted-types 'none'`: no policy may be created at all) and loads the script under test in local headless Chrome. This is stricter than or equal to Gmail's enforcement.

| Bundle under strict TT | Violations | Uncaught errors | Outcome |
|---|---|---|---|
| jQuery 3.7.1 alone | line 689 (caught), line 2709 | `Failed to set the 'innerHTML' property … requires 'TrustedHTML'` | **FAIL**: jQuery never initialises |
| gmail.js 1.1.16 + jQuery 3.7.1 | same | same | **FAIL**: identical root cause |
| Previous harness `page.js` | same | same | **FAIL**: matches your report |
| jQuery **4.0.0** alone | none | none | Initialises. `$('<span>')` and `.html('<b>')` are **still blocked** (correct, secure behaviour); `.text()` works |
| gmail.js 1.1.16 + jQuery **4.0.0** | none | none | Constructs. No jQuery APIs removed in 4.0 are used by gmail.js (its four `.bind` calls are gmail.js's own API) |

**Can gmail.js work under Gmail's TT without weakening security?** Partially:
- Its **data/observer paths** (hidden-input `.val()`, `.html()` *getter*, observers) don't need HTML sinks, and they load cleanly with jQuery 4.0.0.
- Its **UI helpers pass markup strings to jQuery `.html()`** and cannot work without a TT policy, which we won't create:
  - `add_compose_button` (`button.html(content_html)`)
  - `add_toolbar_button`, `add_modal_window`, `infobox`
  - body/name setters
  - `to_wrapper` (`$("<span />")…`)
  
  → They must never be used. Our adapters inject UI with DOM APIs only.
- gmail.js + jQuery 4 is an **untested combination upstream** (gmail.js targets jQuery 3), and gmail.js is unmaintained since 2025-01.

**Native DOM fallback, built and tested:**
| Test (strict TT, headless Chrome, synthetic Gmail-like fixture) | Result |
|---|---|
| Static: `extension/src/gmail/native-adapter.ts` (+ `adapter.ts`, `map.ts`), `panel.ts`, `harness.ts`, `gmailjs-adapter.ts` contain no `innerHTML/outerHTML =`, `insertAdjacentHTML`, `document.write`, `createPolicy` or `.html(` | **PASS** (4 tests) |
| Native bundle: HTML-sink/`createPolicy` occurrences | **0** (13 KB, no jQuery) |
| Native adapter under strict TT: violations / uncaught errors | **0 / 0 → PASS** |
| Diagnostic panel injected via `createElement`/`textContent` | **PASS** (panel present with lines) |
| Compose detection: initial inline reply and a popup compose added later (MutationObserver) | **PASS**: kinds `reply`, `new` |
| Buttons injected next to Send (text only) | **PASS**: 2 per compose |
| Field read (popup): To/Cc/Bcc de-duplicated and lower-cased, Unicode subject, signature detected, attachment detected | **PASS** |
| Thread-row marks (legacy ID and `thread-f:` ID; row without an ID skipped) | **PASS**: 2 marks |
| Thread-view event from `h2[data-legacy-thread-id]` | **PASS** (recorded) |
| gmail.js + jQuery 4 harness bundle under strict TT | **PASS**: 0 violations, 0 errors at load (gmail.js `on_load` can't complete outside real Gmail) |
| **Negative control**: planting `innerHTML` in the panel | Static test **and** both headless runs **FAIL** as intended; restored afterwards |

**Limits of this evidence:** the fixture is **synthetic**. Its structure mirrors the selectors gmail.js 1.1.16 uses, but it is not real Gmail markup. Gmail's actual CSP (exact `trusted-types` allowlist) wasn't read; our fixture forbids all policies, which is at least as strict. **Live Gmail confirmation is still required** (RUNBOOK §P2, now with two variants).

**Decision (2026-11-03): APPROVED by you with conditions.** Native DOM adapter primary (moved to `extension/src/gmail/native-adapter.ts`, with `map.ts` and its tests); gmail.js + jQuery 4.0.0 secondary, experimental and isolated in `spikes/`; no permissive TT policies, no disabling TT, no `innerHTML` string assignment; `GmailUiAdapter` and the compose fallback retained; TT regression tests retained. Added isolation tests (the extension never imports gmail-js/jquery), negatively verified with a planted import. Full check after the move: 34/34 tests, typecheck, build, secret scan 0 findings. **Live Gmail compatibility: NOT YET CONFIRMED.** Awaiting your results.

Original recommendation:
1. Make the **native DOM adapter the primary** `GmailUiAdapter`. It is TT-safe by construction, 13 KB, has no jQuery/gmail.js dependency, and uses the same selectors gmail.js relies on, kept in one `SELECTORS` table.
2. Keep **gmail.js + jQuery 4.0.0** only as a secondary *data-reading* candidate, live-tested side by side. Adopt it only if the native adapter shows a gap that gmail.js's parsing fills (none needed for the MVP's compose-read, row-mark and thread-view functions).
3. Never use gmail.js UI helpers, never create Trusted Types policies, never use HTML sinks. This is enforced by the static tests in `tt/tt.test.ts`.
4. The extension-hosted compose page remains the fallback if live Gmail breaks the selectors.

## P3 — MIME and threading
| Test | Result | Notes |
|---|---|---|
| Offline builder tests (Unicode RFC 2047 split ≤ 75 chars, CRLF, line length ≤ 998, single `To`, threading headers only on copies 2..N, header-injection rejection, display-name quoting, base64url raw, pixel-at-top) | **PASS** | `spikes/p3-mime/mime.test.ts`, 9/9 |
| P3.1–P3.8 Live sends | **BLOCKED** | Needs the P1 token and your own second test account; the harness button is in `spikes/p1-oauth` (1–3 of your own addresses, with a confirm dialog) |

## P4 — Gmail image proxy caching
| Test | Result | Notes |
|---|---|---|
| Harness smoke test via temporary quick tunnel | **PASS** | `cloudflared` 2026.10.7 from the official GitHub release; SHA-256 `2493dbc1…1343` matches the published checksum; stored at `~/.tracklet/bin/` (outside the repo). A public HTTPS GET/HEAD returned a 42-byte GIF with the `no-store` policy; the log shows the IP only as a salted HMAC. **The tunnel and logger were stopped afterwards** |
| P4.1–P4.6 | **BLOCKED** | Needs you to send from A's Gmail and open in B's Gmail (RUNBOOK §P4) |

## P5 — Self-open neutralisation
| Test | Result | Notes |
|---|---|---|
| Harness (content script that neutralises our pixel, plus view reporting) | Ready | `spikes/p5-selfopen` |
| P5.1–P5.5 | **BLOCKED** | Needs A's Gmail session in the test profile plus the P4 harness |

## P6 — Workers / D1
| Test | Result | Notes |
|---|---|---|
| P6.1 Local migration | **PASS** | Applied to a separate spike DB |
| P6.2 1,000 requests × one `db.batch()` (event insert + counter update), 1 in 3 counted | **PASS** | counter **333** = counted events **333**; 1,000 rows total; local batch p50 3 ms / p95 45 ms / max 55 ms (local Miniflare, not edge latency) |
| P6.2b CHECK constraint | **PASS** | An invalid `classification` was rejected: `D1_ERROR: CHECK constraint failed` |
| P6.3–P6.6 deployed (rate-limit binding on Free, edge latency, `waitUntil`, workers.dev cert) | **BLOCKED** | Dev Worker approved; waiting for you to confirm the Cloudflare account is ready (`spikes/p6-dev-worker/README.md`) |

### P6 local rehearsal of the dev Worker (2026-11-03, `wrangler dev --local`; **not** edge results)
| Check | Result | Evidence |
|---|---|---|
| Typecheck (workers-types) | PASS | `tsc -p spikes/p6-dev-worker/tsconfig.json` |
| Migration (synthetic-only table with CHECK `token LIKE 'syn-%'`) | PASS | Applied locally |
| 200 pixel requests | PASS | p50 5.2 ms / p95 6.9 ms / max 60.8 ms (localhost) |
| `waitUntil` writes | PASS | 200/200 rows, max write lag 1 ms |
| Non-synthetic token rejected | PASS | 404 |
| `ratelimits` binding (local simulation) | PASS (local only) | 5×200, then 429,429,429. **Free-plan availability at the edge is still unknown (W-i)** |
| Guarded `/stats` without key | PASS | 403 |
| `.dev.vars` (local SPIKE_KEY) excluded from Git | PASS | `git check-ignore` |

## P1 guard tests (2026-11-03)
| Check | Result | Evidence |
|---|---|---|
| Harness requests exactly the 3 approved scopes | PASS | `spikes/p1-oauth/guards.test.ts` compares against `shared` `OAUTH_SCOPES` |
| No raw token passed to `log()` | PASS | Static test; **negative test**: a planted `log(..., { t })` made the test fail, then the file was restored (no diff) |
| Interactive consent only inside click handlers | PASS | Static test |
| No client-secret handling | PASS | Static test plus the secret scan |

---

## Summary
| Spike | Status |
|---|---|
| Phase 0 | PASS (manual unpacked-load confirmation pending) |
| P1 | BLOCKED: OAuth client |
| P2 | InboxSDK FAIL (rejected). **gmail.js + jQuery 3.7.1 FAIL under Trusted Types** (root cause: jQuery 3 load-time `innerHTML` feature tests). Native DOM adapter PASS under strict TT (synthetic fixture); gmail.js + jQuery 4 loads cleanly. Live Gmail BLOCKED (manual, both variants) |
| P3 | Offline PASS; live BLOCKED (P1) |
| P4 | Harness PASS; tests BLOCKED (manual Gmail) |
| P5 | Harness ready; BLOCKED (manual Gmail) |
| P6 | Local PASS; dev-Worker local rehearsal PASS; deployed BLOCKED (waiting for your Cloudflare account confirmation) |
