# Tracklet

Personal **open and click tracking** for emails you send from Gmail.

It has two parts:
- a **Chrome extension** (Manifest V3) that adds **Send tracked** to Gmail and provides a popup, a dashboard and desktop notifications;
- a small **Cloudflare Workers + D1** backend that serves the tracking pixel and the click redirects, and stores events.

Tracklet is built for **one person, or a short allowlist of Google accounts**. It is not a multi-tenant service.

> **Status:** production-ready code, CI on every push, verified locally. Real open and click tracking needs the backend deployed at a public **https** address (see [step 4](#4-run-the-backend)). See [docs/release/RELEASE_READINESS.md](docs/release/RELEASE_READINESS.md).

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [How to use Tracklet](#how-to-use-tracklet) (setup steps 1–6, then daily use)
4. [Troubleshooting](#troubleshooting)
5. [Development](#development)
6. [Security and privacy](#security-and-privacy)

---

## How it works

```
 Gmail (your browser)                         Cloudflare Worker + D1 (public https)
 ┌──────────────────────────┐   register     ┌─────────────────────────────────────┐
 │ "Send tracked"           │ ─────────────► │ POST /v1/emails → pixel + link URLs │
 │  ↓                       │                │                                     │
 │ one copy per recipient   │                │ GET /o/<token>.gif  ← mail client   │
 │ via Gmail API (gmail.send)│               │ GET /c/<token> → 302 to real link   │
 │  ↓                       │   poll 1/min   │                                     │
 │ notifications, ✓✓ marks, │ ◄───────────── │ GET /v1/events, /v1/dashboard       │
 │ dashboard                │                └─────────────────────────────────────┘
 └──────────────────────────┘
```

1. **Registering.** Click **Send tracked** on a new Gmail message. The extension registers it with the backend, sending only opaque per-recipient keys and the link URLs. **Subjects and addresses stay in your browser.**
2. **Sending.** The extension sends **one copy per recipient** through the Gmail API. Each copy carries its own invisible pixel and rewritten links.
3. **Recording.** When a copy is opened (its pixel loads) or a link is clicked, the backend records the event and labels it, for example *likely human*, *via image proxy*, *possible scanner* or *probably you*.
4. **Reporting.** The extension polls every minute, shows notifications, marks tracked threads in your Gmail list (✓ sent, ✓✓ opened or clicked), and fills the dashboard.

**Accuracy:** opens are estimates.
- Blocked images cause missed opens.
- Privacy pre-loading and security scanners cause false opens.
- Gmail's image proxy caches images, so repeat opens may be missed.
- Opens of a forwarded copy are attributed to the original recipient.

Tracklet labels automated activity instead of hiding it.

---

## Repository layout

```
Mailtrack/
├── extension/                Chrome MV3 extension (Vite + TypeScript + React)
│   ├── src/
│   │   ├── background.ts     service worker: tokens, sending, polling, notifications
│   │   ├── content.ts        Gmail integration (isolated world, DOM-only)
│   │   ├── messages.ts       message protocol and sender validation
│   │   ├── gmail/            native Gmail DOM adapter (selectors in one place)
│   │   ├── lib/              send pipeline, MIME, auth, backend client, notifications
│   │   └── ui/               React popup and dashboard
│   ├── public/               icon
│   ├── manifest.base.ts      manifest generator (permissions, OAuth scopes)
│   └── .env.example          build settings → copy to .env.local
├── backend/                  Cloudflare Worker (Hono) + D1
│   ├── src/                  app.ts (routes), classify.ts, crypto.ts, index.ts
│   ├── migrations/           D1 SQL migrations
│   ├── test/                 integration tests (SQLite D1 shim)
│   ├── wrangler.toml         Worker config (no secrets)
│   └── .dev.vars.example     local secrets template → copy to .dev.vars
├── shared/                   types and helpers shared by extension and backend
├── docs/                     all documentation (index: docs/README.md)
│   ├── setup/                Google Cloud, Cloudflare, extension ID
│   ├── design/               architecture, API, database schema, decisions
│   ├── testing/              prototype test plan
│   └── release/              security review, release readiness
├── spikes/                   prototype experiments P1–P6 (not part of the product)
└── scripts/                  secret scan, icon generator, extension-key tool
```

---

## How to use Tracklet

### What you need

- Google Chrome (stable). Use **one Chrome profile per Gmail account**.
- Node.js 22.13 or newer (24 LTS recommended; see `.nvmrc`).
- A Google Cloud project with a **Chrome Extension** OAuth client.
- A free Cloudflare account, for real tracking.

### 1. Install

```sh
git clone https://github.com/Karthickcjx/Mailtrack.git
cd Mailtrack
npm install
npm run check        # typecheck + all tests + build + secret scan
```

### 2. Google Cloud OAuth (one time)

Follow [docs/setup/SETUP_GOOGLE_CLOUD.md](docs/setup/SETUP_GOOGLE_CLOUD.md):
- enable the Gmail API;
- configure the consent screen, and add yourself as a test user while in Testing mode;
- create an OAuth client of type **Chrome Extension** for the extension ID **`hhejoehmmjbjahinnpgnfhfakbkhilcd`**.

Tracklet asks for only three scopes: `openid`, `userinfo.email` and `gmail.send`. **It cannot read your inbox.** No client secret is used.

### 3. Configure the extension build

```sh
cp extension/.env.example extension/.env.local
```

Edit `extension/.env.local`:

| Setting | Value |
|---|---|
| `TRACKLET_OAUTH_CLIENT_ID` | Your Chrome Extension OAuth client ID (`….apps.googleusercontent.com`) |
| `TRACKLET_API_BASE` | Backend address: `http://127.0.0.1:8787` for local testing, or your **https** Worker URL once deployed |

The extension ID is pinned by the public key in `extension/manifest.key.json`. The private key is never in Git ([docs/setup/EXTENSION_ID.md](docs/setup/EXTENSION_ID.md)).

### 4. Run the backend

**Local, for trying the UI, sign-in and dry runs:**

```sh
cp backend/.dev.vars.example backend/.dev.vars      # fill in random values; see comments in the file
npm run db:migrate:local --workspace backend
npm run dev --workspace backend                     # → http://127.0.0.1:8787
```

> ⚠️ **A local backend cannot track real emails.** Gmail loads images through Google's image proxy, which runs on Google's servers, and recipients' devices can't reach your `127.0.0.1` either. Tracklet therefore **refuses to send** a tracked email whose tracking URLs aren't public https. **Preview tracking** still works locally.

**Deployed, for real tracking.** The full runbook is [docs/setup/SETUP_CLOUDFLARE.md § G](docs/setup/SETUP_CLOUDFLARE.md#g-production-deployment-after-sections-ac-with-your-approval). In short:

```sh
cd backend && npx wrangler login && npx wrangler d1 create tracklet && cd ..
#  → put database_id and PUBLIC_BASE_URL (https://t.<subdomain>.workers.dev) in backend/wrangler.toml [env.production]
npm run db:migrate:prod --workspace backend
#  → set secrets: npx wrangler secret put SESSION_SIGNING_KEY | IP_HASH_SALT | ALLOWED_GOOGLE_SUBS --env production (run in backend/)
#  → create extension/.env.release.local with TRACKLET_OAUTH_CLIENT_ID and TRACKLET_API_BASE=<same https URL>
npm run preflight                      # must print "preflight: ready"
npm run deploy --workspace backend     # preflight + wrangler deploy --env production
npm run release                        # check + preflight + production extension build
```

### 5. Build and load the extension

```sh
npm run build --workspace extension
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `extension/dist`.
3. Check that the ID shown is `hhejoehmmjbjahinnpgnfhfakbkhilcd`.
4. Reload any open Gmail tabs.

After every rebuild, click the extension's reload icon and reload Gmail.

### 6. Sign in and allow your account

1. Click the Tracklet toolbar icon, then **Sign in with Google**, and approve.
2. The first time, the popup says **"This Google account is not allowed"**. This is expected, because the backend allowlist starts empty, which allows nobody.
3. Click **Show my Google account ID**. It shows the exact value the backend checks: your Google account ID, not your email.
4. Put that value in the backend allowlist:
   - **local:** in `backend/.dev.vars`, write `ALLOWED_GOOGLE_SUBS=<value>`. Use no quotes; separate several accounts with commas. **Save the file** and restart `npm run dev --workspace backend`;
   - **deployed:** run `npx wrangler secret put ALLOWED_GOOGLE_SUBS`.
5. Click **Retry** in the popup. It should show your email address.

### Daily use

| Task | How |
|---|---|
| **Send a tracked email** | In Gmail, compose a **new** message and click **Send tracked**, next to Gmail's Send. For two or more recipients, confirm the separate-copies dialog. |
| **Check before sending** | **Preview tracking** shows the per-recipient copies and tracked links. **Nothing is sent.** |
| **Send without tracking** | Use Gmail's normal **Send** button. |
| **See who opened or clicked** | Toolbar popup: a 7-day summary. **Open dashboard** shows every tracked email, per-recipient status, links and the event timeline. |
| **Refresh** | **Check now** in the popup, or **Refresh** in the dashboard. Notifications also arrive automatically, polled every minute. |
| **Gmail list marks** | ✓ = sent with tracking, ✓✓ = opened or clicked. |
| **Settings** | Dashboard → **Settings**: open/click notifications, first-open-only, quiet hours, show suspected automated events, optional disclosure line. |
| **Delete data** | One email: open it in the dashboard → **Delete tracking data**. Everything: **Settings → Delete all**. Links in sent emails then stop redirecting. |
| **Sign out** | Popup or Settings → **Sign out**. This revokes Tracklet's Google access. |

**What is not tracked:**
- replies, forwards, and messages with attachments (use normal Send for these);
- group messages as one shared email: each recipient gets a separate copy, Cc is not visible to others, and Reply-All reaches only you.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Can't reach the Tracklet server at …" | The backend isn't running, or `TRACKLET_API_BASE` is wrong. Start the backend, or fix `.env.local` and rebuild. |
| "This Google account is not allowed" | Your account ID isn't in `ALLOWED_GOOGLE_SUBS`. Follow [step 6](#6-sign-in-and-allow-your-account). The wrangler terminal prints `[tracklet-auth]` lines that name the failing stage. |
| "Not sent. Tracking URLs point to http://127.0.0.1:8787…" | The backend isn't publicly reachable over https, so opens could never be recorded. Deploy it ([step 4](#4-run-the-backend)). |
| "Google sign-in is misconfigured" | The OAuth client ID or extension ID doesn't match the Chrome Extension client in Google Cloud. |
| "Sign in to Tracklet (open the popup)" in Gmail | There's no valid session. Sign in from the popup; Gmail itself can't start sign-in. |
| No **Send tracked** button | It appears only on **new** messages. Reload Gmail after installing or reloading the extension. |
| "Tracklet was updated — reload Gmail" | The extension was reloaded while Gmail was open. Reload the Gmail tab. |
| A draft is left after sending | Gmail's Discard control wasn't found, so Tracklet closed the compose window instead. Delete the draft from **Drafts**. |
| Opens appear immediately after sending | These are usually security scanners or prefetch. They are labelled and not counted; turn on *Show suspected automated events* to see them. |
| Sign-in may stop after about 7 days | The OAuth app is in Google *Testing* mode. Whether Chrome's tokens are affected is still being verified (P1.8). If it happens, sign in again from the popup. |

---

## Development

```sh
npm run typecheck                        # all workspaces + spikes
npm test                                 # Vitest: backend, extension, shared, spikes
npm run build                            # builds extension/dist
npm run secret-scan                      # fails on keys/tokens in tracked files or dist
npm run check                            # all of the above
npm run preflight                        # production config check (before deploy/release)
npm run release                          # check + preflight + release build of the extension
npm run dev --workspace extension        # rebuild extension on change
npm run dev --workspace backend          # local Worker on :8787
```

Database: **Cloudflare D1** (SQLite). Locally it is a file under `backend/.wrangler/state/` created by `wrangler dev`. The tests run the same migrations on Node's built-in SQLite.

Design and decisions: [docs/README.md](docs/README.md).

---

## Security and privacy

See [docs/release/SECURITY_REVIEW.md](docs/release/SECURITY_REVIEW.md). In summary:
- **Access:** three OAuth scopes and four Chrome permissions. The Google token stays in the extension's service worker. The backend accepts only allowlisted Google accounts and re-checks the allowlist on every request.
- **Data stored:** no readable subjects or recipient addresses on the server; IP addresses only as a salted monthly hash; events deleted after 180 days; one-click "delete all data".
- **Secrets:** never committed. `backend/.dev.vars` and `extension/.env.local` are gitignored. The OAuth client ID and the extension's public key are public identifiers.
