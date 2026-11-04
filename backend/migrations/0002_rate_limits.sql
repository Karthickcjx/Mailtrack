-- 0002_rate_limits.sql — fixed-window API rate limiting stored in D1.
-- Used because the Workers Rate Limiting binding's availability on the Free plan is unverified (VERIFIED W-i).
CREATE TABLE api_rate_limits (
  key     TEXT NOT NULL,      -- e.g. 'ip:<hmac>' or 'user:<id>:register'
  window  INTEGER NOT NULL,   -- window start (ms since epoch, aligned)
  hits    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window)
);
CREATE INDEX idx_rate_window ON api_rate_limits(window);
