# OPEN QUESTIONS — rev 4 (2026-11-03)

## Rev 4 decisions (by you, 2026-11-03), superseding the "New decisions needed" table below
| # | Decision | Conditions |
|---|---|---|
| **Q14** | **APPROVED:** `chrome.identity.getAuthToken()` with a Google OAuth **Chrome Extension** client (D2-rev applied). `launchWebAuthFlow` is not the primary method. | Stable extension ID; scopes limited to `openid`, `userinfo.email`, `gmail.send`; no client secrets; interactive authorization only after a clear user action; test account selection, caching, expiry, revocation and re-consent; document that automatic access-token renewal does **not** remove the need for consent (Testing-mode 7-day expiry, revocation and password change still force re-consent). Initial tests use a **dedicated Chrome profile** for the tracking Gmail account. |
| **Q15** | **APPROVED:** a locally generated extension key | The private PEM stays outside Git (stored outside the repo, plus `.gitignore` rules); never published or shared; the procedure for preserving the ID is documented in `docs/setup/EXTENSION_ID.md`. |
| **Q16** | **NOT APPROVED** for registration | Inspect the licence, terms, privacy implications, external network calls and MV3 compatibility, and compare with gmail.js. Do not register or send data to the vendor. |
| **Q17** | **APPROVED** temporarily | Official Cloudflare download only; quick tunnel only while P4/P5 run; no permanent tunnel. |
| Phases | **APPROVED:** Phase P (P1–P6) and Phase 0 | No full product, no production tracking, no sends to real recipients, no production deploy, no purchases. |

## Decisions recorded
| # | Question | Decision (by you) | Applied as |
|---|---|---|---|
| Q1 | Account type | Consumer Gmail, External app, Testing | D1 |
| Q2 | InboxSDK | Conditional on spike P2 | D12 |
| Q3 | Domain | workers.dev now, custom domain later | D3 |
| Q4 | Tracked replies | Not in MVP | D7 |
| Q5 | Group sends | Individual copies; group is opt-in | D4–D6 |
| Q6 | Attachments | Blocked in MVP | D8 |
| Q7 | Disclosure | Optional, off by default | D9 |
| Q8 | Subjects on backend | Not stored by default | D10 |
| **Q9** | Who creates the Google Cloud project and OAuth client | **You**, using `docs/setup/SETUP_GOOGLE_CLOUD.md` | — |
| **Q10** | Cloudflare account | **You** create it, with a **neutral** workers.dev subdomain, using `docs/setup/SETUP_CLOUDFLARE.md` | D3 |
| **Q11** | Test inboxes | **Second Gmail account** first; Outlook/iCloud later if available | PROTOTYPE_TEST_PLAN |
| **Q12** | Recipient addresses | **Never stored readable on the backend by default.** Local to the extension; the backend gets only an HMAC `recipient_key` | D11 (confirmed) |
| **Q13** | Browsers | **Chrome only** for the MVP | — |

## New decisions needed (raised by the documentation check)
| # | Question | Why it came up | Recommendation |
|---|---|---|---|
| **Q14** | **Change D2 from `launchWebAuthFlow` + implicit grant to `chrome.identity.getAuthToken` + the "Chrome Extension" OAuth client?** | Google's implicit-flow page says it is "provided only for legacy support", "considered insecure", and direct use is "strongly discouraged" (VERIFIED O1). Google says "For Chrome extensions, use the Chrome Extension application type" (O5), which has no client secret (O6). The rev 2 reason for avoiding `getAuthToken` (Chrome-only, profile-account coupling) is weaker now that Q13 = Chrome only, and `getAuthToken` can select a non-Sync profile account via `account` (C-b). The authorization-code + PKCE flow with a Web client is not usable: the docs don't confirm a secret-less exchange (O4), and a secret must never ship. | **Approve D2-rev:** `getAuthToken` + Chrome Extension client. Condition: the tracking Gmail account must be signed into the Chrome profile (as Sync or as an added web account), which P1.4 verifies. Fallback: `launchWebAuthFlow`, only if P1 fails. **This changes the architecture, so I have not applied it without your approval.** |
| **Q15** | How to obtain the stable extension ID | Official method: an unpublished upload to the Chrome Web Store Developer Dashboard (C-d), which needs a developer registration (historically a one-time fee). A locally generated key also works but isn't in the docs I read. | **Local key** (free); switch to the dashboard if Chrome or the OAuth client rejects it in P1.1 |
| **Q16** | InboxSDK App ID registration with its vendor: do you agree to register (your account with a third party)? | Needed for the InboxSDK part of P2 only | Yes, after P2.1/P2.2 (licence and terms) pass; otherwise skip InboxSDK |
| **Q17** | Approve downloading the `cloudflared` binary for a free quick tunnel so P4/P5 can run **before** the Cloudflare account exists? | P4/P5 need a public HTTPS logger | Optional. Simpler alternative: run P4/P5 after the Cloudflare account exists, using a dev Worker |

## Corrections from the documentation check (applied to ARCHITECTURE rev 3)
| Previous statement | Verified fact | Source |
|---|---|---|
| Gmail per-user quota "250 units/second", throttle 600 ms | 6,000 units **per minute** per user per project (≈60 sends/min); projects created after 2026-05-01 may have different quotas, so check the console | M-f |
| "Gmail adds Message-ID / strips Bcc" | Not stated in the official pages → prototype P3.3/P3.6 | M-e |
| Max message 35 MB | Not stated in the pages read → irrelevant (no attachments) | M-e |
| WAF rules don't apply to workers.dev | Not stated → treated as an inference; we don't use WAF rules | W-k |
| Rate Limiting binding on Free | Not stated → P6.3 | W-i |
| Implicit flow is fine | "Strongly discouraged / legacy" → Q14 | O1 |
| "CASA" for restricted scopes | Docs say a "security assessment" is required when restricted-scope data is stored or transmitted by servers; the CASA name and cost weren't on the pages read | V-f, V-g |
| Testing 7-day expiry | Confirmed; applies because we request `gmail.send`; there is also a 100 test-user limit | O8, V-a |
| `gmail.send` sensitive, no security assessment | Confirmed sensitive; no assessment mentioned for sensitive scopes | M-a, V-f |
| Alarms may not survive restart | Chrome 150+ `persistAcrossSessions` defaults true; still recreate on startup | C-g |
| `waitUntil` duration | Up to 30 s after the response | W-e |
| D1 limits | 500 MB/db, 5 GB/account, 5M reads, 100k writes per day, 50 queries per invocation (batch = 1) | W-f, W-g |

## Remaining prototype unknowns
U1 P1 token behaviour, multi-account and 7-day expiry · U2 P2 InboxSDK/gmail.js · U3 P3 Message-ID and threading · U4 P4 proxy caching · U5 P5 self-open suppression · U6 P6 rate-limit binding · U7 Apple MPP / Safe Links fingerprints (later test inboxes) · U8 workers.dev deliverability.

## Blockers
| Blocker | Blocks | Resolved by |
|---|---|---|
| Q14 answer | Choosing the OAuth client type (SETUP_GOOGLE_CLOUD §E), P1 | You |
| Q15 answer + Phase 0 key generation | Extension ID → OAuth client → P1, P3 | You, then Claude (after approval) |
| Google Cloud project (sections A–D) | P1, P3 | You (can start now) |
| Cloudflare account | P6 deployed tests; P4/P5 unless Q17 | You (can start now) |
| Q16 | InboxSDK half of P2 | You |
| Approval to start Phase P + Phase 0 code | All spikes | You |
