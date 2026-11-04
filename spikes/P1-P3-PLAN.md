# P1 (OAuth) + P3 (MIME) — test plan and readiness (2026-11-03)

Branch `phase-p-and-0` @ `50d5859` + uncommitted prep changes (shim fix + tests, this plan, RESULTS entry).
**Live testing is NOT started.** It needs your Google Cloud setup and your explicit approval. P3 live steps send real emails, to your own test account only.

## 1. Fixed facts that shape the plan
| Item | Value |
|---|---|
| Approved scopes (unchanged) | `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/gmail.send` (`shared/src/index.ts`; enforced by tests) |
| Auth method (Q14) | `chrome.identity.getAuthToken()` + Google OAuth client of type **Chrome Extension**; no client secret |
| Stable extension ID (Q15) | `hhejoehmmjbjahinnpgnfhfakbkhilcd` (`extension/manifest.key.json`; private key outside the repo) |
| P1/P3 spike permissions | `identity`, `identity.email`; hosts `oauth2.googleapis.com`, `gmail.googleapis.com`. Spike only (committed in `af06bca`); the product extension still has `permissions: []` |
| **Browser** | **Google Chrome only (Q13).** Microsoft Edge is widely documented as not implementing `chrome.identity.getAuthToken`; not re-verified here. P1 must run in a **Chrome** profile. The P2 automation ran in a browser you described as Edge; its UA showed `Chrome/156` with no `Edg/` token, so please confirm which browser you'll use |
| ID collision | The P1 spike uses the same key and ID as the product extension (`extension/dist`). **Never load both in the same profile.** Remove "Tracklet (personal, dev)" before loading the spike |

## 2. Offline vs live
| Test | Offline (done now) | Needs Google Cloud project + OAuth client | Sends email |
|---|---|---|---|
| P1 guards (scopes = 3, no raw token in logs, consent only on click, no secrets) | **PASS** 4/4 | — | — |
| P1 spike build: manifest scopes, permissions, key → ID, bundle hosts, no secrets | **PASS** | — | — |
| P1.1 loaded ID = OAuth client Item ID | — | **yes** (manual check) | no |
| P1.2 interactive consent (unverified-app screen, scopes listed) | — | **yes** | no |
| P1.3 silent token ×5 over 10 min | — | **yes** | no |
| P1.4 non-default account in profile | — | **yes** | no |
| P1.5 remove cached token → silent renewal | — | **yes** | no |
| P1.6 tokeninfo `aud`/`email`/`scope` | — | **yes** | no |
| P1.7 revoke → re-consent | — | **yes** | no |
| P1.8 day-8 Testing-mode expiry | — | **yes** (calendar) | no |
| P3 MIME builder (RFC 2047, CRLF, ≤998, single To, threading headers, injection, base64url, pixel at top) | **PASS** 9/9 | — | — |
| P3 browser shim parity incl. 250 KB / 300 KB message | **PASS** 6/6 (after fix, below) | — | — |
| P3.1 single copy, Unicode subject, HTML+text | — | **yes** | **yes** (1 to your test account) |
| P3.2 three single-recipient copies + threading | — | **yes** | **yes** (≤3, your own addresses/aliases) |
| P3.3 Message-ID kept or replaced (Show original) | — | **yes** | (uses P3.2 mail) |
| P3.4 Sent grouping | — | **yes** | (uses P3.2 mail) |
| P3.5 recipient replies → only you | — | **yes** | **yes** (1 reply from your test account) |
| P3.6 Bcc-only header | not supported by harness (see §4) | — | — |
| P3.7 10-copy loop / quota | not supported by harness (max 3) (see §4) | — | — |
| P3.8 From mismatch | not supported by harness (see §4) | — | — |

## 3. Manual setup checklist (you)
Use the account you'll track from, in **Google Chrome**.

**A. Chrome profile**
1. Chrome → profile menu → Add → name "Tracklet test" → sign in with the tracking Gmail account.
2. `chrome://extensions` → Developer mode ON. Remove "Tracklet (personal, dev)" and any "Tracklet P1/P3 spike" if present.

**B. Google Cloud** (full detail in `docs/setup/SETUP_GOOGLE_CLOUD.md` §A–E-1; do **not** do §E-2)
1. console.cloud.google.com → New Project `tracklet-personal` (no organization).
2. APIs & Services → Library → **Gmail API** → Enable. Note the per-user quota shown on its Quotas page.
3. OAuth consent / Google Auth Platform:
   - User type **External**; publishing status **Testing** (do **not** publish).
   - App name `Tracklet (personal)`; support and contact email = your address; no logo.
   - Test users: add your tracking address (and the second test account only if it will sign in; receiving needs nothing).
   - Data Access → add **exactly**: `openid`, `.../auth/userinfo.email`, `.../auth/gmail.send`.
4. Clients → Create client → type **Chrome Extension** → name `tracklet-extension` → **Item ID `hhejoehmmjbjahinnpgnfhfakbkhilcd`** → Create. There is no secret for this type; if any screen offers one, don't copy it anywhere.
5. Send me **only**: the Project ID, the **Client ID** (`…apps.googleusercontent.com`), and the Gmail API per-user quota value. These are public identifiers.

**C. Test inbox**
- The second Gmail account (B) for receiving. For P3.2 you can use B plus aliases `B+cc@gmail.com`, `B+bcc@gmail.com`.

**Do not:** publish the app, enable billing, add any other scope, or create or download a client secret.

## 4. Harness gaps (decide before live)
| Gap | Recommendation |
|---|---|
| P3.6 Bcc-only, P3.8 From mismatch | Mark **not applicable to the MVP**: the MVP always sends `From` = the signed-in account and exactly one `To` per copy. Drop them from the plan |
| P3.7 10-copy quota loop | Replace with "3 copies, timed": quota is already documented (VERIFIED M-f); sending 10 real emails adds little evidence. Raise the cap to 10 only if you want it |
| P1.4 needs a Gaia account ID | The popup's "Profile info" button shows the profile account's ID; for a second account the harness passes the ID you paste. If `getAccounts()` is unavailable (it's not in stable Chrome), P1.4 = RECORDED limitation |
| `tokeninfo` is called with the access token in the query string | This is Google's documented endpoint, over HTTPS to Google only; the token is never logged. Acceptable for the spike; the backend (Phase 1) will do the same server-side |
| Popup "Profile info" shows your email and Gaia ID in the local popup log | Redact before pasting logs into `RESULTS.md` |

## 5. Live run order (after your approval)
1. Build: `TRACKLET_OAUTH_CLIENT_ID=<client-id> node spikes/p1-oauth/build.mjs` → load unpacked `spikes/p1-oauth/dist` in the Chrome "Tracklet test" profile.
2. P1.1 → P1.2 → P1.6 → P1.3 (×5 / 10 min) → P1.5 → P1.4 → (P3 below) → P1.7 last (it revokes). P1.8 on day 8.
3. P3: P3.1 / P3.2 via the popup's "Send test copies" (your own addresses only; there is a confirm dialog), then inspect B's inbox and your Sent ("Show original" for P3.3), then reply-all from B (P3.5).
4. Paste the popup log (redacted) and your observations; I record PASS/FAIL/BLOCKED in `spikes/RESULTS.md`.
