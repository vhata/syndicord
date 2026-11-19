CREATE TABLE relay_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 0)
);

CREATE TABLE relay_routes (
  feed_url TEXT NOT NULL,
  destination TEXT NOT NULL,
  baseline_id TEXT NOT NULL,
  initialized_at_ms INTEGER NOT NULL,
  PRIMARY KEY (feed_url, destination)
) WITHOUT ROWID;

CREATE TABLE relay_deliveries (
  feed_url TEXT NOT NULL,
  destination TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('baseline', 'pending', 'sent')),
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_seen_ms INTEGER NOT NULL,
  next_attempt_ms INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (feed_url, destination, entry_id),
  FOREIGN KEY (feed_url, destination)
    REFERENCES relay_routes (feed_url, destination),
  CHECK ((state = 'pending') = (payload IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX relay_pending_due
  ON relay_deliveries (next_attempt_ms, first_seen_ms)
  WHERE state = 'pending';

CREATE TABLE relay_destinations (
  destination TEXT PRIMARY KEY,
  fingerprint TEXT,
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  cooldown_until_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
