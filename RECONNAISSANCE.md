# RECONNAISSANCE — Mailsuite (mailsuite.com)

Investigation date: 2026-11-03
Purpose: Gather evidence to design an **independent** email-tracking / email-productivity product. No Mailsuite code, assets, branding or text will be reused.

---

## 0. Method and tooling

| Item | Value |
|---|---|
| RE MCP server | `rea` (REA reverse-engineering MCP). It was **available** and is the only inspection tool used. |
| REA tools used | `capture_browser_scenario` (Playwright-driven headless Chromium 156: accessibility snapshots plus network events and bodies), `analyze_web_bundle` (static JS parse over CDP, no execution) |
| Browser | Local Google Chrome, launched by REA (owned temporary profile); for bundle analysis, headless Chrome on loopback CDP port 9333 |
| Scope | Only **public, unauthenticated** marketing pages. No logins, no checkout, no write requests, no Chrome-extension or mobile-app inspection. |
| Pages captured | `/en/` (home), `/en/features/email-tracking`, `/en/pricing`, `/en/features/mail-merge`, `/en/features/document-tracking`, `/en/features/follow-up-reminders` |
| Evidence IDs | Home: `ev_41df05e8…`. Bundle: `ev_fe23d871…`. Multi-page capture saved in the session tool-results directory. |

### What could not be inspected (and why)
- **The actual product** runs inside Gmail as a Chrome extension (`chromewebstore … /ndnaehgpjlnokgebbaldlmgkapkpjkkb`), a Gmail add-on, an Outlook add-in and mobile apps, plus an authenticated dashboard. None of these was inspected. The core tracking pipeline (pixel host, link redirector, API) is therefore **inferred from public documentation, not observed**.
- A 10-page crawl failed with `net::ERR_CONNECTION_TIMED_OUT` on the first request, probably rate limiting or WAF. A 5-page retry succeeded. These pages were **not** captured: mass-email, document-signing, document-sharing, email-analytics, crm-for-gmail, teams, privacy-center, solutions/*.
- `/en/pricing` returned an empty `main` landmark in the accessibility snapshot. The pricing data came from its JSON API instead (see §4).
- Possible next step (only if you authorize it): REA can statically inspect a **locally downloaded** extension package (`analyze_javascript_application` on the unpacked CRX). That would show how the in-Gmail behaviour works.

---

## 1. Product identity and surface (observed)

- Brand architecture: **Mailsuite** (company, Mailsuite S.L.) is the umbrella. **Mailtrack®** is the free tracker sub-brand (mailtrack.com). The FAQ says Mailtrack joined Mailsuite in 2024.
- Claims on the page: more than 3M users, 11.5K Chrome Web Store reviews (4.5★), 116,000 paying subscribers, ISO 27001 certificate, Google Cloud partner, annual Google security audit (CASA), AES-256 encryption, GDPR.
- Distribution channels (footer links):
  - Chrome extension (primary call to action everywhere)
  - Android app `com.mailsuite.app`, iOS app `id6692619685`
  - Google Workspace Marketplace add-on: "Email tracker for mobile" (Gmail app) and an organization-wide install
  - Microsoft AppSource Outlook add-in `WA200005320`
- Site sections: Features, Download, Resources, Pricing, Teams, Solutions (12 vertical landing pages), Blog, Help Center (`/hc/en-us`, Zendesk-style path), Testimonials, Signature Generator, "Sign PDF online" (`/en/esignature`), Video messages (`/en/screen-recording/`), legal pages (cookies, terms, privacy).
- i18n: the URLs carry a locale prefix (`/en/…`), the API takes `?locale=en`, and the footer has a language switcher. A redirect sends `/` to `/en/`, and `?redirect=0` suppresses it.

---

## 2. Complete feature inventory (from public pages)

### 2.1 Email tracking (core, free tier)
- Unlimited tracked emails.
- **Double check marks in the Gmail Sent list**: grey means delivered or tracked, green means opened.
- Instant open alerts as email and desktop (browser) notifications.
- The free tier logs the **first** open with time and date. Paid tiers keep the full history (opens and clicks over time).
- Mechanism (from the public FAQ): an invisible tracking pixel in each outgoing email. Loading the pixel records the open time and count. The site says email content is never read or stored.
- **Per-recipient tracking in group emails** (paid). This implies a separate pixel or token for each recipient. Gmail sends one MIME message to all recipients, so this needs either per-recipient sends or a different technique. **Open design question; see §6.**
- **False-open / self-open prevention**: the sender's own opens are excluded.
- **Link click tracking** (paid) through rewritten links.
- The free tier appends a promotional signature ("Sent with Mailsuite / Mailtrack"). This is the growth loop. Paid tiers remove it.
- Emails are sent through the user's **own Gmail account**, not a third-party SMTP relay. The site uses this as its deliverability selling point.

### 2.2 Alerts and follow-up
| Alert | Trigger (as described) |
|---|---|
| Open notification | First open |
| Link click notification | First click |
| Not-opened alert | Not opened within N hours (24–72h) |
| No-reply alert | No reply within 72h (requires reading thread/reply state) |
| Open Spike alert | Many opens within a short window |
| Email Revival alert | An old email reopened after a long gap |
- Alerts are configured in Dashboard → Settings and Privacy → Notifications (checkboxes, then "Save Settings").
- Weekly and monthly activity reports by email (paid).

### 2.3 Campaigns / mass email / mail merge
- Up to 10,000 emails at once (marketing copy). The paid plan states "up to 60,000 recipients/month".
- Recipient data comes from **Google Sheets**, with unlimited merge fields usable in the subject and body.
- The template is written in the Gmail composer.
- Scheduling plus **batched sending** to avoid spam filters and quota limits.
- Attachments, including tracked PDFs.
- Bounce detection and alerts.
- Campaign analytics dashboard: open rate, click rate, bounces, PDF opens.
- Scheduled single emails ("Schedule your tracked emails").

### 2.4 Document tracking / secure sharing / analytics
- Attach a PDF in Gmail with the Attach button → "Add Document" (or "Advanced Document"). The file is uploaded and the email carries a **tracked link** instead of the attachment.
- Per-recipient access control: who, when, expiry date, download restriction. Confidential watermark (separate feature page).
- Analytics: view count, view duration, per-page views and % of the document covered, downloads.
- Multiple PDFs per email (added one at a time).
- Forwarded views cannot be distinguished. They are attributed to the original recipient, which implies the link token is per recipient.
- The link name and style can be customized.

### 2.5 eSignature
- Send a signature request from Gmail, track its status, and get notified on completion. There is also a standalone "Sign PDF online" page.

### 2.6 Other tools (named in the paid plan or footer; pages not captured)
Email templates, video messages / screen recording, polls, certified emails, CRM for Gmail, email productivity analytics, signature generator, Outlook add-in, mobile apps, Teams plan (`/en/solutions/mailsuite-for-teams`).

---

## 3. UI components and workflows (observed on marketing pages)

Marketing page template (the same on every feature page):
1. Header: logo, navigation (Mailtrack, Features ▾, Download ▾, Resources ▾, Pricing, Teams) and the "Install Mailsuite" call to action.
2. Hero: H1, subhead, install button, star rating, review count, "Trusted by +3M", trust badges.
3. "Used by professionals at" logos plus 3 testimonial cards.
4. Alternating feature blocks (image and text).
5. **Pricing widget**: Monthly/Yearly toggle and 3 plan cards. It is rendered client-side from `/api/pricing`.
6. "Steps" section (Step 1/2/3), a features grid ("And many other features"), an FAQ accordion, a Privacy & Security Center teaser, press logos, final call to action, and a large footer.

User workflows described in the copy:
- **Onboarding**: install the Chrome extension, then grant Gmail access (OAuth). Tracking is on by default.
- **Track an email**: compose in Gmail and send. A ✓/✓✓ status appears in Sent, and notifications follow.
- **Mail merge**: prepare a Google Sheet → open the campaign UI from Gmail → pick the sheet → write the template with merge tags → schedule → watch the dashboard.
- **Tracked PDF**: compose → Attach → Add Document → set access and analytics options → send → get notifications and per-page analytics.
- **Notification settings**: Dashboard → Settings & Privacy → Notifications.
- **Upgrade**: `/reauth/checkout_view?tier={pro|advanced}&interval={month|year}&interval_count=1`. The `/reauth/` prefix suggests the user must re-authenticate before checkout.

---

## 4. Network and API behaviour (observed)

### First-party
| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `https://mailsuite.com/en/…` | GET | none | Server-rendered HTML pages |
| `https://mailsuite.com/api/pricing?locale=en` | GET (fetch) | none | Called on every page that shows the pricing widget. Returns `application/json`, about 2.4 KB. |
| `/reauth/checkout_view?tier=&interval=&interval_count=` | link | session | Checkout entry point (not requested) |

`/api/pricing` response shape (decoded from the captured body; values abbreviated):
```json
{
  "plans": [
    { "tier": "free|pro|advanced", "name": "...", "subtitle": "...", "features": ["..."],
      "prices": { "month-1": { "interval": "month-1", "amount_cents": 599,
                                "monthly_equivalent_cents": 599, "currency": "USD", "can_upgrade": true },
                  "year-1":  { "interval": "year-1", "amount_cents": 4788,
                                "monthly_equivalent_cents": 399, "currency": "USD", "can_upgrade": true } },
      "mostPopularMonthly": false, "mostPopularYearly": true,
      "isCurrentPlanMonthly": false, "isCurrentPlanYearly": false }
  ],
  "intervals": { "month-1": {"label":"Monthly","months_in_cycle":1}, "year-1": {"label":"Yearly","months_in_cycle":12} },
  "translations": { "selectPlanText": "...", "billedYearlyText": "billed %price% yearly", ... }
}
```
Prices observed (USD per user per month):

| Tier | Monthly | Yearly |
|---|---|---|
| Free | $0 | $0 |
| Pro ("Mailtrack") | $2.99 | $1.99 (billed $23.88) |
| Advanced ("Mailsuite") | $5.99 | $3.99 (billed $47.88) |

The `isCurrentPlan*` flags show that the same endpoint is personalized when a session exists.

Response headers (names only) include CSP, HSTS, `x-frame-options`, `x-content-type-options`, `x-xss-protection` and `cache-control`/`expires`.

### Static assets
- CDN: `s3-eu-west-1.amazonaws.com/io.mailtrack.assets/backend/{buildHash 5ef5eef3}/…`. Assets are served directly from S3 in eu-west-1, which suggests EU hosting and fits the GDPR positioning.
- Paths: `bundles/mailtrackfrontend/img/...` (Symfony bundle naming convention) and `dist/{name}.{contenthash}.js|css` (webpack).

### Third-party scripts (requests observed)
Cookiebot (consent), Google Tag Manager, GA4 (`G-J2V9Z6K5E1`), Google Ads / DoubleClick, Meta Pixel, TikTok Pixel, Hotjar, Crazy Egg, Google Fonts, and **Snowplow** (a first-party event pipeline, bundled as `snowplow.*.js`).

---

## 5. Architecture clues

| Clue | Inference | Confidence |
|---|---|---|
| `bundles/mailtrackfrontend/` asset path, `/reauth/` routes, server-rendered locale pages | **PHP Symfony** monolith backend ("MailtrackFrontendBundle") | Medium |
| webpack `runtime.*.js`, `common.*.js`, per-page entries (`home`, `pricingNew`), content hashes | webpack multi-entry build. No SPA router; REA found 0 route patterns | High (observed) |
| `analyze_web_bundle`: 6 scripts, ~590 KB JS, one `require('util')` edge, endpoint candidates only low-confidence | Light client-side JS (widgets such as the pricing toggle and FAQ). Pages are server-rendered. | High |
| Build hash `5ef5eef3` in the asset path | Versioned deploys to S3 | High |
| S3 eu-west-1 | AWS EU region | Medium |
| Snowplow tracker | In-house product analytics pipeline | High |
| Help center at `/hc/en-us/articles/{id}-slug` | Zendesk Guide behind a reverse proxy | Medium |
| `tier` = free/pro/advanced, `interval` = `month-1`/`year-1` | Subscription model with per-seat pricing; Stripe-style interval/interval_count | Medium |
| Gmail add-on + Chrome extension + Outlook add-in + mobile apps | One backend API serving several clients | Inferred |

---

## 6. Feature dependency map

```
Identity (Google OAuth, later Microsoft OAuth)
 └─ Mail-provider access (Gmail API: send, read thread metadata, labels)
     ├─ Tracking core ── pixel endpoint + link redirector + event store
     │    ├─ Sent-list ✓✓ UI (extension DOM injection, or add-on cards)
     │    ├─ Self-open filtering (needs sender session/cookie/IP heuristics)
     │    ├─ Per-recipient tracking (needs per-recipient message variants)
     │    ├─ Notifications (email, web push / desktop, mobile push)
     │    │    └─ Rules engine: spike, revival, not-opened (scheduled jobs)
     │    │         └─ No-reply alert (needs Gmail thread polling or watch/pub-sub)
     │    └─ Reports (weekly/monthly digests) + dashboard
     ├─ Scheduler / job queue
     │    ├─ Scheduled send
     │    └─ Campaigns / mail merge (Google Sheets API, batching, quotas, bounce parsing)
     └─ Document service (object storage, viewer, per-recipient links, access policy)
          ├─ Page-level analytics (instrumented web PDF viewer)
          ├─ Watermarking
          └─ eSignature (signature workflow, audit trail)
Billing (plans, seats, entitlements) ─ gates history length, signature removal, campaigns, etc.
```

---

## 7. Implementation approaches for an independent alternative

**Recommended MVP scope**: Gmail-only open and click tracking, with notifications and a dashboard. Next: follow-up rules. Later: campaigns and document tracking.

1. **Client**: a Chrome MV3 extension that injects into Gmail. Use **InboxSDK** or **gmail.js** for compose and sent-list hooks. Inject the pixel and rewrite links at send time. Render status ticks in the thread list. Alternative: a Google Workspace Add-on (cards UI; cannot inject into the Sent list, but works on mobile).
2. **Backend**: TypeScript (NestJS or Fastify) or any stack, with PostgreSQL and Redis/BullMQ for jobs.
   - `GET /p/{token}.gif` returns a 1×1 image and records an event. The token is an opaque signed ID (message plus recipient). Return quickly; write the event asynchronously.
   - `GET /l/{token}` records the click and returns a 302 to the target. Validate against a stored URL to prevent an open redirect.
   - Filter self-opens: when the extension shows a sent message, it sends "viewing message X" so the backend can drop the matching open. Also filter known proxies (Google Image Proxy gives masked IP/UA; Apple Mail Privacy Protection prefetches pixels and needs detection heuristics).
3. **Per-recipient tracking**: send separate copies through the Gmail API, one per recipient, each with its own pixel (MIME rebuilt server-side or in the extension). The alternative is honest "any recipient opened" semantics. This is a key design decision.
4. **Notifications**: Web Push (from the extension service worker), email via SES/Postmark, and FCM/APNs for mobile later.
5. **Rules engine**: a scheduled worker evaluates not-opened, spike (N opens in T minutes) and revival (an open after more than D days of silence). For no-reply, use Gmail `users.watch` with Pub/Sub, or poll threads.
6. **Campaigns**: Google Sheets API for import, a template engine with merge tags, throttled sends that respect Gmail limits (about 500/day consumer, about 2,000/day Workspace), and bounce detection by parsing DSN messages in the inbox.
7. **Documents**: S3-compatible storage, signed per-recipient viewer links, and a PDF.js viewer that sends page-visibility and dwell beacons. Add access policies (expiry, no-download) and server-side watermarking (pdf-lib).
8. **Compliance**: Google OAuth restricted-scope verification plus a **CASA security assessment** (needed for `gmail.send` / `gmail.modify` / `gmail.readonly`). Also GDPR (EU hosting, DPA, recipient-privacy disclosures) and a consent UI.
9. **Billing**: Stripe Billing with per-seat subscriptions and an entitlements table (history retention days, branding removal, campaign quota).
10. **Growth loop (optional)**: an opt-out "sent with …" signature on the free tier.

### Key risks
- Gmail DOM changes break the extension, so use InboxSDK.
- Google OAuth verification and CASA take time and money.
- Apple MPP and Google Image Proxy make open data less accurate.
- Deliverability: pixel and link domains need their own reputation (a custom tracking domain, HTTPS).
- Legal: tracking recipients may require disclosure in some jurisdictions.

---

## 8. Open items before architecture sign-off
- [ ] Decide whether to authorize REA static analysis of a locally downloaded copy of the extension to confirm the in-Gmail mechanics (pixel host, per-recipient strategy).
- [ ] Re-crawl the remaining feature pages (mass-email, document-sharing, signing, CRM, teams) at a slower rate.
- [ ] Choose the MVP scope and the per-recipient strategy (§7.3).
