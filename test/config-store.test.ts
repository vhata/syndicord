import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { loadFeeds } from '../src/config.ts';
import { DeliveryLedger } from '../src/ledger.ts';
import worker from '../src/index.ts';
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

test('stored URLs must already use the same normalized identity as polling and status', () => {
  const input = [{ url: 'https://EXAMPLE.com', destinations: ['updates'] }];
  assert.throws(
    () => parseStoredFeeds(JSON.stringify(input)),
    /Save it again with syndicord feeds set/,
  );
  const normalized = loadFeeds(input);
  assert.equal(normalized[0]?.url, 'https://example.com/');
  assert.deepEqual(parseStoredFeeds(JSON.stringify(normalized)), normalized);
});

test('configuration migration and bootstrap preserve existing baselines, sent history, and pending delivery', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    await db.prepare('DROP TABLE relay_configuration').run();
    const ledger = new DeliveryLedger(db);
    await ledger.acquire('before');
    const entries = ['old', 'sent', 'pending'].map((id) => ({
      id,
      title: id,
      link: null,
      description: '',
      publishedAt: null,
    }));
    await ledger.ingest('before', feeds[0]!, [entries[0]!]);
    await ledger.ingest('before', feeds[0]!, entries);
    const pending = await ledger.pending('before', feeds, 5);
    await ledger.ack(
      'before',
      pending.find((delivery) => delivery.entry.id === 'sent')!,
    );
    await ledger.release('before', true);
    const rows = async () => ({
      routes: (
        await db
          .prepare('SELECT * FROM relay_routes ORDER BY feed_url, destination')
          .all()
      ).results,
      deliveries: (
        await db
          .prepare(
            'SELECT * FROM relay_deliveries ORDER BY feed_url, destination, entry_id',
          )
          .all()
      ).results,
    });
    const before = await rows();
    const migration = await readFile(
      new URL('../migrations/0003_runtime_configuration.sql', import.meta.url),
      'utf8',
    );
    await db.prepare(migration).run();
    await assert.rejects(readFeeds(db), /configuration is missing/);
    await db
      .prepare(WRITE_CONFIGURATION_SQL)
      .bind(JSON.stringify(loadFeeds(feeds)))
      .run();
    assert.deepEqual(await rows(), before);
    await ledger.acquire('after');
    assert.deepEqual(
      await ledger.ingest('after', (await readFeeds(db))[0]!, entries),
      { baselined: 0, queued: 0 },
    );
    assert.deepEqual(
      (await ledger.pending('after', await readFeeds(db), 5)).map(
        (delivery) => delivery.entry.id,
      ),
      ['pending'],
    );
    await ledger.release('after', true);
    assert.deepEqual(await rows(), before);
  } finally {
    await dispose();
  }
});

test('scheduled handlers fail explicitly before polling when configuration is missing or invalid', async () => {
  const { db, dispose } = await createTestDatabase();
  const logs: unknown[] = [];
  const original = console.error;
  console.error = (...values) => logs.push(...values);
  try {
    for (const stored of [
      null,
      '[{"url":"https://private.example/?secret=hidden","destinations":[]}]',
      '[{"url":"https://EXAMPLE.com","destinations":["updates"]}]',
    ]) {
      if (stored !== null)
        await db.prepare(WRITE_CONFIGURATION_SQL).bind(stored).run();
      let completion: Promise<unknown> | undefined;
      worker.scheduled({} as ScheduledController, { DB: db }, {
        waitUntil: (promise: Promise<unknown>) => {
          completion = promise;
        },
      } as ExecutionContext);
      assert.ok(completion);
      await assert.rejects(completion, /Scheduled relay failed/);
      assert.equal(
        (
          await db
            .prepare('SELECT COUNT(*) AS count FROM relay_lease')
            .first<{ count: number }>()
        )?.count,
        0,
      );
    }
    assert.match(JSON.stringify(logs), /configuration is missing/);
    assert.match(JSON.stringify(logs), /configuration.*invalid/);
    assert.ok(!JSON.stringify(logs).includes('secret=hidden'));
  } finally {
    console.error = original;
    await dispose();
  }
});
