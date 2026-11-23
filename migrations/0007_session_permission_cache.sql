ALTER TABLE admin_sessions ADD COLUMN permissions_json TEXT;
ALTER TABLE admin_sessions ADD COLUMN permissions_checked_at_ms INTEGER;
