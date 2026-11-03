# API SPEC — Tracking backend (Cloudflare Worker) — rev 2

Base URL (initial): `https://<neutral-name>.<account-subdomain>.workers.dev` (decision D3).
- Public tracking endpoints: `/o/*`, `/c/*`. No authentication.
- Private API: `/v1/*`. Bearer session, CORS-locked to `chrome-extension://<fixed-id>`.

JSON everywhere on `/v1`. Requests and responses are validated with shared zod schemas.

Changes from rev 1:
- Addresses and subjects are optional (privacy defaults).
- `recipient_key` added; `mode` added; `implied_open` type.
- WAF rate-limit replaced with in-Worker limits (workers.dev has no WAF rules).
- `/v1/views` window set to ±90 s.
- Device cookie removed.

---

## 0. Cross-cutting rules

### Authentication
`Authorization: Bearer <session>`. The session is an HS256 JWT `{sub:user_id, iat, exp: +30d}` signed with `SESSION_SIGNING_KEY`. On `401`, the extension re-runs `/v1/auth/session`.

### Errors
`{"error":"<code>","details":[…]}` with codes `validation_failed 400`, `unauthorized 401`, `forbidden 403`, `not_found 404`, `conflict 409`, `too_large 413`, `rate_limited 429`, `internal 500`.

### Abuse prevention
| Control | Implementation |
|---|---|
| Single-user allowlist | `ALLOWED_GOOGLE_SUBS` checked at session creation **and** on every request (cached) |
| API rate limit | Workers Rate Limiting binding if available on the Free plan ([ASSUMPTION], checked in Phase 0); otherwise a fixed-window counter: 120 req/min per user |
| Registration limits | ≤ 100 emails/hour/user, ≤ 20 recipients/email, ≤ 50 links/email, body ≤ 64 KB |
| Tracking flood | `token_daily_caps`: > 100 hits/token/day → events not stored, only counted |
| Token probing | Unknown pixel tokens get the identical GIF; unknown click tokens get a generic 404 page; constant-shape responses |
| Open redirect | Redirect target comes **only** from the DB row. No URL parameters are accepted |
| URL validation | `http`/`https` only, no userinfo, ≤ 2048 chars, IDNs normalised to punycode. `mailto:`, `tel:`, `#` and `javascript:` links are left **unrewritten** by the extension and rejected by the API |
| Output safety | The dashboard renders all values as text (React escaping); no HTML from the backend |

### Privacy
- No raw IPs (HMAC with a monthly-rotating salt), UA truncated to 128 chars, no bodies, and no subjects or addresses unless enabled in preferences.
- No cookies are ever set by `/o` or `/c`. Both send `Referrer-Policy: no-referrer`.
- `DELETE /v1/emails/{id}` and `DELETE /v1/me/data` hard-delete data.

---

## 1. Session

### `POST /v1/auth/session`
```json
{ "google_access_token": "ya29.a0Af…" }
```
Server:
1. `GET https://oauth2.googleapis.com/tokeninfo?access_token=…`.
2. Require `aud == GOOGLE_WEB_CLIENT_ID`, `email_verified`, `expires_in > 0`, and `scope` containing `openid` and `email`.
3. Require `sub ∈ ALLOWED_GOOGLE_SUBS`.
4. Upsert the user and create the default preferences.
```json
200 {"session_token":"eyJ…","expires_at":1796400000000,"user":{"id":"01JD09…U1","email":"me@gmail.com"}}
403 {"error":"forbidden"}            // account not on allowlist
401 {"error":"unauthorized"}         // invalid/expired Google token
```
The Google token is used once and never stored or logged.

---

## 2. Register a tracked email

### `POST /v1/emails`
Called before any Gmail send. Idempotent on `client_request_id`.
```json
{
  "client_request_id": "6c1b4f0e-2b8e-4a0f-9a8e-3f9d3c1e7b20",
  "mode": "individual_group",
  "subject": null,
  "track_opens": true,
  "track_clicks": true,
  "disclosure_added": false,
  "recipients": [
    {"recipient_key": "r8xk…", "original_field": "to", "address": null},
    {"recipient_key": "p02c…", "original_field": "cc", "address": null}
  ],
  "links": [
    {"index": 0, "url": "https://example.com/offer"},
    {"index": 1, "url": "https://example.com/faq?x=1#top"}
  ]
}
```
Validation:
- `mode='single'` requires exactly 1 recipient; `individual_group` requires 2–20.
- `recipient_key` is 43-char base64url and unique within the email.
- `address` must be null unless the user's `store_addresses=1`; `subject` must be null unless `store_subjects=1`. Otherwise the server rejects with `400`, as a privacy guard.
```json
201 {
  "email_id": "01JD0A…E1",
  "recipients": [
    {"recipient_id": "01JD0A…R1", "recipient_key": "r8xk…",
     "pixel_url": "https://…workers.dev/o/Qm3v0aTf8Lw2kZpX1nB9cA.gif",
     "links": [{"index":0,"click_url":"https://…workers.dev/c/Kp7…"},
               {"index":1,"click_url":"https://…workers.dev/c/Ww2…"}]},
    {"recipient_id": "01JD0A…R2", "recipient_key": "p02c…", "pixel_url": "…", "links": […]}
  ]
}
```
A replay with the same `client_request_id` returns `200` with the identical body.

### `PATCH /v1/emails/{email_id}/recipients/{recipient_id}`
```json
{"send_status":"sending"}
{"send_status":"sent","gmail_message_id":"192b…a1","gmail_thread_id":"192b…","sent_at":1793800002000}
{"send_status":"failed","send_error":"gmail_429"}
```
`200 {"email_status":"sending|sent|partial|failed"}`.
- Allowed transitions: `pending→sending→sent|failed`, `failed→sending` (manual retry only).
- `sent` is terminal. A second `sent` with the same message id is a no-op; a different message id is `409`.

### `DELETE /v1/emails/{email_id}` → `204`
### `DELETE /v1/me/data` → `204` (all emails, events and preferences; the user row is kept until the session ends)

---

## 3. Open pixel (public)

### `GET|HEAD /o/{pixel_token}.gif`
Always:
```http
200 OK
Content-Type: image/gif
Content-Length: 43
Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private
Expires: Thu, 01 Jan 1970 00:00:00 GMT
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
```
Post-response (`ctx.waitUntil`):
1. Validate the token format (22 base64url chars); invalid → stop.
2. Upsert `token_daily_caps`; if over the cap → stop.
3. Look up the recipient (and the email's `sent_at`, user and thread).
4. Classify per ARCHITECTURE §5.2 (includes the sender-view lookup and dedupe query).
5. A batch inserts the event and, if counted, updates `recipients.open_count/first/last_open_at`.

Targets: p95 response under 50 ms at the edge; CPU under 5 ms.

## 4. Click redirect (public)

### `GET|HEAD /c/{click_token}`
```http
302 Found
Location: <stored target_url>
Cache-Control: no-store
Referrer-Policy: no-referrer
```
- Unknown or malformed token: `404`, minimal HTML "This link is unavailable." Nothing is recorded.
- Post-response: same pipeline as opens, with click rules (§5.2).
- If the click is counted and the recipient has no counted open, an `implied_open` event is also inserted.

---

## 5. Analytics

### `GET /v1/emails/{email_id}?include_suspected=true&events_limit=200`
```json
200 {
  "email_id":"01JD0A…E1","mode":"individual_group","subject":null,"status":"sent",
  "sent_at":1793800002000,"gmail_thread_id":"192b…",
  "totals":{"recipients":2,"sent_recipients":1,"opened_recipients":1,"opens":1,"clicks":1,"suspected_events":2},
  "recipients":[
    {"recipient_id":"01JD0A…R1","recipient_key":"r8xk…","address":null,"original_field":"to",
     "send_status":"sent","open_count":1,"first_open_at":1793803600000,"last_open_at":1793803600000,
     "click_count":1,"status_label":"clicked"},
    {"recipient_id":"01JD0A…R2","recipient_key":"p02c…","original_field":"cc",
     "send_status":"failed","status_label":"not_sent"}
  ],
  "links":[{"index":0,"url":"https://example.com/offer","clicks":1,"unique_recipients":1}],
  "events":[
    {"id":"01JD0D…V1","type":"open","recipient_id":"01JD0A…R1","classification":"prefetch_suspected",
     "counted":false,"ua_family":"Unknown","occurred_at":1793800006200},
    {"id":"01JD0D…V2","type":"open","recipient_id":"01JD0A…R1","classification":"proxy_open",
     "counted":true,"ua_family":"GoogleImageProxy","occurred_at":1793803600000}
  ],
  "accuracy_note":"Opens are estimates; see help."
}
```
The extension merges in the subject, addresses and anchor text from local `meta:<email_id>`.
`status_label ∈ not_sent | sent | likely_opened | clicked | suspected_only`.

### `GET /v1/events?since=<ulid>&limit=100`
```json
200 {"events":[{"id":"01JD0D…V3","type":"click","email_id":"01JD0A…E1","recipient_id":"01JD0A…R1",
                "classification":"human_likely","counted":true,"link_index":0,
                "occurred_at":1793803700000,"notify":true}],
     "next_cursor":"01JD0D…V3","more":false}
```
`notify` is computed from the preferences (first-only, suspected, quiet hours). If the extension sees more than 5 notify events in one poll, it shows a single summary notification.

## 6. Dashboard

### `GET /v1/dashboard?range=7d|30d|90d`
```json
200 {"range":"30d",
     "totals":{"emails_sent":42,"recipients":55,"opened_recipients":31,"open_rate":0.56,
               "clicks":14,"clicked_recipients":9,"click_rate":0.16,"suspected_events":23},
     "daily":[{"date":"2026-11-01","sent":3,"opens":4,"clicks":1}],
     "top_emails":[{"email_id":"01JD0A…E1","opens":6,"clicks":3}],
     "accuracy_note":"Open rates include proxy-loaded opens and exclude suspected automated events."}
```
`date` buckets use the user's preference timezone.

### `GET /v1/emails?cursor=<ulid>&limit=25&filter=all|opened|unopened|clicked`
```json
200 {"items":[{"email_id":"01JD0A…E1","sent_at":1793800002000,"mode":"individual_group",
               "recipients":2,"opened_recipients":1,"clicks":1,"last_activity_at":1793803700000}],
     "next_cursor":null}
```
Subject search runs **locally** in the extension (subjects aren't on the server by default).

### `GET /v1/threads/status?ids=<id>,<id>` (≤ 50)
```json
200 {"192b…":{"email_id":"01JD0A…E1","label":"likely_opened","opened_recipients":1,"recipients":2}}
```

## 7. Sender view signal

### `POST /v1/views`
```json
{"gmail_thread_id":"192b…","viewed_at":1793803601000}
```
`204`. The server stores the view and reclassifies counted opens on that thread's recipients within ±90 s to `self_suspected` (decrementing the counters). Rate limit: 1 per thread per 10 s.

## 8. Preferences

### `GET /v1/preferences`
### `PUT /v1/preferences`
```json
{"notify_open":true,"notify_click":true,"notify_first_only":true,"include_suspected":false,
 "quiet_start_min":1320,"quiet_end_min":420,"timezone":"Asia/Kolkata",
 "store_subjects":false,"store_addresses":false,
 "disclosure_enabled":false,"disclosure_text":null}
```
`200` returns the stored row. Turning `store_*` off does **not** retroactively delete stored values unless `?purge=true` is passed.
