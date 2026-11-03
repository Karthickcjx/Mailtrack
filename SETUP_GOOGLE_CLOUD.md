# CHECKLIST — Google Cloud project and OAuth client (performed by you)

Claude does **not** perform these steps.
- Facts are cited from `VERIFIED_PLATFORM_FACTS.md`.
- Console labels change over time. If a label differs, follow the closest equivalent and note it in `spikes/RESULTS.md`.
- Account: the **consumer @gmail.com account you will track from** (D1). Use the same account for the console, so you are automatically the owner.

> **Pending decision D2-rev (see OPEN_QUESTIONS Q14).** Google now "strongly discourages" the implicit flow (O1) that rev 2 chose. The recommended alternative is the official **Chrome Extension** client type with `chrome.identity.getAuthToken` (O5, C-b, C-c). Sections A–D are identical for both options; only section E differs. **Do not do section E until Q14 is answered.**

---

## A. Create the project
1. Open https://console.cloud.google.com/ while signed into your tracking Gmail account.
2. In the project picker, choose **New Project**.
   - Name: `tracklet-personal` (any neutral name).
   - Organization: *No organization* (consumer account).
3. Wait for the creation notification, then select the project.
4. ☐ Record the **Project ID**: `________________`

## B. Enable the Gmail API
1. Go to **APIs & Services → Library**, search "Gmail API", and click **Enable**.
2. Go to **APIs & Services → Gmail API → Quotas**. Record the per-user quota shown. Projects created after 2026-05-01 have new quotas (M-f).
   - ☐ Per-user per-minute quota: `________`

## C. Configure the OAuth consent ("Google Auth Platform")
1. Go to **APIs & Services → OAuth consent screen**. It may open "Google Auth Platform"; click **Get started** if prompted.
2. **App information**:
   - App name: `Tracklet (personal)`. Do **not** use "Mailtrack", "Mailsuite" or any Google brand.
   - User support email: your Gmail.
3. **Audience / User type**: **External**. Internal is not available to consumer accounts (V-b, V-c).
4. **Contact information**: your Gmail.
5. Accept the policy and click **Create**.
6. Under **Audience**:
   - Confirm the **Publishing status = Testing**. Do **not** click "Publish app".
   - **Test users → Add users**: add your tracking Gmail address. Optionally add the second test Gmail account, but only if it will also *send* (it doesn't need to just receive).
   - Testing is limited to 100 test users; authorizations expire 7 days after consent (V-a, O8).
7. Under **Data Access → Add or remove scopes**, add **exactly**:
   - `openid`
   - `.../auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.send` (it shows under "sensitive scopes" (M-a))

   Add nothing else; any additional scope requires a new approval.
8. **Branding**: leave the logo empty. Adding a logo can trigger brand verification. Homepage and privacy-policy URLs are optional while in Testing; leave them blank for now.
9. Save. Ignore any "verification required" banner. Verification is not mandatory for personal use or for testing (V-e).

## D. Things you must NOT do
- ☐ Do not publish the app to Production yet.
- ☐ Do not create or download any client **secret**. If a console flow shows one, don't copy it into the repo or the extension.
- ☐ Do not add restricted scopes (`gmail.readonly`, `gmail.metadata`, `gmail.compose`, `gmail.modify`, `gmail.insert`, `mail.google.com`) (M-a).
- ☐ Do not enable billing. It is not required for the Gmail API.

## E. Create the OAuth client (do this only after Q14 is answered and the extension ID exists)

Prerequisite: a **stable extension ID**. Two options (Q15):
- **E0-official** (C-d): upload a zip of the Phase 0 skeleton to the Chrome Web Store Developer Dashboard **without publishing**, then copy the public key into `manifest.json` `"key"`. This requires a Chrome Web Store developer registration, which has historically had a one-time fee; check the dashboard.
- **E0-local** (not covered by the docs I read; widely used): generate an RSA key pair locally, put the public key in `"key"`, and Chrome derives the ID from it. No account needed. Claude would provide the commands in Phase 0.

☐ Extension ID: `________________________________`

### E-1 (recommended, D2-rev): Chrome Extension client
1. Go to **Google Auth Platform → Clients → Create client**.
2. Application type: **Chrome Extension** (O5, C-c).
3. Name: `tracklet-extension`.
4. **Item ID**: the extension ID above.
5. Create. There is **no client secret** for this type (O6).
6. ☐ Record the **Client ID** (`…apps.googleusercontent.com`): `________________`

### E-2 (original rev 2 D2, legacy implicit flow): Web application client
1. **Clients → Create client → Web application**.
2. Authorized redirect URI: `https://<extension-id>.chromiumapp.org/` (C-a).
3. Record the Client ID. **Do not store the client secret anywhere.**

## F. Hand-off to Claude (safe to share)
Only these values. All of them are public identifiers, not secrets:
- Project ID
- Client ID
- Extension ID
- The Gmail API per-user quota value

Never paste passwords, recovery codes or any client secret.

## G. Verification after setup (part of spike P1)
- In chrome://extensions the loaded extension's ID equals the Item ID.
- The first sign-in shows the "Google hasn't verified this app" screen. Continue via *Advanced → Go to Tracklet (unsafe)* (V-d). Consent lists "Send email on your behalf".
- At https://myaccount.google.com/permissions, "Tracklet (personal)" appears with Gmail send access.
- Expect to re-consent about 7 days later (O8, V-a). Changing your Google password also invalidates Gmail-scoped refresh tokens (O9).
