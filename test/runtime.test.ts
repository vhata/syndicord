import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { WRITE_CONFIGURATION_SQL } from '../src/config-store.ts';

const feeds = [
  { url: 'https://first.example/feed', destinations: ['updates'] },
];
import { applyTestMigrations } from './helpers/d1.ts';

test('the cf-built Worker handles scheduled events with local D1 and mocked outbound HTTP', async () => {
  const names = [...new Set(feeds.flatMap((feed) => feed.destinations))];
  const webhooks = Object.fromEntries(
    names.map((name, index) => [
      name,
      `https://discord.com/api/webhooks/${1000 + index}/test-token`,
    ]),
  );
  webhooks.other = 'https://discord.com/api/webhooks/2000/other-token';
  const next = [
    { url: 'https://second.example/feed', destinations: ['other'] },
  ];
  const feedUrls = new Set([...feeds, ...next].map((feed) => feed.url));
  const polled: string[] = [];
  let newest = false;
  const expected = feeds.reduce(
    (total, feed) => total + feed.destinations.length,
    0,
  );
  let updated = false;
  const sent: unknown[] = [];
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(
        new URL(
          '../.cloudflare/output/v1/workers/default/bundle/index.js',
          import.meta.url,
        ),
      ),
      compatibilityDate: '2026-11-18',
      cf: false,
      unsafeTriggerHandlers: true,
      d1Databases: { DB: 'syndicord-worker-test' },
      bindings: { WEBHOOKS: JSON.stringify(webhooks) },
      outboundService: async (request) => {
        if (feedUrls.has(request.url)) {
          polled.push(request.url);
          return new Response(
            `<rss version="2.0"><channel><title>Test</title><item><guid>old</guid><title>Old</title></item>${updated ? '<item><guid>new</guid><title>New</title></item>' : ''}${newest ? '<item><guid>newest</guid><title>Newest</title></item>' : ''}</channel></rss>`,
          );
        }
        assert.ok(
          Object.values(webhooks).some((url) =>
            request.url.startsWith(`${url}?wait=true`),
          ),
          'Unexpected outbound request',
        );
        sent.push(await request.json());
        return Response.json({ id: '123456' });
      },
    }),
  );
  try {
    const db = await runtime.getD1Database('DB');
    await applyTestMigrations(db as unknown as D1Database);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    const trigger = async () => {
      const response = await runtime.dispatchFetch(
        'http://localhost/cdn-cgi/local/scheduled',
      );
      assert.equal(response.status, 200, await response.text());
    };
    const response = await runtime.dispatchFetch('http://localhost/check');
    assert.equal(response.status, 404);
    for (const _feed of feeds) await trigger();
    assert.equal(sent.length, 0);
    updated = true;
    for (let run = 0; run < feeds.length + expected; run++) await trigger();
    assert.equal(sent.length, expected);
    for (const _feed of feeds) await trigger();
    assert.equal(sent.length, expected);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(next)).run();
    await trigger();
    assert.equal(polled.at(-1), next[0]!.url);
    assert.equal(
      sent.length,
      expected,
      'a newly configured route gets a silent baseline',
    );
    newest = true;
    await trigger();
    assert.equal(
      sent.length,
      expected + 1,
      'new configuration applies without rebuilding the Worker',
    );
    await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    const pollCount = polled.length;
    await trigger();
    assert.equal(
      polled.length,
      pollCount,
      'empty configuration pauses polling',
    );
    assert.equal(
      sent.length,
      expected + 1,
      'empty configuration pauses delivery',
    );
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(next)).run();
    await trigger();
    assert.equal(
      sent.length,
      expected + 1,
      'restoring a route preserves delivery history',
    );
  } finally {
    await runtime.dispose();
  }
});

test('the built web interface persists routes and encrypted webhooks used by the next scheduled poll', async () => {
  const feedUrl = 'https://admin-feed.example/feed';
  const webhook = 'https://discord.com/api/webhooks/9000/web-created-token';
  const sent: string[] = [];
  let hasNewEntry = false;
  const authorization = `Basic ${Buffer.from('admin:runtime-password').toString('base64')}`;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(
        new URL(
          '../.cloudflare/output/v1/workers/default/bundle/index.js',
          import.meta.url,
        ),
      ),
      compatibilityDate: '2026-11-18',
      cf: false,
      unsafeTriggerHandlers: true,
      d1Databases: { DB: 'syndicord-admin-runtime' },
      bindings: {
        ADMIN_PASSWORD: 'runtime-password',
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        WEBHOOKS: JSON.stringify({
          unused: 'https://discord.com/api/webhooks/8000/old-secret-token',
        }),
      },
      outboundService: async (request) => {
        if (request.url === feedUrl)
          return new Response(
            `<rss version="2.0"><channel><title>Web-managed feed</title><item><guid>old</guid><title>Old</title></item>${hasNewEntry ? '<item><guid>new</guid><title>New from web-managed route</title></item>' : ''}</channel></rss>`,
          );
        assert.equal(request.url, `${webhook}?wait=true`);
        sent.push(request.url);
        return Response.json({ id: '98765' });
      },
    }),
  );
  try {
    const db = await runtime.getD1Database('DB');
    await applyTestMigrations(db as unknown as D1Database);
    assert.equal(
      (await runtime.dispatchFetch('http://localhost/admin')).status,
      401,
    );
    const page = await runtime.dispatchFetch('http://localhost/admin', {
      headers: { Authorization: authorization },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /syndicord/i);
    const endpoint = 'http://localhost/admin/api/config';
    const initialResponse = await runtime.dispatchFetch(endpoint, {
      headers: { Authorization: authorization },
    });
    assert.equal(initialResponse.status, 200);
    const initial = (await initialResponse.json()) as { revision: string };
    const saved = await runtime.dispatchFetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: initial.revision,
        feeds: [{ url: feedUrl, destinations: ['news'] }],
        webhooks: { news: webhook },
      }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.doesNotMatch(
      await saved.text(),
      /web-created-token|old-secret-token/,
    );
    const stored = await db
      .prepare('SELECT encrypted_webhooks FROM relay_configuration')
      .first<{ encrypted_webhooks: string }>();
    assert.match(stored!.encrypted_webhooks, /^v1\./);
    assert.doesNotMatch(
      stored!.encrypted_webhooks,
      /web-created-token|old-secret-token/,
    );
    const trigger = async () => {
      const response = await runtime.dispatchFetch(
        'http://localhost/cdn-cgi/local/scheduled',
      );
      assert.equal(response.status, 200, await response.text());
    };
    await trigger();
    assert.equal(
      sent.length,
      0,
      'a web-created route establishes a silent baseline',
    );
    hasNewEntry = true;
    await trigger();
    assert.deepEqual(sent, [`${webhook}?wait=true`]);
    await trigger();
    assert.equal(
      sent.length,
      1,
      'delivery identities survive configuration managed through the web',
    );
    const reloaded = await runtime.dispatchFetch(endpoint, {
      headers: { Authorization: authorization },
    });
    const configuration = (await reloaded.json()) as {
      revision: string;
      feeds: unknown;
      destinations: string[];
    };
    assert.deepEqual(configuration.feeds, [
      { url: feedUrl, destinations: ['news'] },
    ]);
    assert.deepEqual(configuration.destinations, ['news', 'unused']);
  } finally {
    await runtime.dispose();
  }
});
