import { loadFeeds } from './config.ts';
import type { FeedRoute } from './types.ts';

export const CONFIGURATION_SQL =
  'SELECT feeds FROM relay_configuration WHERE id = 1';

export const WRITE_CONFIGURATION_SQL = `
  INSERT INTO relay_configuration (id, feeds, updated_at_ms)
  VALUES (1, ?, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  ON CONFLICT (id) DO UPDATE SET
    feeds = excluded.feeds, updated_at_ms = excluded.updated_at_ms
`;

export class ConfigurationError extends Error {}

export function parseStoredFeeds(value: unknown): FeedRoute[] {
  if (value === null || value === undefined) {
    throw new ConfigurationError(
      'Feed configuration is missing. Configure feeds in the selected D1 database before polling.',
    );
  }
  try {
    if (typeof value !== 'string') throw new Error();
    return loadFeeds(JSON.parse(value));
  } catch {
    throw new ConfigurationError(
      'Feed configuration in the selected D1 database is invalid.',
    );
  }
}

export async function readFeeds(db: D1Database): Promise<FeedRoute[]> {
  const row = await db.prepare(CONFIGURATION_SQL).first<{ feeds: string }>();
  return parseStoredFeeds(row?.feeds);
}
