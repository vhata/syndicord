import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFIGURATION_SQL,
  WRITE_CONFIGURATION_SQL,
  parseStoredFeeds,
  readFeeds,
} from '../src/config-store.ts';
import { createTestDatabase } from './helpers/d1.ts';

const feeds = [{ url: 'https://example.com/feed', destinations: ['updates'] }];

test('D1 configuration is explicit and an empty list deliberately disables polling', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    assert.equal(await db.prepare(CONFIGURATION_SQL).first(), null);
    await assert.rejects(readFeeds(db), /configuration is missing/);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    assert.deepEqual(await readFeeds(db), feeds);
    const first = await db
      .prepare('SELECT updated_at_ms FROM relay_configuration')
      .first<{ updated_at_ms: number }>();
    assert.ok(first!.updated_at_ms > 0);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    assert.deepEqual(await readFeeds(db), []);
    assert.equal(
      (
        await db
          .prepare('SELECT COUNT(*) AS count FROM relay_configuration')
          .first<{ count: number }>()
      )?.count,
      1,
    );
  } finally {
    await dispose();
  }
});

test('stored configuration is validated and errors never echo private feed URLs', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const invalid = [
      {
        url: 'https://example.com/private?secret=feed-token',
        destinations: [],
      },
    ];
    await db
      .prepare(WRITE_CONFIGURATION_SQL)
      .bind(JSON.stringify(invalid))
      .run();
    await assert.rejects(
      readFeeds(db),
      (error: unknown) =>
        error instanceof Error &&
        /configuration.*invalid/.test(error.message) &&
        !error.message.includes('feed-token'),
    );
    for (const value of [
      'not-json-private-secret',
      '{}',
      123,
      JSON.stringify(invalid),
    ]) {
      assert.throws(() => parseStoredFeeds(value), /configuration.*invalid/);
    }
    for (const value of [null, undefined])
      assert.throws(() => parseStoredFeeds(value), /configuration is missing/);
  } finally {
    await dispose();
  }
});

test('installations keep independent configuration and replacement preserves the delivery ledger', async () => {
  const first = await createTestDatabase();
  const second = await createTestDatabase();
  try {
    await first.db
      .prepare(WRITE_CONFIGURATION_SQL)
      .bind(JSON.stringify(feeds))
      .run();
    await second.db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    await first.db
      .prepare(
        "INSERT INTO relay_routes(feed_url, destination, baseline_id, initialized_at_ms) VALUES (?, 'updates', 'existing-baseline', 1)",
      )
      .bind(feeds[0]!.url)
      .run();
    await first.db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    await first.db
      .prepare(WRITE_CONFIGURATION_SQL)
      .bind(JSON.stringify(feeds))
      .run();
    assert.deepEqual(await readFeeds(first.db), feeds);
    assert.deepEqual(await readFeeds(second.db), []);
    assert.equal(
      (
        await first.db
          .prepare('SELECT baseline_id FROM relay_routes')
          .first<{ baseline_id: string }>()
      )?.baseline_id,
      'existing-baseline',
    );
  } finally {
    await first.dispose();
    await second.dispose();
  }
});
