-- Synthetic-only spike table (P6.5). Dropped together with the dev database at cleanup.
CREATE TABLE spike_hits (
  id           TEXT PRIMARY KEY,
  token        TEXT NOT NULL CHECK (token LIKE 'syn-%'),
  method       TEXT NOT NULL,
  received_at  INTEGER NOT NULL,
  written_at   INTEGER NOT NULL
);
CREATE INDEX idx_spike_hits_token ON spike_hits(token);
