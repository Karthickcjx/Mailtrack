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

### P2 round 4 (2026-11-03): gmail.js variant initialization failure
**Reported by you (live Gmail, Chrome 156, `dist-gmailjs`):** `[P2] P2.9 load FAIL TypeError: this.gmail.observe.on_load is not a function`; the P2 panel never appeared.

**Root cause:**
1. **Wrong API (my error).** `spikes/p2-gmailjs/gmailjs-adapter.ts` `ready()` called `this.gmail.observe.on_load(cb)`. That method **does not exist** in the installed gmail.js **1.1.16**: zero occurrences of `on_load` in `node_modules/gmail-js/src/gmail.js` or `gmail.d.ts`. It was the only `on_load` usage in the repo. The verified readiness API is the **event** `gmail.observe.on('load', callback)`:
   - `gmail.d.ts:813`: `on(action: "load", callback: () => void): void;`
   - README: "**load** - When the gmail interface has finished loading"
   - Implemented in `gmail.js:2728` (`else if(action === "load")`). It calls back immediately if `api.dom.inbox_content()` (`div[role=main]`) exists; otherwise it polls every 200 ms ×50, then fires anyway after 5 s. So registering late is safe.
2. **Panel never shown (harness bug).** The gmail.js variant runs at `document_start`, before `<body>` exists. The TypeError rejected synchronously, so the only `record()` happened while `document.body` was null (`render()` no-ops), and nothing re-rendered later.

**Other gmail.js calls re-verified against the installed source:** `observe.on` (2326), `observe.off` (2384), `new.get.thread_id` / `get.thread_id`, `dom.inbox_content`; compose methods `id`, `recipients`, `subject`, `body`, `attachments`, `close`, `$el`; the compose observer invokes `callback(match, match.type())` (2573), matching the adapter's `(compose, type)`.

**Changes (gmail.js stays isolated in `spikes/`; native adapter and `extension/` unchanged, `git diff extension/` empty):**
- `gmailjs-adapter.ts`: `ready()` uses `observe.on('load', …)`, with an explicit mismatch error if `observe.on` is missing. Added a typed `GmailJsApi` interface of the verified surface. gmail.js and the marks are injectable via the constructor, for tests.
- `harness.ts`: re-renders the panel on `DOMContentLoaded`, so early results and failures are visible.

**Regression tests:**
| Test | Result |
|---|---|
| Unit (strict fake that throws on any unverified member): `ready()` registers exactly `'load'` and resolves only when it fires | PASS |
| Unit: `ready()` never touches `observe.on_load` | PASS |
| Unit: clear error when the API doesn't match | PASS |
| Unit: `onCompose` registers `'compose'` and maps `(compose,'reply')` to a handle with a correct snapshot; disposer calls `off('compose')` | PASS |
| Unit: `onThreadViewed` registers `'view_thread'` and reads `new.get.thread_id()` | PASS |
| Contract with the installed package: version 1.1.16; typings declare `load`/`compose`/`view_thread`; source implements `load`; no `on_load` in package or adapter | PASS (4) |
| **Negative control:** restoring `observe.on_load` in the adapter | 3 tests FAIL as intended; restored → 9/9 PASS |
| Headless Chrome, strict TT, real gmail.js 1.1.16 + jQuery 4.0.0, synthetic shell with `div[role=main]`: constructs, `ready()` resolves (2 ms), compose and view_thread register | PASS (0 violations, 0 errors) |
| Control: same bundle **without** `div[role=main]` → `ready: false` within the 1.5 s window | As expected (proves it waits for gmail.js's load check) |
| Full check: typecheck (incl. spikes), **44/44 tests**, build, secret scan (0 findings), isolation tests | PASS |
| Rebuilt `dist-native` (13 KB, 0 sinks) and `dist-gmailjs` (361 KB, 2 jQuery-internal sink sites, 0 `on_load`) | Built |

**Live Gmail status: NOT CONFIRMED.** Needs your re-test of both variants.

### P2 round 5 (2026-11-03): live Gmail results for the gmail.js variant (reported by you)
Environment: Chrome 156 (exact build not supplied), live Gmail, `dist-gmailjs` (gmail.js 1.1.16 + jQuery 4.0.0, built after the round-4 fix).
Evidence type: **values transcribed by you** in your message. The harness's **Copy results** JSON was **not supplied**, so nothing below is backed by a machine-recorded artefact in this repo.

**A. Live results with reported values (confirmed by your supplied results)**
| Test | Result | Reported value |
|---|---|---|
| P2.9 load (gmail.js initialises via `observe.on('load')`) | **PASS** | 2,345 ms |
| P2.5 compose detection | **PASS** | — |
| P2.5 button injection (DOM-built "P2: Read" / "P2: Close") | **PASS** | — |
| P2.3 unexpected hosts after 60 s (harness PerformanceObserver) | **PASS** | 0 hosts |
| P2.10 Trusted Types violations after 60 s (passive observer) | **PASS** | 0 violations |
| P2.6 field reading (recipients and subject) | **PASS** (reported as working) | No per-compose details supplied |

**B. Confirmed manually, without machine-recorded evidence**
| Test | Status | Missing evidence |
|---|---|---|
| P2.6 To/Cc/Bcc split (de-duplicated, lower-cased) | Manually confirmed | Copy-results JSON with redacted `to/cc/bcc` arrays |
| P2.6 Unicode subject `P2 Résumé ✓ 測試` | Manually confirmed | JSON `subject` field |
| P2.8 Gmail row detection and thread IDs | Manually confirmed | Panel `rows {rows, withId, totalMarks}` values and which views (Sent/Inbox/search) |

These are recorded as **manually confirmed**, not PASS. They become PASS once the JSON is attached.

**C. Not yet performed or not reported (no PASS claimed)**
| Runbook step | Test | Status |
|---|---|---|
| 6 | 10 composes incl. **attachment** (`hasAttachments`) and **signature** (`htmlHasSignatureDiv`); last address not yet a chip | NOT PERFORMED / NOT REPORTED |
| 7 | **P2.7 draft preservation** after "P2: Close" (Esc): does a draft remain in Drafts? | NOT PERFORMED / NOT REPORTED |
| 8 | **Reply / forward** detection (`kind` = `reply` / `forward`) | NOT PERFORMED / NOT REPORTED |
| 9 | **P2.8 ✓ marks** visible in **Sent, Inbox and search**; `withId == rows`; after 5 folder switches | NOT PERFORMED / NOT REPORTED (only "row detection and IDs work") |
| 10 | **P2.11 thread view** events (3 threads → 3 `view_thread` IDs) | NOT PERFORMED / NOT REPORTED |
| 12 | **10 Gmail reloads** plus Inbox ↔ Sent switching without uncaught `page.js` errors | NOT PERFORMED / NOT REPORTED |
| 11 | **DevTools Network filter** check (independent of the harness observer) | NOT PERFORMED / NOT REPORTED |
| 2–13 | **Entire native-dom variant (`dist-native`) on live Gmail** | **NOT PERFORMED** |
| 13 | Copy-results JSON for either variant | NOT SUPPLIED |

**D. Adapter comparison with the evidence available**
| Criterion | native-dom (primary) | gmail.js 1.1.16 + jQuery 4.0.0 (experimental) |
|---|---|---|
| Live Gmail load / TT / network | **No live data yet** | PASS (2,345 ms; 0 TT violations; 0 unexpected hosts) |
| Live compose detection, buttons, field reads | **No live data yet** | PASS / manually confirmed |
| Strict-TT headless tests (synthetic fixtures) | PASS: full flow (panel, compose, fields, marks, view) | PASS: load and observer registration |
| Bundle size | 13 KB | 361 KB |
| HTML-sink sites in bundle | 0 | 2 (jQuery internals; reached only if markup is passed, which our code never does) |
| Dependencies | None | gmail.js (last release 2025-01) + jQuery 4 (combination untested upstream) |
| Gmail-change exposure | Own `SELECTORS` table (derived from gmail.js's selectors) | gmail.js internals + XHR/embedded-data parsing |
| Load timing | `document_idle`; DOM-ready | `document_start` required; ~2.3 s to `load` live |

**Decision:** **native-dom stays the production primary adapter.** The live evidence shows gmail.js *can* run safely under Gmail's Trusted Types with jQuery 4. That validates the isolated experimental candidate; it doesn't show native-dom is deficient, because native-dom hasn't been live-tested yet. Nothing in the evidence justifies changing D12. Re-evaluate only if the native live run fails where gmail.js succeeds. gmail.js and jQuery remain isolated under `spikes/` (verified by isolation tests, see below).

**Note on what this does and doesn't prove:** gmail.js's selectors (compose root, recipient chips, subject box, `.gU.Up` send row, `tr.zA` rows) working on live Gmail is **indirect, supportive evidence** for the native adapter, which uses the same selectors. It is **not** a substitute for running `dist-native` live.

### P2 round 6 (2026-11-03): native-dom live-test preparation (no live results yet)
**Native live compatibility: NOT TESTED.** Everything below is local, automated preparation.

| Item | Result | Evidence |
|---|---|---|
| Reproducible builds | PASS | Two consecutive builds per variant → identical `buildId` and `page.js` SHA-256 (`build.test.ts`); native `native-…`, gmail.js `gmailjs-…`; `build-info.json` records variant, sources, versions, hash and sink count |
| Report identifies variant and build | PASS | Report `schema: tracklet-p2-report/2`, `variant`, `buildId`, `adapter`, `startedAt`; build ID also in the panel title |
| Report coverage of every runbook check | PASS | `report.ts` `REQUIRED_CHECKS` (17 automated checks) plus 3 explicit `MANUAL` checks; an empty run reports all 17 MISSING (never PASS without evidence) |
| Per-view row evidence (Sent / Inbox / search) | Added | `viewStats` sampled 2.5 s after each hash change and every 10 s; view names carry no thread IDs or search terms |
| Uncaught harness errors per page load (P2.12) | Added | `isOwnError` filter ignores Gmail's own errors |
| Copy-results fallback | Added | Report always logged to the Console; button shows "Copy blocked: … run copy(__P2_REPORT())" |
| **Bug found and fixed in the native adapter** (`extension/src/gmail/native-adapter.ts`) | FIXED | The mark span set `data-thread-id` on itself; on the next 1.5 s repaint `row.querySelector('[data-thread-id]')` matched our own mark (no `thread-f:` prefix) → row treated as ID-less, `withId` dropped, and the mark was never updated again. Fix: marks use `data-tracklet-thread-id` / `data-tracklet-state`, and the ID selectors exclude `.tracklet-mark`. **Negative control:** reverting reproduces `withId 1 ≠ 2` |
| Test-runner bug fixed | FIXED | `run-tt.mjs` decoded Chrome stdout per chunk, corrupting UTF-8 split at a chunk boundary (`Résum��`); now decodes once |
| Headless strict-TT fixture extended | PASS | Forward compose added; starts in `#sent`; asserts kinds `new/reply/forward`, buttons on all three composes, report identity, `viewStats` (3 rows, 2 IDs, 2 marks after repaint), and coverage present/missing exactly as expected |
| Static TT checks + isolation | PASS | No `innerHTML/outerHTML =`, `insertAdjacentHTML`, `document.write`, `createPolicy` or `.html(` in the adapters, panel, harness or report; no gmail-js/jquery in `extension/ shared/ backend/`; native bundle contains no jQuery/gmail.js; both manifests have `permissions: []` and no host permissions |

**Untested on live Gmail (native adapter):**
- Whether `div.M9`, peoplekit chips, `input[name=subjectbox]`, `div.dL`, `.gU.Up`, `tr.zA` and `h2[data-legacy-thread-id]` match current Gmail markup. They worked for the gmail.js variant in round 5, which uses the same selectors and the native row-marking code, but that's indirect evidence.
- Whether a synthetic (untrusted) Esc keydown closes the composer (the same approach as gmail.js; unverified for either).
- The performance cost of the document-wide MutationObserver used for thread-view detection.

### P2 round 7 (2026-11-03): native-dom on LIVE Gmail (automated by Claude via browser automation)
**Tested build:** `native-aeafee4d9bfd` (`spikes/p2-gmailjs/dist-native`), loaded unpacked by you.
**Browser:** you stated Edge with the Claude extension. The page's user agent reported `Chrome/156.0.0.0` with no `Edg/` token, so the brand is recorded as stated, not verified. Gmail account: your real account (read-mostly; see "side effects").
**Evidence:** live tool outputs in this session, plus the redacted report JSON `spikes/p2-live/round7-native-pageload2.json` (thread IDs replaced with `thread-N`; recipients are synthetic `@example.com`).
**Synthetic vs live:** every row below marked LIVE ran on real Gmail. The FIXED rows were reproduced on live Gmail, fixed, and verified **only on the synthetic fixture** so far (they need a re-run with the new build).

| # | Runbook step / check | Result | Live evidence |
|---|---|---|---|
| 2 | P2.9 load; panel identifies `native` + build ID | **PASS (LIVE)** | Panel `P2 harness (native) native-aeafee4d9bfd`; report `schema tracklet-p2-report/2`, `variant native`, `adapter native-dom` |
| 3 | P2.8 Inbox / Sent / search rows + marks | **PASS (LIVE)** | 50/50/50 visible rows, every row ID'd and marked, 0 duplicates, 0 marks carrying Gmail ID attributes, all marks use `data-tracklet-thread-id` / `data-tracklet-state`, IDs stable across repaints (checked about 7 s after load) |
| 4 | P2.11 thread-view events (3 distinct, view-tagged) | **PASS (LIVE)** | 4 distinct thread IDs; views `sent-thread` / `search-thread` |
| 5 | P2.5 new compose + buttons | **PASS (LIVE)** | `kind: new`, "P2: Read" / "P2: Close" next to Send |
| 5 | P2.6 To/Cc/Bcc (committed chips) | **PASS (LIVE)** | to 2, cc 1, bcc 1 (read while the recipient area was collapsed) |
| 5 | P2.6 To/Cc/Bcc (addresses typed with commas, not committed) | **FAIL (LIVE) → FIXED** | Adapter read 0/0/0 while Gmail's own summary showed "p2-to1@example.com · 3 more (1 Bcc)". Root cause: only chips (`[data-hovercard-id]`) were read; uncommitted text sits in the field's `<input>`. Fix: also parse email tokens from `div[name=f] input:not([type=hidden])`. Regression: unit test `emailsInText` + fixture compose with typed recipients; negative control fails without the fix. **Live re-test pending** |
| 5 | P2.6 Unicode subject | **PASS (LIVE)** | `P2 Résumé ✓ 測試` exact |
| 5 | P2.6 body | **PASS (LIVE)** | `htmlLength 44` |
| 5 | P2.6 attachment | **PASS (LIVE)** | `false` before upload, `true` after (`div.dL` present; synthetic 1 KB text file) |
| 5 | P2.6 signature | **BLOCKED** | The account has no Gmail signature; adding one changes account settings (needs your approval or your action) |
| 6 | P2.7 Close (synthetic Esc) + draft preserved | **PASS (LIVE)** | Composer closed (0 open); Drafts 8 → 9; draft has the subject, body and attachment |
| 7 | P2.5 reply | **PASS (LIVE)** | `kind: reply`, inside `.AO`, hidden subject `Re: …`, 2 buttons |
| 7 | P2.5 forward | **PASS (LIVE)** | `kind: forward`, hidden subject `Fwd: …`, 2 buttons |
| 8 | P2.10 Trusted Types after 60 s | **PASS (LIVE)** | 0 violations on every page load (1 + 10 reloads) |
| 8 | P2.3 unexpected hosts after 60 s (harness observer) | **PASS (LIVE)** | `{}` |
| 10 | Network inspection (substitute for the DevTools filter: the browser tool's request log, 79 requests across reloads) | **PASS (LIVE, substitute)** | Only Google hosts: `mail.google.com`, `play.google.com`, `*.clients6.google.com` (peoplestack-pa, taskassist-pa, appsgrowthpromo-pa, subscriptionsfirstparty-pa), `www.google.com`, `ssl.gstatic.com`, `www.gstatic.com`. The harness made no requests. (Two 503s and a `jserror` beacon are Gmail's own.) The DevTools UI itself was not used |
| 11 | 10 full reloads alternating Inbox / Sent | **PASS (LIVE)** | Each reload got a new `startedAt` (14:13:33 → 14:15:23); every load: correct build, P2.9 PASS, 0 harness errors, 0 TT violations, 50/50 rows marked, 0 duplicates. (An earlier 10-step attempt with `navigate` only changed the hash, `startedAt` unchanged, so it's counted as navigation, **not** reloads) |
| — | Compose detection after reloads | **PASS (LIVE)** | `new` detected with 2 buttons after reload 10 |
| — | P2.12 harness uncaught errors | **PASS (LIVE)** | 0 on every page load |
| — | Repaint churn / observer self-triggering | **FAIL (LIVE) → FIXED** | Idle 6 s: **0** Gmail mutations vs **800** on our own marks (50 rows × 4 writes per 1.5 s repaint: `textContent` + 3 attributes, unconditional). The childList records woke the adapter's own document-wide observer (7 callbacks / 10 s). Fix: write mark values only when they change. Regression: fixture counts mutations on marks after first paint (must be 0); negative control fails without the fix. **Live re-test pending** |
| — | Performance | RECORDED (LIVE) | Before the fix: ≈0.085 ms CPU/s at idle; paintRows-equivalent 0.068 ms per pass over 50 rows; 0 long tasks > 50 ms in 10 s |

**Report coverage on one page load** (`round7-native-pageload2.json`): 16/17 PRESENT; MISSING only `P2.6-signature`.

**Observations and limitations (not failures):**
- `rowStats` counts every `tr.zA` in the DOM, including Gmail's hidden cached list views, so numbers accumulate across views (50 → 109 → 150). Coverage uses `withId == rows`, which still holds.
- The diagnostic panel (bottom-left) can cover Gmail's Reply button in an open thread; a click aimed at Reply opened another thread instead. This is a harness-only layout issue.
- The first `viewStats` sample can be `rows 0` (taken before Gmail renders); it doesn't satisfy coverage.
- Adapter kind detection for inline composes uses the subject prefix (`Fw…` → forward). A *reply* in a thread whose subject starts with "Fwd:" could be misclassified. Not observed (the reply hidden subject was `Re: …`), but not exhaustively tested.

**Side effects on your mailbox (disclosed):**
- One saved test draft remains in Drafts (subject `P2 Résumé ✓ 測試`, synthetic `@example.com` recipients, 1 KB synthetic attachment). **Not deleted:** deleting a draft is permanent, so please delete it yourself.
- Two empty reply/forward composers were discarded (never saved as drafts).
- Opened threads were from Sent / `in:sent` except one: an accidental navigation opened one real conversation (labels Inbox + Sent; subject withheld). If it contained an unread message, it is now marked read.
- Nothing was sent; no settings were changed.

**Rebuilt after the fixes:** `native-17464e23d75d`.

#### Round 7b (2026-11-03): live re-test of the two fixes, build `native-17464e23d75d` (reloaded by you)
| Check | Result | Live evidence |
|---|---|---|
| Panel / report identify the new build | **PASS (LIVE)** | `P2 harness (native) native-17464e23d75d`, P2.9 PASS, 50/50 Sent rows marked |
| Repaint churn (fix 2) | **PASS (LIVE)** | 6 s idle: **0** mutation records on our marks (was 800 on the old build); 50/50 rows with IDs, 0 unmarked, 0 duplicates, 0 marks with Gmail ID attributes, 50/50 with `data-tracklet-*`. The remaining observer activity (8 records / 6 s) is Gmail's own |
| Uncommitted typed recipients (fix 1) | **PASS (LIVE)** | Reproduced the original condition exactly (0 chips; raw text 38/18/19 chars in To/Cc/Bcc inputs). "P2: Read" now returns To 2, Cc 1, Bcc 1 (was 0/0/0); 0 harness errors, 0 TT violations |
| Cleanup | Done | The synthetic compose was discarded with Gmail's "Discard draft"; Drafts shows no test drafts (you had deleted the round-7 draft) |

**P2 native status after round 7b:** all automated checks PASS on live Gmail except `P2.6-signature` (BLOCKED: no signature configured on the account).

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
| P2 | InboxSDK FAIL (rejected). **gmail.js + jQuery 3.7.1 FAIL under Trusted Types** (root cause: jQuery 3 load-time `innerHTML` feature tests). Native DOM adapter PASS under strict TT (synthetic fixture). **Live gmail.js variant (round 5, reported): load / compose / buttons / TT 0 / hosts 0 PASS; field reads and row IDs manually confirmed.** Remaining live gaps: drafts, attachments/signature, reply/forward, marks across views, thread view, 10 reloads, DevTools network, **entire native-dom live run** |
| P3 | Offline PASS; live BLOCKED (P1) |
| P4 | Harness PASS; tests BLOCKED (manual Gmail) |
| P5 | Harness ready; BLOCKED (manual Gmail) |
| P6 | Local PASS; dev-Worker local rehearsal PASS; deployed BLOCKED (waiting for your Cloudflare account confirmation) |
