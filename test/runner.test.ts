import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { runRelay } from '../src/runner.ts';
import { DeliveryLedger } from '../src/ledger.ts';
import type { RelayEvent } from '../src/runner.ts';
import type { Fetcher } from '../src/types.ts';
import { createTestDatabase } from './helpers/d1.ts';

const feed = 'https://feeds.example/news';
const hookA = 'https://discord.com/api/webhooks/123/token-a';
const hookB = 'https://discord.com/api/webhooks/456/token-b';
const config = loadConfig([{ url: feed, destinations: ['alpha', 'beta'] }], {
  alpha: hookA,
  beta: hookB,
});
const rss = (ids: string[]) =>
  `<rss version="2.0"><channel><title>News</title>${ids.map((id) => `<item><guid isPermaLink="false">${id}</guid><title>${id}</title><link>https://example.com/${id}</link></item>`).join('')}</channel></rss>`;
const quiet = () => {};

test('more than twenty feeds rotate fully and preserve baselines and bounded delivery', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const expanded = loadConfig(
      Array.from({ length: 30 }, (_, index) => ({
        url: `${feed}/${index}`,
        destinations: ['alpha'],
      })),
      { alpha: hookA },
    );
    const seen: string[] = [];
    let ids = ['old'];
    let sends = 0;
    const fetcher: Fetcher = async (url) => {
      if (url.startsWith(feed)) {
        seen.push(url);
        return new Response(rss(ids));
      }
      sends++;
      return Response.json({ id: '123456' });
    };
    for (let index = 0; index < expanded.feeds.length; index++) {
      const result = await runRelay(expanded, db, { fetcher, log: quiet });
      assert.equal(result.baselined, 1);
      assert.equal(result.sent, 0);
    }
    assert.deepEqual(
      seen,
      expanded.feeds.map((route) => route.url),
    );
    ids = ['old', 'new'];
    for (let index = 0; index < expanded.feeds.length; index++) {
      const result = await runRelay(expanded, db, { fetcher, log: quiet });
      assert.equal(result.queued, 1);
      assert.equal(result.sent, 1);
    }
    assert.equal(sends, 30);
    assert.deepEqual(seen.slice(30), seen.slice(0, 30));
    assert.equal(
      (await runRelay(expanded, db, { fetcher, log: quiet })).sent,
      0,
    );
  } finally {
    await dispose();
  }
});

test('end-to-end baselines then delivers new entries once to each destination', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    let ids = ['old'];
    const posts: string[] = [];
    const fetcher: Fetcher = async (url, init) => {
      if (url === feed) return new Response(rss(ids));
      posts.push(url);
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      assert.equal(body.embeds[0].author.name, 'News');
      return Response.json({ id: '123456' });
    };
    assert.equal(
      (await runRelay(config, db, { fetcher, log: quiet })).baselined,
      2,
    );
    assert.equal(posts.length, 0);
    ids = ['old', 'new'];
    const result = await runRelay(config, db, { fetcher, log: quiet });
    assert.equal(result.queued, 2);
    assert.equal(result.sent, 2);
    assert.ok(
      posts.every((url) => new URL(url).searchParams.get('wait') === 'true'),
    );
    await runRelay(config, db, { fetcher, log: quiet });
    assert.equal(posts.length, 2);
  } finally {
    await dispose();
  }
});

test('failed destination retries persisted content after source disappears without resending successes', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    let ids: string[] = [];
    let fail = true;
    let sourceFails = false;
    const delivered: string[] = [];
    const logs: RelayEvent[] = [];
    const fetcher: Fetcher = async (url, init) => {
      if (url === feed)
        return sourceFails
          ? new Response('private', { status: 500 })
          : new Response(rss(ids));
      assert.equal(
        JSON.parse(String(init?.body)).embeds[0].author.name,
        'News',
      );
      assert.equal(
        JSON.parse(String(init?.body)).embeds[0].url,
        'https://example.com/new',
      );
      if (url.startsWith(hookA) && fail) throw new Error(`sensitive ${hookA}`);
      delivered.push(url);
      return Response.json({ id: '123456' });
    };
    await runRelay(config, db, { fetcher, log: (event) => logs.push(event) });
    ids = ['new'];
    const result = await runRelay(config, db, {
      fetcher,
      log: (event) => logs.push(event),
    });
    assert.equal(result.sent, 1);
    assert.equal(result.deferred, 1);
    fail = false;
    sourceFails = true;
    ids = [];
    await db
      .prepare(
        "UPDATE relay_deliveries SET next_attempt_ms=0 WHERE state='pending'",
      )
      .run();
    assert.equal((await runRelay(config, db, { fetcher, log: quiet })).sent, 1);
    assert.equal(delivered.filter((url) => url.startsWith(hookB)).length, 1);
    assert.ok(!JSON.stringify(logs).includes('token-a'));
  } finally {
    await dispose();
  }
});

test('delivers pending payloads created before feed names were recorded', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    let ids: string[] = [];
    const unavailable: Fetcher = async (url) =>
      url === feed
        ? new Response(rss(ids))
        : new Response(null, { status: 503 });
    await runRelay(config, db, { fetcher: unavailable, log: quiet });
    ids = ['new'];
    assert.equal(
      (await runRelay(config, db, { fetcher: unavailable, log: quiet }))
        .deferred,
      2,
    );
    await db
      .prepare(
        "UPDATE relay_deliveries SET payload=json_remove(payload, '$.feedTitle'), next_attempt_ms=0 WHERE state='pending'",
      )
      .run();
    const fetcher: Fetcher = async (url, init) => {
      if (url === feed) return new Response(null, { status: 500 });
      const body = JSON.parse(String(init?.body));
      assert.equal(body.embeds[0].author.name, 'feeds.example');
      assert.equal(body.embeds[0].title, 'new');
      return Response.json({ id: '123456' });
    };
    assert.equal((await runRelay(config, db, { fetcher, log: quiet })).sent, 2);
  } finally {
    await dispose();
  }
});

test('paragraph formatting does not resend an existing fingerprinted baseline', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const ledger = new DeliveryLedger(db);
    await ledger.acquire('old-version');
    await ledger.ingest('old-version', config.feeds[0]!, [
      {
        id: 'sha256:8f51e54af06de5d77219ab8b79faa97a96ca1a0c75c4a302bb9b409589f89deb',
        title: 'Untitled',
        description: 'one two',
        link: null,
        publishedAt: null,
      },
    ]);
    await ledger.release('old-version');
    const fetcher: Fetcher = async (url) => {
      assert.equal(url, feed, 'An existing entry must not be posted again');
      return new Response(
        '<rss version="2.0"><channel><title>News</title><item><description><![CDATA[<p>one</p><p>two</p>]]></description></item></channel></rss>',
      );
    };
    const result = await runRelay(config, db, { fetcher, log: quiet });
    assert.equal(result.queued, 0);
    assert.equal(result.sent, 0);
  } finally {
    await dispose();
  }
});

test('pending entries without link provenance use the source origin and retain their identities', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const ledger = new DeliveryLedger(db);
    const legacyConfig = loadConfig([{ url: feed, destinations: ['alpha'] }], {
      alpha: hookA,
    });
    const links = [
      'https://feeds.example/private-path-token/feed?token=private-query-token#post',
      'https://redirected.test/private%2Dpath-token/post',
      'https://example.test/public-post',
    ];
    await ledger.acquire('old-version');
    await ledger.ingest('old-version', legacyConfig.feeds[0]!, []);
    await ledger.ingest(
      'old-version',
      legacyConfig.feeds[0]!,
      links.map((link) => ({
        id: `link:${link}`,
        title: 'Pending post',
        link,
        description: 'Still waiting to be delivered.',
        publishedAt: null,
      })),
    );
    await ledger.release('old-version');
    let posts = 0;
    const fetcher: Fetcher = async (url, init) => {
      if (url === feed) return new Response(null, { status: 500 });
      const body = String(init?.body);
      assert.doesNotMatch(body, /private(?:%2D|-)(?:path|query)-token/);
      assert.equal(JSON.parse(body).embeds[0].url, 'https://feeds.example/');
      posts += 1;
      return Response.json({ id: '123456' });
    };
    assert.equal(
      (await runRelay(legacyConfig, db, { fetcher, log: quiet })).sent,
      3,
    );
    assert.equal(posts, 3);
    const delivered = await db
      .prepare(
        "SELECT DISTINCT entry_id FROM relay_deliveries WHERE state='sent' ORDER BY entry_id",
      )
      .all<{ entry_id: string }>();
    assert.deepEqual(
      delivered.results.map((row) => row.entry_id),
      links.map((link) => `link:${link}`).sort(),
    );
    assert.equal(
      (await runRelay(legacyConfig, db, { fetcher, log: quiet })).sent,
      0,
    );
    assert.equal(posts, 3);
  } finally {
    await dispose();
  }
});

test('invalid webhooks are suspended until replacement and global rate limits block other destinations', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    let ids: string[] = [];
    let mode: 'invalid' | 'global' | 'ok' = 'invalid';
    const posts: string[] = [];
    const fetcher: Fetcher = async (url) => {
      if (url === feed) return new Response(rss(ids));
      posts.push(url);
      if (url.startsWith(hookA) && mode === 'invalid')
        return new Response(null, { status: 404 });
      if (mode === 'global')
        return Response.json(
          { retry_after: 120, global: true },
          { status: 429 },
        );
      return Response.json({ id: '123456' });
    };
    await runRelay(config, db, { fetcher, log: quiet });
    ids = ['one', 'two'];
    await runRelay(config, db, { fetcher, log: quiet });
    assert.equal(posts.filter((url) => url.startsWith(hookA)).length, 1);
    await db
      .prepare(
        "UPDATE relay_deliveries SET next_attempt_ms=0 WHERE state='pending'",
      )
      .run();
    posts.length = 0;
    await runRelay(config, db, { fetcher, log: quiet });
    assert.equal(posts.length, 0);
    const changed = loadConfig(config.feeds, {
      alpha: `${hookA}replacement`,
      beta: hookB,
    });
    mode = 'global';
    await runRelay(changed, db, { fetcher, log: quiet });
    assert.equal(posts.length, 1);
    mode = 'ok';
    posts.length = 0;
    await runRelay(changed, db, { fetcher, log: quiet });
    assert.equal(posts.length, 0);
  } finally {
    await dispose();
  }
});

test('overlapping runs skip and expired owners cannot acknowledge a send', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const empty: Fetcher = async () => new Response(rss([]));
    await runRelay(config, db, { fetcher: empty, log: quiet });
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runRelay(config, db, {
      owner: 'first',
      log: quiet,
      fetcher: async (url) => {
        if (url === feed) {
          started();
          await pause;
          return new Response(rss(['new']));
        }
        await db.prepare("UPDATE relay_lease SET owner='successor'").run();
        return Response.json({ id: '123456' });
      },
    });
    await began;
    assert.equal(
      (await runRelay(config, db, { fetcher: empty, log: quiet })).outcome,
      'busy',
    );
    release();
    assert.equal((await first).outcome, 'lost_lease');
    assert.equal(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM relay_deliveries WHERE state='pending'",
        )
        .first('n'),
      2,
    );
    assert.equal(
      await db.prepare('SELECT owner FROM relay_lease').first('owner'),
      'successor',
    );
  } finally {
    await dispose();
  }
});

test('feed rotation survives failures, invalid first polls do not baseline, and delivery work is capped', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const two = loadConfig(
      [
        { url: feed, destinations: ['alpha'] },
        { url: `${feed}/second`, destinations: ['alpha'] },
      ],
      { alpha: hookA },
    );
    const seen: string[] = [];
    let ids: string[] = [];
    let malformed = true;
    const fetcher: Fetcher = async (url) => {
      if (url.startsWith(feed)) {
        seen.push(url);
        return new Response(malformed && url === feed ? '<rss>' : rss(ids));
      }
      return Response.json({ id: '123456' });
    };
    await runRelay(two, db, { fetcher, log: quiet });
    await runRelay(two, db, { fetcher, log: quiet });
    assert.deepEqual(seen, [feed, `${feed}/second`]);
    assert.equal(
      await db.prepare('SELECT COUNT(*) AS n FROM relay_routes').first('n'),
      1,
    );
    malformed = false;
    await runRelay(two, db, { fetcher, log: quiet });
    ids = Array.from({ length: 8 }, (_, index) => `entry${index}`);
    assert.equal((await runRelay(two, db, { fetcher, log: quiet })).sent, 5);
    assert.equal(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM relay_deliveries WHERE state='pending'",
        )
        .first('n'),
      3,
    );
  } finally {
    await dispose();
  }
});
