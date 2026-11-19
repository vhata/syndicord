import { readFile, readdir } from 'node:fs/promises';
import { URL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

export async function applyTestMigrations(db: D1Database): Promise<void> {
  const directory = new URL('../../migrations/', import.meta.url);
  for (const filename of (await readdir(directory))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migration = await readFile(new URL(filename, directory), 'utf8');
    await db.batch(
      migration
        .split(';')
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => db.prepare(sql)),
    );
  }
}

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
    await applyTestMigrations(db);
    return { db, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
