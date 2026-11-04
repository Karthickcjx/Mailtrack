# ARCHITECTURE — Personal Gmail Tracker (working name: "Tracklet")

Status: **REVISED DRAFT (rev 3), awaiting approval.** No code, packages, accounts, OAuth settings or deployments exist.

> **Rev 7 (2026-11-03): D12 changed (approved by you), based on P2 round 3 evidence.**
> - **Primary Gmail integration: native DOM adapter** (`extension/src/gmail/native-adapter.ts`, implementing `GmailUiAdapter`). Root cause of the live failure: jQuery 3.7.1, required by gmail.js, assigns HTML strings to `innerHTML` in uncaught load-time feature tests, which Gmail's Trusted Types enforcement blocks (spikes/RESULTS.md P2 round 3).
> - **gmail.js 1.1.16 + jQuery 4.0.0: secondary, experimental, isolated** under `spikes/p2-gmailjs/`. Data reads only; its UI helpers (which pass markup to `.html()`) are never used. Tests enforce that `extension/`, `shared/` and `backend/` never import gmail-js or jquery.
> - **Hard rules (tested):** no permissive or any Trusted Types policies, no disabling TT, no HTML-string assignment (`innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/jQuery `.html(str)`). Reading `innerHTML` (getter) is allowed. Regression tests: `spikes/p2-gmailjs/tt/tt.test.ts` (strict-TT headless Chrome plus static scans).
> - `GmailUiAdapter` and the extension-owned compose page (fallback) are retained unchanged.
> - **Live Gmail compatibility is not yet confirmed.** It awaits your manual results.
>
> **Rev 6 (2026-11-03): D12 confirmed by you.** *(superseded by rev 7)* InboxSDK rejected; **gmail.js primary**, subject to live P2; the integration sits behind `extension/src/gmail/adapter.ts` (`GmailUiAdapter`); the extension-hosted compose page is the retained fallback. See §6.1.
>
> **Rev 5 (2026-11-03): evidence from Phase P (spikes/RESULTS.md).**
> - **D12 updated (proposed, needs your confirmation):** InboxSDK is **rejected**. Its terms and privacy pages are unavailable (404), App ID registration is mandatory, and the shipped code sends error and event telemetry (including a SHA-256 hash of the user's email) to `api.inboxsdk.com` by default. **gmail.js (MIT, no vendor calls)** becomes the primary candidate, pending runtime spike P2.5–P2.9. Its last release is from 2025-01, so the extension-hosted compose page is promoted to a planned fallback, not just a last resort.
> - The MIME builder design was validated offline (RFC 2047, CRLF, single-recipient copies, threading headers, injection rejection). Live Gmail behaviour is still pending P3.
> - D1 batch + counter consistency was validated locally (P6.2).
>
> **Rev 4 (2026-11-03): D2 decided.** `chrome.identity.getAuthToken()` with a Google **Chrome Extension** OAuth client (Q14 approved). Interactive consent happens only on an explicit user click. `launchWebAuthFlow` is a fallback only, used if P1 fails and you approve it. Chrome caches and renews access tokens automatically, but **renewal does not replace consent**: Testing-mode authorizations expire 7 days after consent (O8/V-a), and revocation or a Google password change also require re-consent (O9). The UI must handle "consent required" at any time. Extension ID: a locally generated key (Q15), per `docs/setup/EXTENSION_ID.md`. InboxSDK: evaluation only, no registration (Q16).
>
> **Rev 3 (2026-11-03): documentation check.** Platform claims were checked against official documentation; see `docs/design/VERIFIED_PLATFORM_FACTS.md` for quotes and source URLs. Corrections are listed in `docs/design/OPEN_QUESTIONS.md` ("Corrections"). Key points:
> - **D2 is under review (Q14).** Google calls the implicit flow legacy and "strongly discouraged" (O1) and recommends the Chrome Extension client type for extensions (O5). The proposed **D2-rev** (`getAuthToken` + Chrome Extension client) is **not applied until you approve it.**
> - The Gmail quota is 6,000 units/min/user (M-f), not 250 units/s; the send throttle is relaxed to ≥ 1 s between copies (well under the limit, which keeps the service worker active).
> - Message-ID preservation, Bcc handling and the size limit are **not stated** in the official docs (M-e) and stay prototype items.
> - Testing-mode 7-day expiry confirmed (O8); `gmail.send` confirmed Sensitive and restricted scopes confirmed (M-a); a security assessment applies to restricted-scope data stored or transmitted by servers (V-f).
> - Cloudflare Free limits confirmed (W-a…W-g); Rate Limiting binding availability on Free is unconfirmed (W-i).
Inputs: `docs/design/RECONNAISSANCE.md` (REA inspection) and the critical review in §1. This is an independent design; it reuses no Mailsuite code, assets, branding or UI text.

Labels used throughout:
- **[FACT]**: documented platform behaviour I am confident of. It still gets a quick check in the prototype.
- **[DECISION]**: a design choice we make.
- **[ASSUMPTION]**: plausible but unverified.
- **[PROTOTYPE]**: must be proven by a spike before we depend on it.

---

## 1. Critical review of technical assumptions

### 1.1 Reconnaissance (Mailsuite)
- **[FACT]** The things REA observed: the marketing site structure, `/api/pricing`, the asset hosting and the advertised features.
- **[ASSUMPTION]** How Mailsuite sends, achieves per-recipient tracking, filters self-opens, and which backend stack it uses. None of these were observed, and **this design depends on none of them**.

### 1.2 Gmail API sending and MIME
| Item | Status | Notes |
|---|---|---|
| `users.messages.send` accepts a base64url-encoded RFC 2822 message in `raw` | [FACT] | |
| Gmail decides delivery from the `To`/`Cc`/`Bcc` headers of `raw`; there is no separate envelope parameter | [FACT] | So a copy cannot *display* the full group while being *delivered* to one person. This is the root cause of the group trade-offs in §4. |
| A `Bcc` header in `raw` is delivered but stripped from what other recipients see | [FACT] | |
| `From` must be the authenticated account or a verified send-as alias; otherwise Gmail rewrites it | [FACT] | |
| Gmail adds `Date` and `Message-ID` if they are missing | [FACT] | Whether Gmail **keeps a client-supplied `Message-ID`** is [PROTOTYPE] (P3). Threading copies together depends on it. |
| Threading with `threadId` requires the `threadId`, RFC 2822 `References`/`In-Reply-To`, and a matching `Subject` | [FACT] (documented) | `messages.send` returns only `id`, `threadId` and `labelIds`. Reading the server's `Message-ID` would need `gmail.metadata` or `gmail.readonly`, which are **restricted**. We therefore generate our own `Message-ID` for copy #1 and reference it (P3). |
| Each send costs 100 quota units out of a per-user 250 units/second | [FACT] | That allows at most about 2 sends/s, so we throttle to 1 send per 600 ms. |
| Consumer Gmail sending limit: about 500 recipients a day (rolling) | [FACT] (Google help centre limits) | Every per-recipient copy counts toward it. |
| Request size: `raw` in a JSON body is fine for small HTML mails; the upload endpoint is needed for large messages (up to 35 MB) | [FACT] | The MVP has no attachments, so this doesn't matter. |
| MIME details: `MIME-Version`, `multipart/alternative` (text/plain + text/html), UTF-8 with base64 or quoted-printable bodies, RFC 2047 encoded-word for non-ASCII `Subject`/display names, CRLF line endings, lines ≤ 998 | [DECISION] | Unit-tested builder. No dependency, or a small, audited MIME library chosen in Phase 0. |
| Gmail clips messages larger than about 102 KB ("View entire message") | [FACT] | **The pixel is placed at the start of the body**, not the end, so clipping doesn't hide it. |

### 1.3 Chrome Identity API and the OAuth token lifecycle
| Item | Status | Notes |
|---|---|---|
| `chrome.identity.getAuthToken` returns tokens for an account **signed into the Chrome profile**, using a "Chrome Extension"-type OAuth client bound to the extension ID. Chrome caches and refreshes them. | [FACT] | **Risk:** if the Gmail account you track isn't the Chrome-profile account, `getAuthToken` is awkward or unusable. Supported only in Google Chrome. |
| `chrome.identity.launchWebAuthFlow` runs a browser OAuth flow against a "Web application" client whose redirect URI is `https://<extension-id>.chromiumapp.org/` | [FACT] | Works for any Google account. |
| Implicit grant (`response_type=token`) returns an access token (about 1 hour) and **no refresh token** | [FACT] | No secret is needed. Renewal: `launchWebAuthFlow({interactive:false})` with `prompt=none` and `login_hint` succeeds silently while the Google web session and the grant are valid. Otherwise it fails and we prompt. Silent renewal reliability is [PROTOTYPE] (P1). |
| The authorization-code flow with Google "Web application" clients requires a client secret | [FACT] | **A secret must never ship in the extension**, so the code flow from the extension is ruled out. |
| Testing-mode External apps: authorizations granted to test users expire after 7 days | [FACT] | Expect a re-consent prompt about weekly while the app is in Testing. |

**[DECISION]** Use `launchWebAuthFlow` (implicit grant). It works regardless of which account is signed into Chrome, avoids secrets, and suits user-initiated sends. Fallback: `getAuthToken` if P1 shows silent renewal is unreliable *and* your Gmail account is the Chrome-profile account.

### 1.4 Gmail Sent folder behaviour
- **[FACT]** Every API-sent copy appears in the sender's Sent label.
- With N copies, the sender sees N messages; one thread if threading (P3) works, otherwise N threads.
- **[FACT]** The Sent copy contains the recipient's pixel. When the sender opens it, Gmail loads the image through Google's image proxy. **This produces a self-open that is indistinguishable at the network level** from a Gmail recipient's open. See §5.5.
- **[ASSUMPTION]** Gmail's "conversation view" groups copies sharing `threadId` and `References` (P3).

### 1.5 InboxSDK (see §6 for the full comparison)
- **[ASSUMPTION]** Points I'm not certain of and will check before adoption (P2):
  - My understanding: the core library is published on npm (`@inboxsdk/core`) and the source is public on GitHub under a permissive licence.
  - Using it requires registering a free App ID with the vendor.
  - It may send error/usage telemetry to the vendor.
  - It supports MV3 by bundling its code and injecting a page-world script declared in `web_accessible_resources`.
- Rule: no dependency is adopted until its `LICENSE`, network behaviour and MV3 remote-code compliance have been checked. Chrome Web Store MV3 policy forbids remotely hosted code.

### 1.6 Cloudflare Workers and D1 (free tier)
| Item | Status | Design impact |
|---|---|---|
| Workers Free: 100,000 requests/day, about 10 ms **CPU** per request (I/O wait not counted), subrequest limit per request | [FACT] (verify current numbers at Phase 0) | Pixel and redirect handlers are tiny. JWT HMAC with WebCrypto fits easily. The `tokeninfo` fetch is wall time, not CPU. |
| `ctx.waitUntil` for post-response work | [FACT] | The pixel or redirect responds first, then writes the event. |
| Cron Triggers on the free plan | [FACT] | Daily retention purge. |
| D1 Free: **≈500 MB max per database** (not 5 GB as rev 1 said; 5 GB is the account-wide total), ≈5M rows read/day, ≈100k rows written/day | [FACT] (correction) | The estimate of ~110 MB/year plus 180-day retention fits. Each event write is about 2–3 row writes (insert plus counters), so 100k/day is ample. |
| Cloudflare **WAF rate-limiting rules apply to zones (custom domains), not `*.workers.dev`** | [FACT] (correction to rev 1) | On workers.dev we use the **Workers Rate Limiting binding** (availability on Free is [ASSUMPTION], checked in Phase 0) or cheap in-Worker caps. |
| `*.workers.dev` hostnames reveal the account subdomain to recipients (hovering links shows it) and share reputation with abusers | [FACT] | Pick a neutral account subdomain. A custom domain comes later (decision D3). |
| `cf.country` / `cf.asn` request metadata | [FACT] | Used for classification. Raw IPs are not stored. |

### 1.7 Pixel tracking and the Gmail image proxy
- **[FACT]** Gmail (web and apps) fetches remote images through `*.googleusercontent.com` with a `GoogleImageProxy` user agent. Recipient IP and device are hidden from us.
- **[ASSUMPTION]** Whether the proxy re-fetches on every open or serves a cached copy, even with `Cache-Control: no-store`. Reports differ, so this is [PROTOTYPE] (P4). Until proven, **repeat-open counts for Gmail recipients are unreliable**.
- **[FACT]** Apple Mail Privacy Protection pre-fetches remote content through Apple proxies, whether or not the user reads the mail.
- **[FACT]** Some clients and organisations block remote images by default, for example Outlook desktop and corporate policies. No open is recorded.
- **[FACT]** Email security gateways (for example Microsoft Defender, Proofpoint, Mimecast) may fetch images and links at delivery.
- **[ASSUMPTION]** Gmail may in the future suppress known tracking pixels. Watch for it.

### 1.8 Link redirect tracking and security
- **[FACT]** A 302 redirect to a stored URL, keyed by an unguessable token, is not an open redirect.
- **[FACT]** Security scanners (Safe Links and others) follow links on delivery, sometimes executing JavaScript. Some rewrite links, so the recipient's click goes through their redirector first.
- **[DECISION]** Plain 302 plus heuristics in the MVP. A JS interstitial for bot filtering is rejected: it adds latency and many scanners run JS anyway.

### 1.9 MV3 service worker lifecycle and polling
- **[FACT]** The extension service worker is terminated after about 30 s idle. Global state is lost; persist it in `chrome.storage`.
- **[FACT]** Since Chrome 120, `chrome.alarms` allows periods ≥ 30 s; a 1-minute alarm is fine.
- **[FACT]** Alarms are not guaranteed to survive a browser restart; recreate them in `runtime.onStartup` and `onInstalled`.
- **[FACT]** No polling happens while Chrome is closed. On restart the cursor catches up, so notifications are **collapsed into a summary** after a long gap, never flooded.
- **[ASSUMPTION]** A multi-recipient send loop (N Gmail calls, about 600 ms apart) stays within service-worker lifetime because each extension API call or fetch keeps it alive. To be safe, the **send queue is persisted** in `chrome.storage.local` and resumed idempotently on wake. The MVP caps tracked sends at **20 recipients**.

---

## 2. Decision table

| # | Decision | Selected option | Reason | Trade-offs | Changeable later? |
|---|---|---|---|---|---|
| D1 | Google account type | **Consumer @gmail.com**, External OAuth app in **Testing** | Your provisional choice; works without Workspace | Unverified-app warning; re-consent about every 7 days; Gmail sending limits of about 500/day | Yes. Move to Production (unverified, personal use) or to Workspace Internal |
| D2 | OAuth flow in extension | **`launchWebAuthFlow`, implicit grant, Web client, no secret** | Works for any account; no secret; no Chrome-profile coupling | No refresh token; renewal is silent (`prompt=none`) or interactive | Yes. Switch to `getAuthToken` with a config flag |
| D3 | Tracking host | **`<neutral-name>.<subdomain>.workers.dev`** | $0, HTTPS included | Shared reputation; no WAF rate-limit rules; reveals the subdomain | Yes. Custom domain later; **old links keep working only while the workers.dev route stays enabled** |
| D4 | Recipient tracking | **One copy per recipient, each with unique pixel and link tokens** | Required for per-recipient attribution | Recipients don't see each other; Reply-All is broken (§4) | Partly. A future "group-level single pixel" mode could be added |
| D5 | Multi-recipient emails | **Opt-in.** Tracking is off by default for >1 recipient; the user must tick "Send individually tracked copies" and see a warning | Avoids silently changing group semantics | Extra click | Yes |
| D6 | Cc / Bcc handling | Each Cc/Bcc address receives its own copy with **itself in `To`**. Bcc copies never reveal other recipients. Cc semantics are lost. | Gmail delivers by headers (§1.2) | Recipients can't tell they were Cc | No (platform limit), unless group mode is used |
| D7 | Tracked replies | **Not supported in the MVP.** "Send tracked" is hidden in reply/forward compose | Proper threading needs the parent `Message-ID` (restricted scope or fragile DOM) | No tracking on replies | Yes |
| D8 | Attachments | **Blocked in the MVP**; the user is told to use normal Send | Reading attachment bytes from compose is fragile | Fewer trackable emails | Yes |
| D9 | Disclosure footer | **Optional, default off**; a configurable text line appended to each tracked copy | Legal requirements vary | Off means relying on your own judgement | Yes |
| D10 | Subjects on backend | **Not stored by default** (`store_subjects=false`); subjects live in `chrome.storage.local` | Privacy minimisation | Dashboard limited to this browser profile; lost if the extension is removed | Yes (preference) |
| D11 | Recipient addresses on backend | **Not stored by default.** The backend stores a keyed hash; addresses live locally | Same as D10 | Same as D10; notifications resolve names locally | Yes (preference `store_addresses`) |
| D12 | Gmail UI integration | **InboxSDK, conditional on P2 verification**; fallback **gmail.js**; last resort an **extension-hosted compose page** (supported APIs only) | Best capability per effort, $0 | Unofficial Gmail-DOM dependency | Yes. The integration layer is isolated behind an interface |
| D13 | HTML rewriting location | **Content script** (it has a DOM), not an offscreen document | Simpler; no extra permission | Runs in the Gmail tab | Yes |
| D14 | Backend | **Cloudflare Workers + D1 + Hono** | $0, no cold starts, HTTPS | Vendor lock-in (modest; SQLite schema is portable) | Yes |
| D15 | Event delivery | **1-minute `chrome.alarms` polling** | Simple, free | Up to about 60 s latency; nothing while Chrome is closed | Yes. Web Push later |
| D16 | Self-open filtering | **Layered heuristics, events flagged not deleted** (§5.5) | No reliable network-level signal exists for proxied opens | Some false positives and negatives | Yes |
| D17 | Pixel position | **Start of the HTML body** | Avoids Gmail clipping | — | Yes |
| D18 | Max recipients per tracked send | **20** | Service-worker lifetime and daily limits | — | Yes |
| D19 | Personal-use allowlist | `ALLOWED_GOOGLE_SUBS` env var | Single user | — | Yes |
| D20 | Data retention | Events 180 days, sender views 24 h | Minimisation | Older detail lost (counters kept) | Yes |

---

## 3. High-level architecture

```
 ┌──────────────────────────── Sender's Chrome ────────────────────────────┐
 │ Gmail tab (mail.google.com)                                             │
 │  Content script  ── Gmail UI adapter (InboxSDK | gmail.js)              │
 │   • "Send individually tracked" button (new compose only)               │
 │   • reads compose: recipients, subject, HTML, attachment presence       │
 │   • rewrites HTML per recipient (links → /c/, pixel → /o/ at top)       │
 │   • neutralises own-pixel <img> in viewed messages (self-open layer 1)  │
 │   • posts "thread viewed" signals; draws status chips in Sent list      │
 │            │ runtime messaging                                          │
 │  MV3 service worker                                                     │
 │   • OAuth (launchWebAuthFlow) • backend session                         │
 │   • persisted send queue → MIME → Gmail API send (throttled)            │
 │   • 1-min alarm poll → chrome.notifications                             │
 │  Extension pages (React): dashboard, popup, settings                    │
 │  chrome.storage.local: subjects, addresses, cursors, queue, prefs cache │
 └──────┬───────────────────────────────────────────┬──────────────────────┘
        │ HTTPS, Bearer session                     │ HTTPS, Google access token
        ▼                                           ▼
 ┌─────────────────────────────────┐        ┌────────────────────────┐
 │ Cloudflare Worker (public HTTPS)│        │ Gmail API (gmail.send) │
 │  /o/{token}.gif   open pixel    │        └───────────┬────────────┘
 │  /c/{token}       click redirect│                    │ delivery
 │  /v1/*            private API   │                    ▼
 │  cron: retention purge          │  ◄── fetches ── recipient clients, Google/Apple
 │  D1 (SQLite)                    │                 proxies, security scanners
 └─────────────────────────────────┘
```

### 3.1 What must be public HTTPS
| Endpoint | Public? | Why |
|---|---|---|
| `/o/{token}.gif` | **Yes** | Fetched from anywhere by recipient clients and proxies. Gmail's proxy fetches only HTTPS. |
| `/c/{token}` | **Yes** | Opened in recipients' browsers. |
| `/v1/*` | Reachable from your browser | Authenticated; CORS-locked to the extension origin. Hosted on the same Worker to avoid extra infrastructure. |
| Dashboard | No | Bundled in the extension. |

---

## 4. Individual-recipient tracking design

### 4.1 Identifiers
- `pixel_token`: 128-bit random (CSPRNG) base64url, one per recipient copy.
- `click_token`: 128-bit random, one per (recipient copy, link).
- Tokens are opaque. They are never derived from addresses or IDs, and they are never reused.

### 4.2 Delivery
For each recipient R (deduplicated, case-insensitive, ≤ 20):
- Headers: `From: <you>`, `To: R`, `Subject`, `MIME-Version`, `Message-ID: <ulid@tracklet.local>`.
  - Copy #1 has no threading headers.
  - Copies #2…N carry `References: <copy1-msgid>` and `threadId` from copy #1's response, so they group in your Sent view (P3).
- Body: a per-recipient HTML version (pixel at the top, rewritten links, optional disclosure) plus an auto-generated text/plain part (rewritten links, no pixel).

### 4.3 What recipients experience
| Original field | Recipient sees | Reply | Reply-All |
|---|---|---|---|
| To (single recipient) | Normal email | Reaches you | Reaches you |
| To (group, opt-in) | Only their own address in To | Reaches you | **Reaches only you**; the other recipients are lost |
| Cc | Themselves in To (not Cc) | Reaches you | Reaches only you |
| Bcc | Themselves in To | Reaches you | Reaches only you; Bcc privacy preserved |
Recipients replying to each other is impossible, and their replies arrive in separate threads in your inbox (one per copy). This is the cost of per-recipient attribution through the Gmail API and is shown in the opt-in warning.

---

## 5. Detection: what can and cannot be known

### 5.1 Reliability matrix
| Signal | Reliability | Notes |
|---|---|---|
| Message accepted by Gmail for sending | **High** | `messages.send` 200 |
| Delivered to the recipient's inbox | **Unknown** | Bounces arrive later as emails; not tracked in the MVP |
| First open (Gmail recipient, images on) | Medium | Via Google proxy; could also be the sender (§5.5) |
| Repeat opens (Gmail recipient) | **Low, until P4** | Proxy caching |
| Open (Apple Mail with MPP) | **Low** | Prefetch happens regardless of reading |
| Open (images blocked / text-only) | **Not detectable** | |
| Open via security gateway prefetch | False positive | Flagged by timing and ASN heuristics |
| Who opened a forwarded copy | **Not detectable** | Attributed to the original recipient |
| Device, location (Gmail recipients) | **Not available** | Proxy masks it; country = Google's proxy location |
| Click by a human | Medium–High | Scanners can also click |
| Click by a scanner | Heuristic only | |
| Reply received | Not in MVP | Needs a restricted scope |

### 5.2 Classification (server-side, per event)
`classification ∈ {human_likely, proxy_open, prefetch_suspected, scanner_suspected, self_suspected, duplicate}`

| Rule (evaluated in order) | Result |
|---|---|
| A sender-view signal for this thread within ±90 s | `self_suspected` |
| HEAD request | `prefetch_suspected` (open) / `scanner_suspected` (click) |
| Under 15 s since this copy was sent (open) / under 5 s (click) | `prefetch_suspected` / `scanner_suspected` |
| Click: at least 2 distinct links of the same copy within 2 s | `scanner_suspected` (all of them) |
| UA or ASN on the known-scanner list (configurable table) | `scanner_suspected` / `prefetch_suspected` |
| Same token, same type, same `ip_hash`, same `ua_family` within 60 s | `duplicate` |
| UA `GoogleImageProxy` / Yahoo proxy / Apple-proxy ASN | `proxy_open` |
| Otherwise | `human_likely` |

- Counters and notifications use `human_likely` and `proxy_open` (and clicks marked `human_likely`).
- A non-suspect click also creates an **implied open** if none exists.
- Every event is kept, so rules can be tuned and data reclassified (`classifier_version` column).

### 5.3 Duplicate handling
- A logical dedupe window of 60 s (above). The physical row is still written with `duplicate`, for audit.
- Per-token write cap: 100 events a day. After that, events are only counted in a daily aggregate, to stop log flooding.
- Client-side idempotency: `client_request_id` for registration, and `(email_id, recipient_id)` for send status, so retries never double-send. The queue marks each recipient `sending` before the API call and `sent` after. On resume, a recipient in `sending` older than 2 minutes is **not** automatically resent; the user is asked. This prevents a double email after a crash.

### 5.4 Scanner and bot detection: limits
These are heuristics. Modern scanners can mimic browsers and click with a delay. Expect both false positives and false negatives. The UI always offers "show suspected events".

### 5.5 Self-open filtering (layered, best effort)
1. **Neutralise in your own Gmail view.** The content script watches for `<img>` elements whose `src` (or Gmail-proxied `src` containing our host after `#`) references our tracking host. It replaces them with a placeholder before they load.
   - This races Gmail's own rendering, so success is [PROTOTYPE] (P5).
   - A `declarativeNetRequest` rule **cannot** reliably catch proxied loads: the request goes to `googleusercontent.com` and the fragment is not sent, so rev 1's DNR layer is dropped. DNR remains useful only for **direct** loads, for example if you view the message in another client inside this browser.
2. **View signal.** When you open a thread containing tracked copies, the content script posts `/v1/views`. Opens within ±90 s are reclassified `self_suspected`, including retroactively.
3. **Send-time grace window.** Opens under 15 s after sending are `prefetch_suspected`.
4. **Not covered:** you reading your own Sent mail in the Gmail mobile app or another browser. Those opens **will** be counted. This is documented in the UI.

The rev 1 device-cookie layer is removed: proxies don't forward cookies, and third-party cookie handling makes it unreliable.

### 5.6 Privacy-preserving storage
- **Backend never stores:** email bodies, raw IPs, full user agents (only `ua_family` and a 128-char truncation), subjects (default), recipient addresses (default).
- `recipient_key = HMAC-SHA256(user_secret, lowercase(address))` lets the extension match recipients across emails without the backend learning the address. `user_secret` is generated in the extension and kept locally.
- `ip_hash = HMAC-SHA256(IP_HASH_SALT, ip)`. The salt rotates monthly, so long-term linking is impossible.
- Link `target_url` **must** be stored (the redirect needs it). This is disclosed in the settings page.
- Retention: events 180 days; hard delete per email or for all data.

---

## 6. Gmail integration options compared

| Criterion | InboxSDK | gmail.js | Supported Google APIs only |
|---|---|---|---|
| What it is | High-level SDK for Gmail UI (compose buttons, thread rows, sidebars) maintained by a commercial vendor (Streak) | Open-source community library exposing Gmail page data and events | (a) An extension-hosted compose page + Gmail API, or (b) a Google Workspace Gmail add-on (card UI) |
| Licence | [ASSUMPTION] permissive, public source; **verify `LICENSE` in P2** | [FACT] MIT | N/A (Google APIs) |
| Registration | [ASSUMPTION] free App ID registration required | None | (a) none beyond OAuth; (b) Apps Script project / test deployment |
| Cost | $0 (assumed) | $0 | $0 |
| Telemetry or external calls | [ASSUMPTION] may report errors to the vendor; **verify and, if possible, disable** | None | None |
| MV3 / no remote code | [ASSUMPTION] supported via bundled page-world script | [FACT] bundled; needs page-world injection | Fully compliant |
| Reliability vs Gmail UI changes | Good: the vendor updates selectors quickly | Medium: community fixes; can lag | (a) **Highest**: no DOM dependency. (b) High: supported surface |
| Compose button / read compose HTML | Yes, first-class | Partial (compose observers, DOM access) | (a) Our own editor. (b) Add-on compose actions can insert content into a draft but **cannot send per-recipient copies** without the Gmail API |
| Sent-list status chips | Yes (thread row API) | Possible with manual DOM work | (a) No (dashboard only). (b) No |
| Implementation complexity | Low–medium | Medium–high | (a) Medium (needs a rich-text editor). (b) High; limited UI |
| Maintenance burden | Low | Medium | (a) Low. (b) Low |

**Recommendation [DECISION D12]:**
1. Build the Gmail integration behind a small `GmailUiAdapter` interface.
2. Use **InboxSDK** only if P2 confirms an acceptable licence, no remote code, and acceptable or disableable telemetry.
3. Otherwise use **gmail.js**.
4. Keep option (a), an extension-hosted compose page, as a guaranteed fallback. It needs no Gmail DOM and can be built in Phase 3 if both libraries fail.

None of the options adds paid dependencies.

### 6.1 gmail.js maintenance risk and fallback design (rev 6; superseded in part by rev 7)
> Rev 7: the native DOM adapter is now primary. The table below still describes the risks of the isolated gmail.js candidate. The Trusted Types row is resolved: jQuery 3.7.1 fails, jQuery 4.0.0 loads, and gmail.js UI helpers are banned. Option (a) "default TT policy" is **rejected** and must not be used.

**Risks (evidence from P2 static review):**
| Risk | Evidence | Mitigation |
|---|---|---|
| Stale releases | gmail-js 1.1.16 last published 2025-01-01 | Pin the exact version; P2 live tests on every Gmail UI change; watch the GitHub repo |
| Relies on undocumented Gmail DOM classes (`.gU.Up`, `tr.zA`, `.GS input`, `div[data-hovercard-id]`) and embedded data | Source of `add_compose_button`, `recipients()` | All selectors stay inside the adapter; product code uses `GmailUiAdapter` only |
| **Requires jQuery** (MIT, +~90 KB) | gmail.js constructor throws without jQuery | Accepted; bundled locally (no remote code) |
| **Trusted Types**: gmail.js uses jQuery `.html()` (e.g. compose buttons) and has no Trusted Types policy | grep of 1.1.16 found no `trustedTypes` usage | P2.10 probes this live. If Gmail blocks it, either (a) a `default` TT policy, if Gmail's CSP allows it, or (b) build our compose button with DOM APIs and use gmail.js only for data access, or (c) fall back |
| `recipients()` returns **emails only** (no display names) | Source | Names are not required for sending; `To:` headers use the bare address. Recorded as a UX limitation |
| `close()` simulates **Esc**, which in Gmail normally **keeps a draft** | Source | P2.7 confirms. If a draft remains, the product shows "Draft kept — delete it from Drafts". We cannot delete drafts without the restricted `gmail.compose`/`modify` scopes |
| Runs in the page's MAIN world | MV3 `content_scripts[].world = "MAIN"` | No extension APIs in that world; communicate with the isolated world via `window.postMessage` with a strict origin and message schema (Phase 2) |

**Fallback: extension-hosted compose page (no Gmail DOM dependency)**
- `chrome-extension://<id>/compose.html`, opened from the popup or the toolbar.
- Fields: To/Cc/Bcc chips, subject, and a rich-text editor (choice deferred to Phase 2; must be MIT/Apache and bundled). Signature is pasted from settings.
- Sends through the same MIME builder and Gmail API path, so per-recipient tracking is identical.
- Loses: in-Gmail button, Sent-list marks (status lives in the dashboard), Gmail's signature/formatting tools.
- **Trigger to switch:** any P2 live test failing in a way the adapter can't absorb, or gmail.js breaking for more than 7 days after a Gmail UI change.

---

## 7. Google OAuth and Gmail compliance (corrected)

### 7.1 Account and app types
| Concept | Accurate statement |
|---|---|
| Consumer Gmail | You can create a Google Cloud project with an **External** OAuth app. **Internal** is not available to consumer accounts. |
| Workspace account | You may create an **Internal** app, usable only by users in your Workspace organisation. Internal apps are exempt from Google's OAuth app verification and from the unverified-app user cap. **This does not remove all restrictions:** Workspace admins can block or restrict third-party apps and specific Gmail scopes through API Controls, the Gmail API's sending limits still apply, and Google's API Services User Data Policy still applies. |
| External app, **Testing** status | Only listed test users (max 100) can authorise. Users see an "unverified app" warning. Grants for scopes beyond basic profile **expire after 7 days**. |
| External app, **In production**, unverified | Any user can attempt to authorise but sees the unverified-app warning. Apps using sensitive or restricted scopes without verification are capped at **100 users** (lifetime). Google's guidance says apps for **personal use** (only you, or a small number of users known to you) don't need verification. |
| External app, verified | Required for broad public distribution with sensitive or restricted scopes: domain verification, privacy policy, homepage, scope justification and usually a demo video. |

### 7.2 Scopes for the MVP (exact)
| Scope | Why needed | Classification |
|---|---|---|
| `openid` | Stable account identifier (`sub`) for the backend allowlist | Non-sensitive |
| `email` (`https://www.googleapis.com/auth/userinfo.email`) | Verify the account and build the `From` header | Non-sensitive |
| `https://www.googleapis.com/auth/gmail.send` | Send per-recipient copies | **Sensitive** |

Deliberately **not** requested:
- **Restricted:** `gmail.readonly`, `gmail.metadata`, `gmail.modify`, `gmail.compose`, `gmail.insert`, `https://mail.google.com/`.
- Note that `gmail.compose` is restricted, so we never create Gmail drafts via the API.

### 7.3 Security assessments
- **`gmail.send` (sensitive) does not require a CASA security assessment.** Publishing to the public would require *sensitive-scope verification* (no CASA).
- **CASA (Cloud Application Security Assessment)** applies to **restricted** scopes when an External app is verified for public use. It is typically re-assessed annually and may cost money depending on the assessor and tier.
- Exemptions from restricted-scope verification and CASA include personal-use apps that stay unverified, and **Internal** Workspace apps. Requirements change, so **check Google's current "restricted scope verification" page before adding any restricted scope.**
- Future features that would add restricted scopes, and therefore possible CASA if published: reply detection, follow-up "no-reply" alerts, tracked replies with proper threading, and reading Sent metadata.

### 7.4 Secrets
- The implicit flow needs only the **client ID**, which is public by design. There is **no client secret** anywhere in the extension or the repo.
- Worker secrets (`SESSION_SIGNING_KEY`, `IP_HASH_SALT`) are set with `wrangler secret`, never committed.

---

## 8. Repository layout and permissions (planned)
```
extension/  manifest.json (MV3, fixed "key"), src/{background,content,ui,shared}
backend/    src/{routes,classify,db,auth}, migrations/, wrangler.toml
shared/     zod schemas and types used by both
```
- Extension permissions: `identity`, `storage`, `alarms`, `notifications`.
- Optional permissions: `scripting` (if the adapter needs page-world injection), `declarativeNetRequest` (direct-load layer only).
- Host permissions: `https://mail.google.com/*`, `https://gmail.googleapis.com/*`, `https://<worker-host>/*`.
- Removed vs rev 1: `cookies`.

## 9. Local development and deployment (unchanged in principle)
- Extension: `vite build --watch`, then load unpacked. A fixed `key` gives a stable extension ID, needed for the OAuth redirect URI `https://<id>.chromiumapp.org/`.
- Backend: `wrangler dev` with local D1. End-to-end tests with real mail clients need a public URL: a `-dev` Worker deployment or `cloudflared` quick tunnel (both free).
- Tests: Vitest unit tests (MIME, rewriter, classifier, auth); a manual client matrix (Gmail web/app, Apple Mail, Outlook.com, a Proton or other image-blocking client).

## 10. Accuracy statement (shown in the UI)
"Opens are estimates. Images may be blocked (missed opens), pre-loaded by privacy features or security scanners (false opens), cached by proxies (missed repeat opens), or loaded when a message is forwarded (attributed to the original recipient)."
