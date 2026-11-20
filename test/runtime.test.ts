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
