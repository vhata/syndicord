import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchFeed, MAX_FEED_BYTES } from '../src/http.ts';

test('feed fetching follows bounded redirects and returns the final base URL', async () => {
  const seen: string[] = [];
  const result = await fetchFeed(
    'https://example.com/feed',
    async (url, init) => {
      seen.push(url);
      assert.equal(init?.redirect, 'manual');
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: '/rss.xml' } })
        : new Response('<rss/>');
    },
  );
  assert.deepEqual(seen, [
    'https://example.com/feed',
    'https://example.com/rss.xml',
  ]);
  assert.deepEqual(result, {
    text: '<rss/>',
    url: 'https://example.com/rss.xml',
  });
});

test('feed fetch rejects loops, credential redirects, downgrades and HTTP failures', async () => {
  for (const location of [
    '/loop',
    'https://name:password@example.com/private',
    'http://example.com/insecure',
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchFeed('https://example.com/feed', async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      }),
      /redirect/,
    );
    assert.ok(calls <= 4);
  }
  await assert.rejects(
    fetchFeed(
      'https://example.com/feed',
      async () => new Response('private response', { status: 500 }),
    ),
    /http/,
  );
  await assert.rejects(
    fetchFeed('https://example.com/feed', async () => {
      throw new Error('private URL');
    }),
    { message: 'Feed fetch failed: network' },
  );
});

test('feed fetch limits declared and streamed response sizes', async () => {
  await assert.rejects(
    fetchFeed(
      'https://example.com/feed',
      async () =>
        new Response('', {
          headers: { 'content-length': String(MAX_FEED_BYTES + 1) },
        }),
    ),
    /too_large/,
  );
  await assert.rejects(
    fetchFeed(
      'https://example.com/feed',
      async () => new Response('x'.repeat(MAX_FEED_BYTES + 1)),
    ),
    /too_large/,
  );
});

test('feed timeout covers stalled response bodies', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchFeed('https://example.com/feed', async () => new Response(stream), 10),
    /timeout/,
  );
  assert.equal(cancelled, true);
});

test('feed fetching rejects corrupt UTF-8 instead of replacing identity bytes', async () => {
  await assert.rejects(
    fetchFeed(
      'https://example.com/feed',
      async () => new Response(new Uint8Array([0x3c, 0x72, 0xff, 0x3e])),
    ),
    /encoding/,
  );
});
