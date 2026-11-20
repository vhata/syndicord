CREATE TABLE relay_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  feeds TEXT NOT NULL CHECK (json_valid(feeds) AND json_type(feeds) = 'array'),
  updated_at_ms INTEGER NOT NULL
);
