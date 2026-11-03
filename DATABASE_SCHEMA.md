# DATABASE SCHEMA — Cloudflare D1 (SQLite) — rev 2

Changes from rev 1:
- Subjects and recipient addresses are **not stored by default** (D10, D11). They are replaced by an optional `subject`, an optional `address`, and an HMAC `recipient_key`.
- Classifications renamed and extended; `classifier_version` added.
- `device_id_hash` removed (cookie layer dropped).
- Per-token daily caps added.
- D1 free limit corrected to about 500 MB per database.

Conventions:
- IDs: ULID text. Public tokens: 128-bit CSPRNG base64url (22 chars).
- Times: integer Unix milliseconds (UTC).
- Foreign keys enforced. Booleans are INTEGER 0/1.

## Relationships
```
users 1─1 notification_preferences
users 1─* tracked_emails 1─* recipients 1─* tracked_links
                                     recipients 1─* tracking_events *─0..1 tracked_links
users 1─* sender_views
token_daily_caps (by token, by day)
```

## 1. users
```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,          -- the account itself (needed for From/allowlist display)
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);
```

## 2. tracked_emails
```sql
CREATE TABLE tracked_emails (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id  TEXT NOT NULL,
  subject            TEXT,                -- NULL unless preferences.store_subjects = 1
  mode               TEXT NOT NULL CHECK (mode IN ('single','individual_group')),
  gmail_thread_id    TEXT,                -- from first copy's send response
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','sending','sent','partial','failed')),
  track_opens        INTEGER NOT NULL DEFAULT 1,
  track_clicks       INTEGER NOT NULL DEFAULT 1,
  disclosure_added   INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  sent_at            INTEGER,
  UNIQUE (user_id, client_request_id)
);
CREATE INDEX idx_emails_user_created ON tracked_emails(user_id, created_at DESC);
CREATE INDEX idx_emails_user_thread  ON tracked_emails(user_id, gmail_thread_id);
```

## 3. recipients (one row per delivered copy)
```sql
CREATE TABLE recipients (
  id                TEXT PRIMARY KEY,
  email_id          TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  recipient_key     TEXT NOT NULL,        -- HMAC(user_secret, lower(address)); computed in extension
  address           TEXT,                 -- NULL unless preferences.store_addresses = 1
  original_field    TEXT NOT NULL CHECK (original_field IN ('to','cc','bcc')),
  pixel_token       TEXT NOT NULL UNIQUE,
  gmail_message_id  TEXT,
  send_status       TEXT NOT NULL DEFAULT 'pending'
                    CHECK (send_status IN ('pending','sending','sent','failed')),
  send_error        TEXT,                 -- short code only, e.g. 'gmail_429'
  sent_at           INTEGER,
  first_open_at     INTEGER,              -- counted classes only
  last_open_at      INTEGER,
  open_count        INTEGER NOT NULL DEFAULT 0,
  click_count       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (email_id, recipient_key)
);
CREATE INDEX idx_recipients_email ON recipients(email_id);
CREATE INDEX idx_recipients_key   ON recipients(recipient_key);
```

## 4. tracked_links (one row per copy × link)
```sql
CREATE TABLE tracked_links (
  id              TEXT PRIMARY KEY,
  email_id        TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  recipient_id    TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  click_token     TEXT NOT NULL UNIQUE,
  link_index      INTEGER NOT NULL,
  target_url      TEXT NOT NULL,          -- required for redirect; http/https only, <= 2048
  click_count     INTEGER NOT NULL DEFAULT 0,
  first_click_at  INTEGER,
  UNIQUE (recipient_id, link_index)
);
CREATE INDEX idx_links_email ON tracked_links(email_id, link_index);
```
Anchor text is not stored on the backend; it is kept locally with the subject.

## 5. tracking_events (append-only)
```sql
CREATE TABLE tracking_events (
  id                  TEXT PRIMARY KEY,   -- ULID; also polling cursor
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id            TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  recipient_id        TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  link_id             TEXT REFERENCES tracked_links(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('open','click','implied_open')),
  classification      TEXT NOT NULL CHECK (classification IN
                       ('human_likely','proxy_open','prefetch_suspected',
                        'scanner_suspected','self_suspected','duplicate')),
  classifier_version  INTEGER NOT NULL,
  counted             INTEGER NOT NULL,   -- 1 if it affected counters
  occurred_at         INTEGER NOT NULL,
  ms_since_send       INTEGER,
  http_method         TEXT,
  ua_family           TEXT,               -- 'GoogleImageProxy','AppleProxy','Chrome','Outlook',…
  ua_truncated        TEXT,               -- <= 128 chars
  ip_hash             TEXT,               -- HMAC with monthly-rotated salt
  country             TEXT,
  asn                 INTEGER
);
CREATE INDEX idx_events_user_cursor ON tracking_events(user_id, id);
CREATE INDEX idx_events_email_time  ON tracking_events(email_id, occurred_at);
CREATE INDEX idx_events_dedupe      ON tracking_events(recipient_id, type, occurred_at);
CREATE INDEX idx_events_time        ON tracking_events(occurred_at);
```

## 6. notification_preferences
```sql
CREATE TABLE notification_preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_open        INTEGER NOT NULL DEFAULT 1,
  notify_click       INTEGER NOT NULL DEFAULT 1,
  notify_first_only  INTEGER NOT NULL DEFAULT 1,
  include_suspected  INTEGER NOT NULL DEFAULT 0,
  quiet_start_min    INTEGER,             -- minutes after local midnight
  quiet_end_min      INTEGER,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  store_subjects     INTEGER NOT NULL DEFAULT 0,
  store_addresses    INTEGER NOT NULL DEFAULT 0,
  disclosure_enabled INTEGER NOT NULL DEFAULT 0,
  disclosure_text    TEXT,                -- <= 200 chars
  updated_at         INTEGER NOT NULL
);
```

## 7. sender_views
```sql
CREATE TABLE sender_views (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gmail_thread_id  TEXT NOT NULL,
  viewed_at        INTEGER NOT NULL
);
CREATE INDEX idx_views_lookup ON sender_views(user_id, gmail_thread_id, viewed_at);
```

## 8. token_daily_caps (log-flood protection)
```sql
CREATE TABLE token_daily_caps (
  token        TEXT NOT NULL,
  day          INTEGER NOT NULL,          -- days since epoch
  hits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token, day)
);
```
Upserted per tracking request. When `hits > 100`, the event row is skipped (the count is still kept). Rows are purged after 2 days.

## Local (extension) storage — `chrome.storage.local`
| Key | Content |
|---|---|
| `user_secret` | 32 random bytes for `recipient_key` HMAC |
| `meta:<email_id>` | `{subject, recipients:[{recipient_id, address, name}], links:[{index, anchor_text}]}` |
| `queue:<email_id>` | Persisted send queue (per-recipient state) |
| `cursor` | Last event ULID polled |
| `session` | Backend session JWT (`chrome.storage.session` preferred; `local` fallback with expiry) |
Capacity: `chrome.storage.local` allows about 10 MB, which is thousands of emails. `unlimitedStorage` is requested only if needed.

## Example records
```json
// tracked_emails (subject not stored)
{"id":"01JD0A…E1","user_id":"01JD09…U1","client_request_id":"6c1b…","subject":null,
 "mode":"individual_group","gmail_thread_id":"192b…","status":"sent","created_at":1793800000000}

// recipients
{"id":"01JD0A…R1","email_id":"01JD0A…E1","recipient_key":"r8xk…","address":null,
 "original_field":"to","pixel_token":"Qm3v0aTf8Lw2kZpX1nB9cA","send_status":"sent",
 "gmail_message_id":"192b…a1","open_count":1,"first_open_at":1793803600000}
{"id":"01JD0A…R2","email_id":"01JD0A…E1","recipient_key":"p02c…","address":null,
 "original_field":"cc","pixel_token":"Zx1…","send_status":"failed","send_error":"gmail_429"}

// tracked_links
{"id":"01JD0A…L1","recipient_id":"01JD0A…R1","click_token":"Kp7…","link_index":0,
 "target_url":"https://example.com/offer","click_count":1}

// tracking_events
{"id":"01JD0D…V1","type":"open","classification":"prefetch_suspected","counted":0,
 "ms_since_send":4200,"ua_family":"Unknown","asn":8075,"classifier_version":1}
{"id":"01JD0D…V2","type":"open","classification":"proxy_open","counted":1,
 "ua_family":"GoogleImageProxy","ms_since_send":3600000,"classifier_version":1}
{"id":"01JD0D…V3","type":"click","classification":"human_likely","counted":1,"link_id":"01JD0A…L1"}

// local meta (extension only)
{"meta:01JD0A…E1":{"subject":"Offer for Q1","recipients":[
  {"recipient_id":"01JD0A…R1","address":"ana@example.com","name":"Ana"}],
  "links":[{"index":0,"anchor_text":"see the offer"}]}}
```

## Counters, consistency, retention
- An event insert plus counter updates run in one `db.batch()`. Counters change only when `counted = 1`.
- Reclassification (for example a late `/v1/views` signal) sets `classification='self_suspected', counted=0` and decrements the counters in the same batch.
- Daily cron: delete events older than 180 days, sender_views older than 24 h, token_daily_caps older than 2 days.
- Size: about 1,000 events/day × about 250 B ≈ 90 MB/year, inside the **≈500 MB per-database** free limit with 180-day retention. Writes are about 3k rows/day, against the ≈100k/day free limit.
