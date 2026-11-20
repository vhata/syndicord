import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import feeds from '../feeds.json' with { type: 'json' };
import { applyTestMigrations } from './helpers/d1.ts';

test('the cf-built Worker handles scheduled events with local D1 and mocked outbound HTTP', async () => {
  const names = [...new Set(feeds.flatMap((feed) => feed.destinations))];
  const webhooks = Object.fromEntries(
    names.map((name, index) => [
      name,
      `https://discord.com/api/webhooks/${1000 + index}/test-token`,
    ]),
  );
  const feedUrls = new Set(feeds.map((feed) => feed.url));
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
          return new Response(
            `<rss version="2.0"><channel><title>Test</title><item><guid>old</guid><title>Old</title></item>${updated ? '<item><guid>new</guid><title>New</title></item>' : ''}</channel></rss>`,
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
  } finally {
    await runtime.dispose();
  }
});
