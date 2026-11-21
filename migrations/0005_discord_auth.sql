CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'cli')),
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  retry_at_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at_ms);

CREATE TABLE admin_oauth_requests (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  cli_request_id TEXT,
  expires_at_ms INTEGER NOT NULL,
  config_hash TEXT NOT NULL
);
CREATE INDEX admin_oauth_requests_expiry ON admin_oauth_requests(expires_at_ms);

CREATE TABLE admin_cli_requests (
  request_id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  user_code TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  poll_after_ms INTEGER NOT NULL DEFAULT 0,
  config_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  session_hash TEXT,
  approval_hash TEXT,
  approval_session_hash TEXT
);
CREATE INDEX admin_cli_requests_expiry ON admin_cli_requests(expires_at_ms);
