import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

export async function createTestDatabase(): Promise<{
  db: D1Database;
  dispose: () => Promise<void>;
}> {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default {};',
      compatibilityDate: '2026-11-18',
      d1Databases: { DB: 'syndicord-test' },
    }),
  );
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database;
    const migration = await readFile(
      new URL('../../migrations/0001_delivery_ledger.sql', import.meta.url),
      'utf8',
    );
    await db.batch(
      migration
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement)),
    );
    return { db, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
