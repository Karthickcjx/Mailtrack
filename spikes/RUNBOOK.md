# Spike runbook (manual steps performed by you)

All spikes are throwaway and local. Nothing here deploys anything. Record outcomes in `spikes/RESULTS.md`.

## 0. Dedicated Chrome profile (Q14)
1. Chrome → profile menu → **Add** → "Tracklet test". Sign in to Chrome with your **tracking Gmail account** (account A); turning Sync on is optional.
2. Open chrome://extensions in that profile and enable **Developer mode**.

## P1 + P3 — OAuth and MIME send (needs SETUP_GOOGLE_CLOUD §A–E-1)
1. Create the **Chrome Extension** OAuth client with Item ID `hhejoehmmjbjahinnpgnfhfakbkhilcd` (docs/EXTENSION_ID.md).
2. Build the spike:
   `TRACKLET_OAUTH_CLIENT_ID=<client-id> node spikes/p1-oauth/build.mjs`
3. **Load unpacked** `spikes/p1-oauth/dist` and confirm the ID shown equals the Item ID (P1.1).
4. Open the popup and click the buttons in order: P1.2 → P1.3 (5× over 10 min) → P1.5 → P1.3.
5. P1.4: add a second Google account to the same profile (Chrome profile → add Google account / sign in on google.com), then request A explicitly. Record the outcome.
6. **P3.2:** enter 1–3 addresses of **your own** second test account (plus-aliases like `second+cc@gmail.com` are fine) and click Send. Then inspect:
   - B's inbox: one recipient per copy (P3.2); subject and HTML render (P3.1)
   - A's Sent → "Show original" on copy 1: was our `Message-ID` kept? (P3.3)
   - A's Sent: one thread or three? (P3.4)
   - Reply-All from B: only A (P3.5)
7. P1.7: click **Revoke**, then P1.3 (it should fail), then P1.2 (re-consent).
8. P1.8: on day 8 after consent, click P1.3 and record what happens.
9. Copy the popup log into `spikes/RESULTS.md`. Tokens are never printed.

## P4 — Gmail image proxy (no Google Cloud project needed)
1. `node spikes/p4-pixel/logger.mjs` (terminal 1)
2. `~/.tracklet/bin/cloudflared.exe tunnel --no-autoupdate --url http://127.0.0.1:8799` (terminal 2), then copy the `https://….trycloudflare.com` URL.
3. In A's Gmail compose (Insert photo → Web address), insert `https://<tunnel>/o/ns-p4a.gif`, send to B, then follow PROTOTYPE_TEST_PLAN P4.2–P4.6. Use `m0-…` / `nc-…` tokens for P4.5.
4. Watch terminal 1, or open `https://<tunnel>/log`.
5. **Stop both processes (Ctrl+C) when finished.** The tunnel URL is temporary and changes each run.

## P5 — Self-open neutralisation (no Google Cloud project needed)
1. Run the P4 logger and tunnel.
2. Load unpacked `spikes/p5-selfopen` in the test profile. In its service-worker console (chrome://extensions → Inspect), run:
   `chrome.storage.local.set({tunnelHost: '<sub>.trycloudflare.com'})`
3. Reload Gmail. Open 20 Sent messages containing `https://<tunnel>/o/ns-p5-N.gif`, inserted as in P4. Count pixel hits vs `view` entries in the log (P5.2, P5.4). Record the proxied `src` format from the console (P5.3).
4. P5.5: open one in the Gmail mobile app and record the hit.

## P2 runtime — gmail.js harness (no Google Cloud project, no OAuth, sends nothing)
The harness has **no permissions**, makes **no network requests**, and its buttons only *read* the composer or *close* it (Esc). It never sends.
1. Build both variants:
   - `node spikes/p2-gmailjs/build.mjs native` → `spikes/p2-gmailjs/dist-native` (**run this first**)
   - `node spikes/p2-gmailjs/build.mjs gmailjs` → `spikes/p2-gmailjs/dist-gmailjs`
   
   Remove any older "Tracklet P2 spike" from chrome://extensions first (the round-2 `dist/` build is the one that failed).
2. In the dedicated test profile, **Load unpacked** one variant at a time and run steps 3–13 for each. The panel title shows `(native)` or `(gmailjs)`. Expectation: `P2.10 trusted-types-60s` = PASS with 0 violations; if not, copy the `ttViolations` entries.
3. Open https://mail.google.com (account A) and open DevTools (F12) → Console and Network tabs. A small "P2 gmail.js harness" panel appears bottom-left.
4. **P2.9 load / P2.10 Trusted Types:** within about 10 s the panel shows `PASS P2.9 load`. Note any `P2.10 trusted-types` line, and any red console errors mentioning `TrustedHTML` or `gmail.js`.
5. **P2.5 compose detection + button:** click Compose. Expect `PASS P2.5 compose-detected` and two buttons, **"P2: Read"** and **"P2: Close"**, next to Send.
6. **P2.6 reading fields:** in that compose, enter:
   - To: 2 addresses (your own test addresses); Cc: 1; Bcc: 1. Open Cc/Bcc with the links in the To row.
   - Subject: `P2 Résumé ✓ 測試`
   - Body: a line of text plus a link; make sure your Gmail signature is present.

   Then click **P2: Read**. Repeat with 10 different composes, including one with an attachment (drag in any small file) and one where the last address is still being typed (not yet a chip). Compare each `P2.6` entry with what you typed. Expect: all chips present, correct field split, exact subject, `htmlHasSignatureDiv: true` when a signature exists, `hasAttachments` correct.
7. **P2.7 close and draft:** in a compose with content, click **P2: Close**. Then open **Drafts** and record whether a draft exists. (gmail.js closes with Esc, so Gmail is expected to keep a draft; the point is to confirm it.)
8. **Reply/forward:** open any received email → Reply, then Forward. Record the `kind` shown in `P2.5 compose-detected` (expected `reply`, `forward`).
9. **P2.8 Sent-list marks:** open **Sent**. Every row whose thread ID could be parsed gets a green `✓` before the date. The panel shows `rows {rows, withId, …}`. Pass if `withId == rows` and marks are visible. Also check Inbox and a search results page, and after switching folders 5 times.
10. **P2.11 thread view:** open 3 threads; each should add a `P2.11 view_thread` entry with a thread ID.
11. **P2.3 network:** after 60 s the panel shows `P2.3 unexpected-hosts-60s` PASS/FAIL. Also filter the DevTools Network tab with `-domain:*.google.com -domain:*.gstatic.com -domain:*.googleusercontent.com -domain:*.googleapis.com` and record anything left.
12. **P2.9 stability:** reload Gmail 10 times and switch Inbox ↔ Sent. Record any uncaught errors from `page.js`.
13. Click **Copy results** (addresses are redacted as `a***@`) and paste the JSON into `spikes/RESULTS.md` under P2.
14. Remove the harness extension when done.
