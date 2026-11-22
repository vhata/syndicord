import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { DeliveryLedger, LostLeaseError } from '../src/ledger.ts';
import {
  loadConfig,
  MAX_CONFIGURATION_BYTES,
  validateConfigurationSize,
} from '../src/config.ts';
import type { FeedEntry, FeedRoute } from '../src/types.ts';
import { createTestDatabase } from './helpers/d1.ts';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let db: D1Database;
let ledger: DeliveryLedger;
const owner = 'run-a';
const route: FeedRoute = {
  url: 'https://example.com/feed.xml',
  destinations: ['news'],
};
const fingerprint = 'a'.repeat(64);

function entry(id: string, title = id): FeedEntry {
  return {
    id,
    title,
    link: `https://example.com/posts/${id}`,
    description: `Description of ${id}`,
    publishedAt: null,
  };
}

async function start(): Promise<void> {
  assert.equal(await ledger.acquire(owner), 0);
}

async function queue(entries: FeedEntry[] = [entry('one')]): Promise<void> {
  await start();
  await ledger.ingest(owner, route, []);
  await ledger.ingest(owner, route, entries);
}

async function count(table: string): Promise<number> {
  return (await db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<number>('count'))!;
}

async function expire(): Promise<void> {
  await db
    .prepare('UPDATE relay_lease SET expires_at_ms = 0 WHERE id = 1')
    .run();
}

function measuredPendingLedger() {
  const metrics = { rowsRead: Infinity, plan: [] as string[] };
  const measured = new DeliveryLedger({
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async all() {
              const result = await bound.all();
              metrics.rowsRead = result.meta.rows_read;
              metrics.plan = (
                await db
                  .prepare(`EXPLAIN QUERY PLAN ${sql}`)
                  .bind(...values)
                  .all<{ detail: string }>()
              ).results.map((row) => row.detail);
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database);
  return { measured, metrics };
}

test('large fan-out keeps active-route parameters compact and filters removed routes without duplicates', async () => {
  const names = Array.from({ length: 1100 }, (_, index) => `d${index}`);
  const largeRoute = {
    url: 'https://example.com/' + 'x'.repeat(2000),
    destinations: names,
  };
  const webhooks = Object.fromEntries(
    names.map((name, index) => [
      name,
      `https://discord.com/api/webhooks/${index + 1}/token`,
    ]),
  );
  const config = loadConfig([largeRoute], webhooks);
  validateConfigurationSize(config.feeds, config.webhooks);
  const expandedBytes = Buffer.byteLength(
    JSON.stringify(
      names.map((destination) => ({ url: largeRoute.url, destination })),
    ),
  );
  assert.ok(
    expandedBytes > 2 * 1024 * 1024,
    'repeating the URL would exceed D1 string limits',
  );
  await start();
  await ledger.ingest(owner, largeRoute, []);
  await ledger.ingest(owner, largeRoute, [entry('new')]);
  const parameters: unknown[] = [];
  const measured = new DeliveryLedger({
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...values: unknown[]) {
          parameters.push(...values);
          return statement.bind(...values);
        },
      };
    },
  } as unknown as D1Database);
  const pending = await measured.pending(owner, config.feeds, 5);
  assert.equal(pending.length, 5);
  assert.ok(
    parameters
      .filter((value): value is string => typeof value === 'string')
      .every((value) => Buffer.byteLength(value) < MAX_CONFIGURATION_BYTES),
  );
  const remaining = {
    ...largeRoute,
    destinations: [names[1099]!, names[1099]!],
  };
  const selected = await measured.pending(owner, [remaining, remaining], 5);
  assert.deepEqual(
    selected.map((delivery) => delivery.destination),
    [names[1099]],
  );
  assert.deepEqual(await measured.pending(owner, [], 5), []);
  assert.deepEqual(
    await measured.pending('not-the-owner', config.feeds, 5),
    [],
  );
});

test('pending selection reads due deliveries instead of scanning retained history per route', async () => {
  const busyRoute = {
    ...route,
    destinations: Array.from({ length: 50 }, (_, index) => `d${index}`),
  };
  await start();
  await ledger.ingest(
    owner,
    busyRoute,
    Array.from({ length: 200 }, (_, index) => entry(`old${index}`)),
  );
  await ledger.ingest(owner, busyRoute, [entry('new')]);
  assert.equal(await count('relay_deliveries'), 10_050);
  const { measured, metrics } = measuredPendingLedger();
  const pending = await measured.pending(owner, [busyRoute], 5);
  assert.equal(pending.length, 5);
  assert.ok(
    metrics.rowsRead < 1000,
    `read ${metrics.rowsRead} rows despite only 50 pending deliveries`,
  );
  assert.match(
    metrics.plan.join('\n'),
    /SEARCH deliveries USING INDEX relay_pending_due/,
  );
  assert.match(metrics.plan.join('\n'), /SEARCH active USING AUTOMATIC.*INDEX/);
});

test('many feeds sharing a destination use both route keys for active lookup', async () => {
  const routes = Array.from({ length: 1000 }, (_, index) => ({
    url: `https://example.com/feed/${index}`,
    destinations: ['news'],
  }));
  const config = loadConfig(routes, {
    news: 'https://discord.com/api/webhooks/1/token',
  });
  validateConfigurationSize(config.feeds, config.webhooks);
  await start();
  await db.batch([
    db
      .prepare(
        `
      INSERT INTO relay_routes (feed_url, destination, baseline_id, initialized_at_ms)
      SELECT value, 'news', 'baseline', 0 FROM json_each(?)
    `,
      )
      .bind(JSON.stringify(routes.map((feed) => feed.url))),
    db
      .prepare(
        `
      INSERT INTO relay_deliveries
        (feed_url, destination, entry_id, state, payload, attempts, first_seen_ms, next_attempt_ms)
      SELECT feed_url, destination, 'new', 'pending', ?, 0, 0, 0 FROM relay_routes
    `,
      )
      .bind(JSON.stringify(entry('new'))),
  ]);
  const { measured, metrics } = measuredPendingLedger();
  const pending = await measured.pending(owner, routes, 5);
  assert.equal(pending.length, 5);
  assert.deepEqual(
    pending.map((delivery) => delivery.feedUrl),
    routes
      .map((feed) => feed.url)
      .sort()
      .slice(0, 5),
  );
  assert.ok(
    metrics.rowsRead < 15_000,
    `read ${metrics.rowsRead} rows for 1000 active pairs`,
  );
  const activeLookup = metrics.plan.find((step) =>
    step.startsWith('SEARCH active USING AUTOMATIC'),
  );
  assert.ok(activeLookup);
  assert.match(activeLookup, /feed_url=\?/);
  assert.match(activeLookup, /destination=\?/);
});

before(async () => {
  fixture = await createTestDatabase();
  db = fixture.db;
  ledger = new DeliveryLedger(db);
});

beforeEach(async () => {
  await db.batch(
    [
      'relay_deliveries',
      'relay_routes',
      'relay_destinations',
      'relay_feed_health',
      'relay_lease',
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
});

after(async () => {
  await fixture?.dispose();
});

test('lease acquisition is exclusive and cursor survives release and expiry', async () => {
  const owners = ['one', 'two', 'three', 'four'];
  const results = await Promise.all(
    owners.map((candidate) => ledger.acquire(candidate)),
  );
  assert.equal(results.filter((result) => result !== null).length, 1);
  const winner = owners[results.findIndex((result) => result !== null)]!;
  assert.equal(
    results.find((result) => result !== null),
    0,
  );
  assert.equal(await ledger.acquire(winner), null);
  await ledger.release(winner);
  assert.equal(await ledger.acquire('next'), 1);
  await expire();
  assert.equal(await ledger.acquire('takeover'), 2);
});

test('renewal and release require a live lease and the matching owner', async () => {
  await start();
  assert.equal(await ledger.renew('wrong'), false);
  assert.equal(await ledger.renew(owner), true);
  await ledger.release('wrong');
  assert.equal(await ledger.acquire('other'), null);
  await expire();
  assert.equal(await ledger.renew(owner), false);
  await ledger.release(owner);
  assert.equal(
    await db.prepare('SELECT owner FROM relay_lease').first('owner'),
    owner,
  );
});

test('initial entries form a silent baseline for every destination', async () => {
  await start();
  const both = { ...route, destinations: ['news', 'releases'] };
  assert.deepEqual(
    await ledger.ingest(owner, both, [entry('old'), entry('older')]),
    {
      baselined: 2,
      queued: 0,
    },
  );
  assert.equal(await count('relay_routes'), 2);
  assert.equal(await count('relay_deliveries'), 4);
  assert.deepEqual(await ledger.pending(owner, [both], 10), []);
  assert.equal(
    await db
      .prepare(
        'SELECT COUNT(*) AS count FROM relay_deliveries WHERE payload IS NOT NULL',
      )
      .first('count'),
    0,
  );
});

test('a successful empty feed establishes a baseline', async () => {
  await start();
  assert.deepEqual(await ledger.ingest(owner, route, []), {
    baselined: 1,
    queued: 0,
  });
  assert.deepEqual(await ledger.ingest(owner, route, [entry('first')]), {
    baselined: 0,
    queued: 1,
  });
  assert.equal(
    (await ledger.pending(owner, [route], 10))[0]?.entry.id,
    'first',
  );
});

test('new destinations get a baseline independently of existing destinations', async () => {
  await start();
  await ledger.ingest(owner, route, [entry('old')]);
  const both = { ...route, destinations: ['news', 'releases'] };
  assert.deepEqual(
    await ledger.ingest(owner, both, [entry('old'), entry('new')]),
    {
      baselined: 1,
      queued: 1,
    },
  );
  const pending = await ledger.pending(owner, [both], 10);
  assert.deepEqual(
    pending.map(({ destination, entry }) => [destination, entry.id]),
    [['news', 'new']],
  );
  await ledger.ingest(owner, both, [entry('third')]);
  assert.equal((await ledger.pending(owner, [both], 10)).length, 3);
});

test('duplicate IDs and destinations do not distort baseline or queue counts', async () => {
  await start();
  const repeated = { ...route, destinations: ['news', 'news'] };
  assert.deepEqual(
    await ledger.ingest(owner, repeated, [entry('old'), entry('old')]),
    {
      baselined: 1,
      queued: 0,
    },
  );
  assert.deepEqual(
    await ledger.ingest(owner, repeated, [entry('new'), entry('new')]),
    {
      baselined: 0,
      queued: 1,
    },
  );
});

test('identity includes the full feed URL and destination, independently of dates', async () => {
  await start();
  const other = { ...route, url: 'https://other.example/feed.xml' };
  await ledger.ingest(owner, route, []);
  await ledger.ingest(owner, other, []);
  await ledger.ingest(owner, route, [entry('same')]);
  await ledger.ingest(owner, other, [entry('same')]);
  const pending = await ledger.pending(owner, [route, other], 10);
  assert.equal(pending.length, 2);
  assert.deepEqual(
    new Set(pending.map((delivery) => delivery.feedUrl)),
    new Set([route.url, other.url]),
  );
  assert.ok(pending.every((delivery) => delivery.entry.publishedAt === null));
});

test('an existing ID keeps its queued payload and a sent ID stays deduplicated', async () => {
  await queue([entry('same', 'Original title')]);
  await ledger.ingest(owner, route, [entry('same', 'Edited title')]);
  const pending = await ledger.pending(owner, [route], 10);
  assert.equal(pending[0]?.entry.title, 'Original title');
  assert.equal(await ledger.ack(owner, pending[0]!), true);
  assert.equal(await ledger.ack(owner, pending[0]!), false);
  await ledger.ingest(owner, route, [entry('same', 'Another edit')]);
  assert.deepEqual(await ledger.pending(owner, [route], 10), []);
  assert.equal(await count('relay_deliveries'), 1);
  assert.equal(
    await db.prepare('SELECT payload FROM relay_deliveries').first('payload'),
    null,
  );
});

test('pending payload survives source disappearance and inactive routes can resume', async () => {
  await queue();
  await ledger.ingest(owner, route, []);
  assert.deepEqual(await ledger.pending(owner, [], 10), []);
  assert.deepEqual(
    await ledger.pending(owner, [{ ...route, destinations: ['other'] }], 10),
    [],
  );
  const pending = await ledger.pending(owner, [route], 10);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0]?.entry, entry('one'));
});

test('delivery selection is stable and bounded', async () => {
  await queue([entry('c'), entry('a'), entry('b')]);
  assert.deepEqual(
    (await ledger.pending(owner, [route], 2)).map(({ entry }) => entry.id),
    ['a', 'b'],
  );
  assert.deepEqual(await ledger.pending(owner, [route], 0), []);
  await assert.rejects(ledger.pending(owner, [route], 101), RangeError);
});

test('retry defers only its delivery, increments attempts, and preserves payload', async () => {
  await queue([entry('a'), entry('b')]);
  const [first] = await ledger.pending(owner, [route], 10);
  assert.equal(await ledger.retry(owner, first!, 60_000, 'http_error'), true);
  assert.deepEqual(
    (await ledger.pending(owner, [route], 10)).map(({ entry }) => entry.id),
    ['b'],
  );
  await db.prepare('UPDATE relay_deliveries SET next_attempt_ms = 0').run();
  const retried = (await ledger.pending(owner, [route], 10))[0]!;
  assert.equal(retried.attempts, 1);
  assert.deepEqual(retried.entry, entry('a'));
  assert.equal(await ledger.ack(owner, retried), true);
  assert.equal(await ledger.retry(owner, retried, 1000, 'http_error'), false);
});

test('destination cooldown does not affect other destinations and cannot shorten', async () => {
  await start();
  const both = { ...route, destinations: ['news', 'other'] };
  await ledger.ingest(owner, both, []);
  await ledger.ingest(owner, both, [entry('one')]);
  assert.equal(await ledger.cooldown(owner, 'news', 60_000), true);
  const first = await db
    .prepare(
      'SELECT cooldown_until_ms FROM relay_destinations WHERE destination = ?',
    )
    .bind('news')
    .first<number>('cooldown_until_ms');
  await ledger.cooldown(owner, 'news', 1000);
  assert.equal(
    await db
      .prepare(
        'SELECT cooldown_until_ms FROM relay_destinations WHERE destination = ?',
      )
      .bind('news')
      .first('cooldown_until_ms'),
    first,
  );
  assert.deepEqual(
    (await ledger.pending(owner, [both], 10)).map(
      ({ destination }) => destination,
    ),
    ['other'],
  );
});

test('global cooldown blocks every destination until it expires', async () => {
  await queue();
  await ledger.cooldown(owner, '*', 60_000);
  assert.deepEqual(await ledger.pending(owner, [route], 10), []);
  await db
    .prepare(
      "UPDATE relay_destinations SET cooldown_until_ms = 0 WHERE destination = '*'",
    )
    .run();
  assert.equal((await ledger.pending(owner, [route], 10)).length, 1);
});

test('suspension persists with the same secret and rotation resumes pending delivery', async () => {
  await queue();
  await ledger.syncDestinations(owner, { news: fingerprint });
  assert.equal(await ledger.suspend(owner, 'news'), true);
  await ledger.cooldown(owner, 'news', 60_000);
  await ledger.syncDestinations(owner, { news: fingerprint });
  assert.deepEqual(await ledger.pending(owner, [route], 10), []);
  await ledger.syncDestinations(owner, { news: 'b'.repeat(64) });
  assert.equal((await ledger.pending(owner, [route], 10)).length, 1);
  const state = await db
    .prepare(
      'SELECT fingerprint, suspended, cooldown_until_ms FROM relay_destinations',
    )
    .first();
  assert.deepEqual(state, {
    fingerprint: 'b'.repeat(64),
    suspended: 0,
    cooldown_until_ms: 0,
  });
});

test('secret synchronization leaves global cooldown intact and accepts empty configuration', async () => {
  await queue();
  await ledger.cooldown(owner, '*', 60_000);
  await ledger.syncDestinations(owner, { news: fingerprint });
  await ledger.syncDestinations(owner, {});
  assert.deepEqual(await ledger.pending(owner, [route], 10), []);
  await assert.rejects(
    ledger.syncDestinations(owner, { news: 'https://secret.example/token' }),
    TypeError,
  );
  await assert.rejects(
    ledger.syncDestinations(owner, { '*': fingerprint }),
    TypeError,
  );
});

test('expired owners cannot mutate, read pending, or release a successor lease', async () => {
  await queue();
  const [delivery] = await ledger.pending(owner, [route], 10);
  await expire();
  assert.equal(await ledger.acquire('successor'), 1);
  assert.equal(await ledger.renew(owner), false);
  assert.equal(await ledger.ack(owner, delivery!), false);
  assert.equal(
    await ledger.retry(owner, delivery!, 1000, 'network_error'),
    false,
  );
  assert.equal(await ledger.cooldown(owner, 'news', 1000), false);
  assert.equal(await ledger.suspend(owner, 'news'), false);
  await assert.rejects(
    ledger.syncDestinations(owner, { news: fingerprint }),
    LostLeaseError,
  );
  await assert.rejects(
    ledger.ingest(owner, { ...route, destinations: ['new'] }, [entry('stale')]),
    LostLeaseError,
  );
  await ledger.release(owner);
  assert.equal(
    await db.prepare('SELECT owner FROM relay_lease').first('owner'),
    'successor',
  );
  assert.deepEqual(await ledger.pending(owner, [route], 10), []);
  const pending = await ledger.pending('successor', [route], 10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.attempts, 0);
  assert.equal(await count('relay_routes'), 1);
  assert.equal(await count('relay_destinations'), 0);
});

test('baseline and entries roll back together when a statement fails', async () => {
  await start();
  await db
    .prepare(
      `
    CREATE TRIGGER reject_entry BEFORE INSERT ON relay_deliveries
    WHEN NEW.entry_id = 'broken'
    BEGIN SELECT RAISE(ABORT, 'injected write failure'); END
  `,
    )
    .run();
  try {
    await assert.rejects(
      ledger.ingest(owner, route, [entry('good'), entry('broken')]),
    );
    assert.equal(await count('relay_routes'), 0);
    assert.equal(await count('relay_deliveries'), 0);
  } finally {
    await db.prepare('DROP TRIGGER reject_entry').run();
  }
  assert.deepEqual(await ledger.ingest(owner, route, [entry('good')]), {
    baselined: 1,
    queued: 0,
  });
  assert.deepEqual(await ledger.pending(owner, [route], 10), []);
});

test('ingest renews a still-valid lease before atomic writes', async () => {
  await start();
  await db
    .prepare(
      "UPDATE relay_lease SET expires_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10_000",
    )
    .run();
  await ledger.ingest(owner, route, []);
  const remaining = await db
    .prepare(
      "SELECT expires_at_ms - CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS remaining FROM relay_lease",
    )
    .first<number>('remaining');
  assert.ok(remaining! > 100_000);
});
