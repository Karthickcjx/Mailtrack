-- 0001_init.sql — schema from docs/design/DATABASE_SCHEMA.md rev 2.
-- Privacy defaults: no subjects / readable recipient addresses unless the user opts in (D10, D11).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

CREATE TABLE tracked_emails (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_request_id  TEXT NOT NULL,
  subject            TEXT,
  mode               TEXT NOT NULL CHECK (mode IN ('single','individual_group')),
  gmail_thread_id    TEXT,
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

CREATE TABLE recipients (
  id                TEXT PRIMARY KEY,
  email_id          TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  recipient_key     TEXT NOT NULL,
  address           TEXT,
  original_field    TEXT NOT NULL CHECK (original_field IN ('to','cc','bcc')),
  pixel_token       TEXT NOT NULL UNIQUE,
  gmail_message_id  TEXT,
  send_status       TEXT NOT NULL DEFAULT 'pending'
                    CHECK (send_status IN ('pending','sending','sent','failed')),
  send_error        TEXT,
  sent_at           INTEGER,
  first_open_at     INTEGER,
  last_open_at      INTEGER,
  open_count        INTEGER NOT NULL DEFAULT 0,
  click_count       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (email_id, recipient_key)
);
CREATE INDEX idx_recipients_email ON recipients(email_id);
CREATE INDEX idx_recipients_key   ON recipients(recipient_key);

CREATE TABLE tracked_links (
  id              TEXT PRIMARY KEY,
  email_id        TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  recipient_id    TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  click_token     TEXT NOT NULL UNIQUE,
  link_index      INTEGER NOT NULL,
  target_url      TEXT NOT NULL,
  click_count     INTEGER NOT NULL DEFAULT 0,
  first_click_at  INTEGER,
  UNIQUE (recipient_id, link_index)
);
CREATE INDEX idx_links_email ON tracked_links(email_id, link_index);

CREATE TABLE tracking_events (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id            TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  recipient_id        TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  link_id             TEXT REFERENCES tracked_links(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('open','click','implied_open')),
  classification      TEXT NOT NULL CHECK (classification IN
                       ('human_likely','proxy_open','prefetch_suspected',
                        'scanner_suspected','self_suspected','duplicate')),
  classifier_version  INTEGER NOT NULL,
  counted             INTEGER NOT NULL,
  occurred_at         INTEGER NOT NULL,
  ms_since_send       INTEGER,
  http_method         TEXT,
  ua_family           TEXT,
  ua_truncated        TEXT,
  ip_hash             TEXT,
  country             TEXT,
  asn                 INTEGER
);
CREATE INDEX idx_events_user_cursor ON tracking_events(user_id, id);
CREATE INDEX idx_events_email_time  ON tracking_events(email_id, occurred_at);
CREATE INDEX idx_events_dedupe      ON tracking_events(recipient_id, type, occurred_at);
CREATE INDEX idx_events_time        ON tracking_events(occurred_at);

CREATE TABLE notification_preferences (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notify_open        INTEGER NOT NULL DEFAULT 1,
  notify_click       INTEGER NOT NULL DEFAULT 1,
  notify_first_only  INTEGER NOT NULL DEFAULT 1,
  include_suspected  INTEGER NOT NULL DEFAULT 0,
  quiet_start_min    INTEGER,
  quiet_end_min      INTEGER,
  timezone           TEXT NOT NULL DEFAULT 'UTC',
  store_subjects     INTEGER NOT NULL DEFAULT 0,
  store_addresses    INTEGER NOT NULL DEFAULT 0,
  disclosure_enabled INTEGER NOT NULL DEFAULT 0,
  disclosure_text    TEXT,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE sender_views (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gmail_thread_id  TEXT NOT NULL,
  viewed_at        INTEGER NOT NULL
);
CREATE INDEX idx_views_lookup ON sender_views(user_id, gmail_thread_id, viewed_at);

CREATE TABLE token_daily_caps (
  token  TEXT NOT NULL,
  day    INTEGER NOT NULL,
  hits   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token, day)
);
