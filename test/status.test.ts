import assert from 'node:assert/strict';
import test from 'node:test';
import { runStatus } from '../scripts/status.ts';
import { loadConfig } from '../src/config.ts';
import { WRITE_CONFIGURATION_SQL } from '../src/config-store.ts';
import { DeliveryLedger, LostLeaseError } from '../src/ledger.ts';
import { runRelay } from '../src/runner.ts';
import {
  STATUS_SQL,
  formatStatus,
  parseStatusSnapshot,
  summarizeStatus,
} from '../src/status.ts';
import { createTestDatabase as emptyTestDatabase } from './helpers/d1.ts';

const routes = [
  {
    url: 'https://example.com/feed.xml?private=feed-token',
    destinations: ['updates'],
  },
];
const config = loadConfig(routes, {
  updates: 'https://discord.com/api/webhooks/123/webhook-token',
});
const emptyRss =
  '<rss version="2.0"><channel><title>News</title></channel></rss>';
const quiet = () => {};

async function createTestDatabase() {
  const database = await emptyTestDatabase();
  await database.db
    .prepare(WRITE_CONFIGURATION_SQL)
    .bind(JSON.stringify(routes))
    .run();
  return database;
}

async function snapshot(db: D1Database, feeds?: typeof routes) {
  if (feeds)
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
  const result = await db.prepare(STATUS_SQL).all<{ snapshot: string }>();
  assert.equal(result.meta.rows_written, 0);
  return parseStatusSnapshot(JSON.parse(result.results[0]!.snapshot));
}

function raw(columns: string[], values: unknown[]) {
  return [{ success: true, results: { columns, rows: [values] } }];
}

function queryDatabase(db: D1Database) {
  return async (queries: { sql: string; params?: string[] }[]) => {
    assert.equal(queries.length, 1);
    const statement = queries[0]!;
    assert.match(statement.sql.trim(), /^(SELECT|WITH)\b/);
    const { results, meta } = await db
      .prepare(statement.sql)
      .bind(...(statement.params ?? []))
      .all<Record<string, unknown>>();
    assert.equal(meta.rows_written, 0);
    const row = results[0]!;
    return raw(Object.keys(row), Object.values(row));
  };
}

test('status distinguishes an unconfigured database from intentional pause', async () => {
  const { db, dispose } = await emptyTestDatabase();
  try {
    const options = { query: queryDatabase(db) };
    const unconfigured = await runStatus(['--local'], {}, options);
    assert.equal(unconfigured.code, 2);
    assert.match(unconfigured.stderr, /configuration is missing/);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    const disabled = await runStatus(['--local', '--json'], {}, options);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout).health, 'disabled');
    await db
      .prepare(WRITE_CONFIGURATION_SQL)
      .bind(
        '[{"url":"https://private.example/feed?token=secret","destinations":[]}]',
      )
      .run();
    const malformed = await runStatus(['--local'], {}, options);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /configuration.*invalid/);
    assert.ok(!malformed.stderr.includes('token=secret'));
  } finally {
    await dispose();
  }
});

test('remote status follows the selected installation and live configuration changes', async () => {
  const first = await createTestDatabase();
  const second = await emptyTestDatabase();
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const other = [
    {
      url: 'https://other.example/feed?token=hidden',
      destinations: ['security'],
    },
  ];
  try {
    await second.db
      .prepare(WRITE_CONFIGURATION_SQL)
      .bind(JSON.stringify(other))
      .run();
    const query = async (
      queries: { sql: string; params?: string[] }[],
      database: string,
      local: boolean,
    ) => {
      assert.equal(local, false);
      assert.ok(database === firstId || database === secondId);
      return queryDatabase(database === firstId ? first.db : second.db)(
        queries,
      );
    };
    const report = async (database: string) => {
      const result = await runStatus(
        ['--remote', '--json'],
        { SYNDICORD_DATABASE_ID: database },
        { query },
      );
      assert.equal(result.stderr, '');
      assert.ok(!result.stdout.includes('token='));
      return JSON.parse(result.stdout);
    };
    assert.equal((await report(firstId)).feeds[0].host, 'example.com');
    assert.equal((await report(secondId)).feeds[0].host, 'other.example');
    await first.db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    assert.equal((await report(firstId)).health, 'disabled');
    assert.equal((await report(secondId)).feeds[0].destinations[0], 'security');
  } finally {
    await first.dispose();
    await second.dispose();
  }
});

test('successful empty polling is healthy; failures preserve success and recovery clears degradation', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    assert.equal(summarizeStatus(await snapshot(db)).health, 'unknown');
    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    const first = await snapshot(db);
    assert.equal(summarizeStatus(first).health, 'healthy');
    assert.equal(first.feeds[0]?.entry_count, 0);
    assert.ok(first.run?.last_completed_ms);

    await runRelay(config, db, {
      fetcher: async () =>
        new Response('secret error response', { status: 503 }),
      log: quiet,
    });
    const failed = await snapshot(db);
    assert.equal(
      failed.feeds[0]?.last_success_ms,
      first.feeds[0]?.last_success_ms,
    );
    assert.equal(failed.feeds[0]?.last_error, 'http');
    assert.equal(failed.feeds[0]?.consecutive_failures, 1);
    assert.equal(failed.run?.last_outcome, 'completed');
    assert.equal(summarizeStatus(failed).health, 'degraded');

    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    const recovered = await snapshot(db);
    assert.equal(recovered.feeds[0]?.consecutive_failures, 0);
    assert.equal(recovered.feeds[0]?.last_error, null);
    assert.ok(recovered.feeds[0]?.last_failure_ms);
    const report = summarizeStatus(recovered);
    assert.equal(report.health, 'healthy');
    assert.ok(!JSON.stringify(report).includes('feed-token'));
    assert.ok(!formatStatus(report, 'remote').includes('feed-token'));
  } finally {
    await dispose();
  }
});

test('failed ingestion and failed runs cannot advance successful feed or run timestamps', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    const first = await snapshot(db);
    await db
      .prepare(
        `CREATE TRIGGER reject_ingest BEFORE INSERT ON relay_routes
      BEGIN SELECT RAISE(ABORT, 'injected database failure'); END`,
      )
      .run();
    const logs: unknown[] = [];
    await assert.rejects(
      runRelay(config, db, {
        fetcher: async () => new Response(emptyRss),
        log: (event) => logs.push(event),
      }),
    );
    const failed = await snapshot(db);
    assert.equal(failed.run?.last_completed_ms, first.run?.last_completed_ms);
    assert.equal(failed.run?.last_outcome, 'failed');
    assert.equal(
      failed.feeds[0]?.last_success_ms,
      first.feeds[0]?.last_success_ms,
    );
    assert.equal(summarizeStatus(failed).health, 'degraded');
    assert.ok(!JSON.stringify(logs).includes('relay_complete'));
  } finally {
    await dispose();
  }
});

test('busy and lost owners cannot advance the completed heartbeat or health', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const ledger = new DeliveryLedger(db);
    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    const first = await snapshot(db);
    await ledger.acquire('held');
    await ledger.syncDestinations('held', {}, routes[0]!.url);
    assert.equal(
      (
        await runRelay(config, db, {
          fetcher: async () => {
            throw new Error('must not fetch');
          },
          log: quiet,
        })
      ).outcome,
      'busy',
    );
    assert.equal(
      (await snapshot(db)).run?.last_completed_ms,
      first.run?.last_completed_ms,
    );
    await db.prepare('UPDATE relay_lease SET expires_at_ms = 0').run();
    await ledger.acquire('successor');
    await assert.rejects(
      ledger.feedFailed('held', routes[0]!.url, 'http'),
      LostLeaseError,
    );
    await assert.rejects(ledger.release('held', true), LostLeaseError);
    const after = await snapshot(db);
    assert.equal(after.run?.last_completed_ms, first.run?.last_completed_ms);
    assert.equal(after.feeds[0]?.consecutive_failures, 0);
    await db.prepare('UPDATE relay_lease SET expires_at_ms = 0').run();
    assert.equal(summarizeStatus(await snapshot(db)).health, 'degraded');
  } finally {
    await dispose();
  }
});

test('migration fields accept old Worker writes without fabricating observations', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    await db
      .prepare(
        "INSERT INTO relay_lease(id, owner, expires_at_ms, cursor) VALUES (1, '', 0, 1)",
      )
      .run();
    const state = await snapshot(db);
    assert.equal(state.run?.last_completed_ms, null);
    assert.equal(state.run?.last_started_ms, null);
    assert.equal(summarizeStatus(state).health, 'unknown');
  } finally {
    await dispose();
  }
});

test('status includes active pending age and destination blocks, excluding removed routes', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const ledger = new DeliveryLedger(db);
    await ledger.acquire('test');
    await ledger.syncDestinations(
      'test',
      { updates: 'a'.repeat(64) },
      routes[0]!.url,
    );
    await ledger.ingest('test', routes[0]!, []);
    const removed = {
      url: 'https://removed.example/feed',
      destinations: ['removed'],
    };
    await ledger.ingest('test', removed, []);
    const entry = {
      id: 'one',
      title: 'Sensitive payload',
      link: null,
      description: '',
      publishedAt: null,
    };
    await ledger.ingest('test', routes[0]!, [entry]);
    await ledger.ingest('test', removed, [entry]);
    await ledger.suspend('test', 'updates');
    await ledger.release('test', true);
    let report = summarizeStatus(await snapshot(db));
    assert.equal(report.health, 'degraded');
    assert.equal(report.pending, 1);
    assert.equal(report.destinations[0]?.state, 'suspended');
    assert.ok(!JSON.stringify(report).includes('Sensitive payload'));
    assert.ok(!JSON.stringify(report).includes('removed'));
    await db.prepare('UPDATE relay_destinations SET suspended = 0').run();
    await db.prepare('UPDATE relay_deliveries SET first_seen_ms = 1').run();
    report = summarizeStatus(await snapshot(db));
    assert.equal(report.health, 'degraded');
    assert.equal(report.feeds[0]?.health, 'degraded');
    const expanded = [{ ...routes[0]!, destinations: ['updates', 'new'] }];
    const added = summarizeStatus(await snapshot(db, expanded));
    assert.equal(added.feeds[0]?.uninitializedDestinations, 1);
    assert.equal(
      added.destinations.find((destination) => destination.name === 'new')
        ?.state,
      'unknown',
    );
  } finally {
    await dispose();
  }
});

test('text status preserves cooldowns beyond the JavaScript date range', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    await db
      .prepare('UPDATE relay_destinations SET cooldown_until_ms = ?')
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    const report = summarizeStatus(await snapshot(db));
    assert.equal(report.health, 'degraded');
    assert.equal(report.destinations[0]?.state, 'cooldown');
    assert.equal(
      report.destinations[0]?.cooldownUntil,
      Number.MAX_SAFE_INTEGER,
    );
    assert.match(
      formatStatus(report, 'remote'),
      /cooldown until beyond the supported date range/,
    );
  } finally {
    await dispose();
  }
});

test('status thresholds account for feed rotation and disabled configuration', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    const state = await snapshot(db);
    state.now_ms += 6 * 60_000;
    assert.equal(summarizeStatus(state).health, 'degraded');
    assert.equal(summarizeStatus(state, 5).health, 'healthy');
    const many = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/${i}`,
      destinations: ['updates'],
    }));
    state.feeds = many.map((route) => ({ ...state.feeds[0]!, url: route.url }));
    state.configuration = many;
    const report = summarizeStatus(state);
    assert.equal(report.feedStaleAfterMs, 30 * 60_000);
    assert.ok(report.feeds.every((feed) => feed.health === 'healthy'));
    assert.equal(summarizeStatus(await snapshot(db, [])).health, 'disabled');
  } finally {
    await dispose();
  }
});

test('CLI requires explicit target and remote database ID before any query', async () => {
  const query = async () => {
    throw new Error('must not query');
  };
  for (const args of [
    [],
    ['--remote', '--local'],
    ['--bad'],
    ['--interval-minutes', 'NaN', '--local'],
  ]) {
    assert.equal((await runStatus(args, {}, { query })).code, 2);
  }
  const missing = await runStatus(['--remote'], {}, { query });
  assert.match(missing.stderr, /SYNDICORD_DATABASE_ID/);
  assert.equal((await runStatus(['--help'], {}, { query })).code, 0);
});

test('CLI reports missing schema and suppresses malformed or sensitive remote failures', async () => {
  const missing = await runStatus(
    ['--local'],
    {},
    {
      query: async () =>
        raw(['run_columns', 'feed_columns', 'config_columns'], [0, 0, 0]),
    },
  );
  assert.match(missing.stderr, /0003_runtime_configuration/);
  for (const query of [
    async () => {
      throw new Error('webhook-token');
    },
    async () => 'webhook-token',
    async () => raw(['snapshot'], ['webhook-token']),
  ]) {
    const result = await runStatus(['--local'], {}, { query });
    assert.equal(result.code, 2);
    assert.ok(!JSON.stringify(result).includes('webhook-token'));
  }
});

test('CLI JSON works with actual local D1 query responses and no webhook configuration', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    await runRelay(config, db, {
      fetcher: async () => new Response(emptyRss),
      log: quiet,
    });
    const result = await runStatus(
      ['--local', '--json'],
      {},
      {
        query: async (queries, database, local) => {
          assert.equal(database, '00000000-0000-4000-8000-000000000001');
          assert.equal(local, true);
          const statement = queries[0]!;
          assert.match(statement.sql.trim(), /^(SELECT|WITH)\b/);
          const { results, meta } = await db
            .prepare(statement.sql)
            .bind(...(statement.params ?? []))
            .all<Record<string, unknown>>();
          assert.equal(meta.rows_written, 0);
          const row = results[0]!;
          return raw(Object.keys(row), Object.values(row));
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.health, 'healthy');
    assert.equal(report.target, 'local');
    assert.ok(!result.stdout.includes('webhook-token'));
    assert.ok(!result.stdout.includes('feed-token'));
  } finally {
    await dispose();
  }
});
