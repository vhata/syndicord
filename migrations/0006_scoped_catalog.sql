ALTER TABLE relay_configuration ADD COLUMN catalog TEXT
  CHECK (catalog IS NULL OR (json_valid(catalog) AND json_type(catalog) = 'object'));
