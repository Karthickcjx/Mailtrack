# Tracklet

Personal **open and click tracking** for emails you send from Gmail.

It has two parts:
- a **Chrome extension** (Manifest V3) that adds **Send tracked** to Gmail and provides a popup, a dashboard and desktop notifications;
- a small **Cloudflare Workers + D1** backend that serves the tracking pixel and the click redirects, and stores events.

Tracklet is built for **one person, or a short allowlist of Google accounts**. It is not a multi-tenant service.

> **Status:** production-ready code, CI on every push, verified locally. Real open and click tracking needs the backend deployed at a public **https** address (see [Part D](#part-d--deploy-the-backend-to-cloudflare)). See [docs/release/RELEASE_READINESS.md](docs/release/RELEASE_READINESS.md).

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [Step-by-step setup](#step-by-step-setup) (parts A–H) and [daily use](#daily-use)
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

## Step-by-step setup

Allow about 45 minutes the first time. Do the parts **in order**: each one produces a value the next part needs.

| Part | What you do | What you get |
|---|---|---|
| [A](#part-a--install-the-tools) | Install the tools | Node.js, Git, Chrome |
| [B](#part-b--get-the-code) | Get the code | A working build on your PC |
| [C](#part-c--google-cloud-oauth-client) | Set up Google Cloud | **OAuth client ID** |
| [D](#part-d--deploy-the-backend-to-cloudflare) | Deploy the backend | **https Worker URL** |
| [E](#part-e--build-the-extension) | Build the extension | `extension/dist` |
| [F](#part-f--load-the-extension-in-chrome) | Load it in Chrome | Tracklet icon in the toolbar |
| [G](#part-g--sign-in-and-allow-your-account) | Sign in and allow your account | A signed-in popup |
| [H](#part-h--send-your-first-tracked-email) | Send a test email | Your first tracked open |

> Only want to try the interface without real tracking? See [Local-only mode](#local-only-mode-no-deployment).

---

### Part A — Install the tools

1. Install **Node.js 24 LTS** from https://nodejs.org (22.13 or newer works).
2. Install **Git** from https://git-scm.com.
3. Install **Google Chrome** (stable).
4. Use **one Chrome profile per Gmail account**: Tracklet signs in with the profile's main Google account.
5. Check the tools in a terminal:
   ```sh
   node --version     # v22.13 or newer
   git --version
   ```

You also need a **Google account** (the Gmail you'll send from) and a free **Cloudflare account** (https://dash.cloudflare.com/sign-up).

### Part B — Get the code

1. Clone the repository and install dependencies:
   ```sh
   git clone https://github.com/Karthickcjx/Mailtrack.git
   cd Mailtrack
   npm install
   ```
2. Check everything works:
   ```sh
   npm run check
   ```
   ✅ You should see all tests passing and `secret-scan: … 0 finding(s)`.

### Part C — Google Cloud OAuth client

Sign into https://console.cloud.google.com with **the Gmail account you'll send from**. Full details are in [docs/setup/SETUP_GOOGLE_CLOUD.md](docs/setup/SETUP_GOOGLE_CLOUD.md).

1. **Create a project.** Use the project picker → **New Project** (for example `tracklet-personal`), then select it.
2. **Enable the Gmail API.** Go to **APIs & Services → Library**, search for "Gmail API" and click **Enable**.
3. **Configure the consent screen.** Go to **APIs & Services → OAuth consent screen** and click **Get started**:
   - App name `Tracklet`, with your Gmail as the support email;
   - Audience **External**;
   - your Gmail as the contact email;
   - accept the policy and click **Create**.
4. **Add yourself as a test user.** Under **Audience → Test users**, add your Gmail. Leave the app in **Testing**.
5. **Add the scopes.** Under **Data Access → Add or remove scopes**, add exactly these three, and save:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.send`
6. **Create the OAuth client.** Go to **Clients → Create client**:
   - Application type **Chrome Extension**;
   - Name `tracklet-extension`;
   - **Item ID** `hhejoehmmjbjahinnpgnfhfakbkhilcd`.
7. Click **Create**. This client type has **no client secret**.
8. ✅ **Copy the Client ID** (`…apps.googleusercontent.com`). You need it in parts D and E.

> The extension ID `hhejoehmmjbjahinnpgnfhfakbkhilcd` is fixed by the public key in `extension/manifest.key.json`, so every build of this repository has the same ID ([details](docs/setup/EXTENSION_ID.md)).
> Don't add other scopes, create a client secret, or enable billing.

### Part D — Deploy the backend to Cloudflare

All commands run from the repository root unless shown with `cd backend`. The full runbook is [docs/setup/SETUP_CLOUDFLARE.md § G](docs/setup/SETUP_CLOUDFLARE.md#g-production-deployment-after-sections-ac-with-your-approval).

1. **Log in to Cloudflare.** This opens the browser:
   ```sh
   cd backend
   npx wrangler login
   ```
2. **Create the database** (still in `backend/`):
   ```sh
   npx wrangler d1 create tracklet
   ```
   ✅ Copy the printed `database_id`.
3. **Find your workers.dev subdomain.** In the Cloudflare dashboard, open **Workers & Pages**; your account's `<subdomain>.workers.dev` is shown there. A new account is asked to choose one the first time. Recipients can see it in tracking links, so pick something neutral ([details](docs/setup/SETUP_CLOUDFLARE.md#b-choose-the-workersdev-account-subdomain-visible-to-every-recipient)). Your Worker URL will be **`https://t.<subdomain>.workers.dev`**.
4. **Edit `backend/wrangler.toml`, in the `[env.production]` part only:**
   ```toml
   [env.production.vars]
   GOOGLE_CLIENT_ID = "<your client ID from Part C>"
   PUBLIC_BASE_URL  = "https://t.<subdomain>.workers.dev"      # no trailing slash

   [[env.production.d1_databases]]
   database_id = "<database_id from step 2>"
   ```
   Also set the same `GOOGLE_CLIENT_ID` in the top `[vars]` section, which local development uses.
5. **Create the tables** (from the repository root):
   ```sh
   npm run db:migrate:prod --workspace backend
   ```
6. **Set the two secrets.** Generate a random value for each and paste it when prompted. Secrets are never stored in files or Git.
   ```sh
   cd backend
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # run twice: one value per secret
   npx wrangler secret put SESSION_SIGNING_KEY --env production
   npx wrangler secret put IP_HASH_SALT --env production
   cd ..
   ```
   (`ALLOWED_GOOGLE_SUBS` is set in Part G, once you know your account ID.)
7. **Deploy:**
   ```sh
   npm run deploy --workspace backend
   ```
   This first runs a safety check that refuses placeholder values, then deploys.
8. **Verify:** open `https://t.<subdomain>.workers.dev/health` in the browser.
   ✅ You should see `{"status":"ok","service":"tracklet-backend",…}`.

### Part E — Build the extension

1. Create **`extension/.env.release.local`**. It is gitignored. It should contain:
   ```
   TRACKLET_OAUTH_CLIENT_ID=<your client ID from Part C>
   TRACKLET_API_BASE=https://t.<subdomain>.workers.dev
   ```
2. Run the production check:
   ```sh
   npm run preflight
   ```
   ✅ It must end with **`preflight: ready`**. If not, it lists exactly what to fix: placeholder, http URL, mismatched client ID, and so on.
3. Build:
   ```sh
   npm run release
   ```
   ✅ The production extension is in **`extension/dist`**.

### Part F — Load the extension in Chrome

1. Open **`chrome://extensions`**.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/dist`** folder.
4. ✅ Check that the ID under *Tracklet* is **`hhejoehmmjbjahinnpgnfhfakbkhilcd`**.
5. Pin Tracklet: click the puzzle icon in the toolbar, then the pin next to Tracklet.
6. Reload any open Gmail tabs.

> After every rebuild, click the ↻ reload icon on the Tracklet card, then reload Gmail.

### Part G — Sign in and allow your account

The backend allows nobody until you add your Google account ID. This is a one-time step.

1. Click the Tracklet toolbar icon, then **Sign in with Google**.
2. Google shows *"Google hasn't verified this app"*. This is normal for a personal app in Testing mode. Click **Advanced → Go to Tracklet (unsafe)**, then **Continue**.
3. The popup now says **"This Google account is not allowed"**. This is expected.
4. Click **Show my Google account ID**. ✅ Copy the value shown: a long string, **not** your email.
5. Save it on the backend, pasting the value when prompted:
   ```sh
   cd backend
   npx wrangler secret put ALLOWED_GOOGLE_SUBS --env production
   cd ..
   ```
   For several accounts, separate the IDs with commas.
6. In the popup, click **Retry**. ✅ It shows your email address and the 7-day summary.

### Part H — Send your first tracked email

1. Open Gmail and click **Compose**.
2. Enter an address you can open (for example another Gmail of yours), a subject and some text. A link is optional.
3. Click **Preview tracking**. It shows what will be sent and **sends nothing**.
4. Click **Send tracked**, next to Gmail's blue Send button.
   ✅ A green note says *"Sent 1 tracked copy"*.
5. Wait **at least 15 seconds**. Opens in the first seconds after sending are treated as automatic scanning. Then open the email in the recipient's inbox.
6. Within about a minute you get a desktop notification. ✅ The popup shows **Opened: 1**. Click **Open dashboard** for the details.

**Verify on the server (optional).** Run `cd backend && npx wrangler tail --env production` to watch live logs. A `[tracklet-track] {"type":"open","token_known":true,…}` line confirms the open arrived. The logs never contain tokens or email addresses.

**You're done.** From now on, use **Send tracked** for messages you want to track and the normal **Send** for everything else.

---

### Local-only mode (no deployment)

Use this to try the interface, sign-in and **Preview tracking** without Cloudflare. **Real emails cannot be tracked this way:** Gmail loads images through Google's servers, which can't reach your PC. Tracklet therefore refuses **Send tracked** in this mode, with an explanation.

1. Complete parts A–C.
2. Set up the local backend config and database:
   ```sh
   cp backend/.dev.vars.example backend/.dev.vars
   # Edit backend/.dev.vars: SESSION_SIGNING_KEY and IP_HASH_SALT = random values (command in Part D step 6)
   npm run db:migrate:local --workspace backend
   ```
3. Start the backend, and keep this terminal open:
   ```sh
   npm run dev --workspace backend
   ```
   ✅ It prints `Ready on http://127.0.0.1:8787`.
4. Create **`extension/.env.local`** containing `TRACKLET_OAUTH_CLIENT_ID=<client ID>` and `TRACKLET_API_BASE=http://127.0.0.1:8787`. Then build with `npm run build --workspace extension`.
5. Do Part F.
6. Do Part G, but save the ID in **`backend/.dev.vars`** as `ALLOWED_GOOGLE_SUBS=<value>` (no quotes). **Save the file**, then restart step 3.

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
| "This Google account is not allowed" | Your account ID isn't in `ALLOWED_GOOGLE_SUBS`. Follow [Part G](#part-g--sign-in-and-allow-your-account). The wrangler terminal prints `[tracklet-auth]` lines that name the failing stage. |
| "Not sent. Tracking URLs point to http://127.0.0.1:8787…" | The backend isn't publicly reachable over https, so opens could never be recorded. Deploy it ([Part D](#part-d--deploy-the-backend-to-cloudflare)). |
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
