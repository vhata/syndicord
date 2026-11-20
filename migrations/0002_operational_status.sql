ALTER TABLE relay_lease ADD COLUMN last_started_ms INTEGER;
ALTER TABLE relay_lease ADD COLUMN last_completed_ms INTEGER;
ALTER TABLE relay_lease ADD COLUMN last_outcome TEXT
  CHECK (last_outcome IN ('running', 'completed', 'failed'));

CREATE TABLE relay_feed_health (
  feed_url TEXT PRIMARY KEY,
  last_attempt_ms INTEGER NOT NULL,
  last_success_ms INTEGER,
  last_failure_ms INTEGER,
  last_error TEXT CHECK (last_error IN (
    'timeout', 'network', 'http', 'redirect', 'too_large', 'encoding', 'parse_error'
  )),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  entry_count INTEGER CHECK (entry_count >= 0)
) WITHOUT ROWID;
