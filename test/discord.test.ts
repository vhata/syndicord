import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { URL as NodeURL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { buildMessage, sendDiscord } from '../src/discord.ts';
import type { FeedEntry, Fetcher } from '../src/types.ts';

const webhook = 'https://discord.com/api/webhooks/123/test-token';
const feedUrl = 'https://example.test/feed.xml';
const entry: FeedEntry = {
  id: 'id:entry',
  title: 'A new post',
  link: 'https://example.test/post',
  description: 'A short description.',
  publishedAt: '2026-11-18T12:00:00.000Z',
};
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), init);

test('formats one bounded embed with original links and disabled mentions', () => {
  const message = buildMessage(
    {
      ...entry,
      title: '*'.repeat(500),
      description:
        '😀'.repeat(3_000) + '@everyone <@123> [label](https://other.test)',
    },
    feedUrl,
  );
  const embed = message.embeds[0]!;
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description!.length <= 700);
  assert.ok((embed.title + embed.description).length < 6_000);
  assert.equal(embed.url, entry.link);
  assert.equal(embed.timestamp, entry.publishedAt);
  assert.deepEqual(message.allowed_mentions.parse, []);
  assert.equal(embed.description?.isWellFormed(), true);
  const escaped = buildMessage(
    { ...entry, description: '@everyone <@123> [label](https://other.test)' },
    feedUrl,
  ).embeds[0]!.description!;
  assert.ok(!escaped.includes('@everyone'));
  assert.ok(!escaped.includes('<@123>'));
  assert.ok(escaped.includes('\\[label\\]\\('));
});

test('omits unsafe entry links and empty descriptions', () => {
  const embed = buildMessage(
    {
      ...entry,
      title: '',
      description: '',
      link: 'javascript:alert(1)',
      publishedAt: 'bad-date',
    },
    feedUrl,
  ).embeds[0]!;
  assert.deepEqual(embed, {
    color: 0x0f9d92,
    author: { name: 'example.test', url: feedUrl },
    title: 'Untitled',
    footer: { text: 'syndicord · example.test' },
    url: feedUrl,
  });
  assert.equal(
    buildMessage(
      { ...entry, link: 'https://user:password@example.test/' },
      'file:///feed',
    ).embeds[0]?.url,
    undefined,
  );
});

test('shows the feed name above a compact excerpt without duplicating its heading', () => {
  const embed = buildMessage(
    {
      ...entry,
      feedTitle: 'News & Notes *daily*',
      description:
        'A new post\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.',
    },
    feedUrl,
  ).embeds[0]!;
  assert.equal(embed.author.name, 'News & Notes *daily*');
  assert.equal(embed.author.url, feedUrl);
  assert.equal(embed.color, 0x0f9d92);
  assert.equal(embed.footer.text, 'syndicord · example.test');
  assert.equal(
    embed.description,
    'First paragraph\\.\n\nSecond paragraph\\.\n\nThird paragraph…',
  );
});

test('truncates Markdown without splitting literal backslash escapes', () => {
  const embed = buildMessage(
    { ...entry, title: '\\'.repeat(400), description: '\\'.repeat(800) },
    feedUrl,
  ).embeds[0]!;
  for (const value of [embed.title, embed.description!]) {
    const match = value.match(/(\\+)…$/);
    assert.ok(match);
    const escapes = match[1]!.length;
    assert.equal(escapes % 2, 0);
    assert.equal(value.isWellFormed(), true);
  }
  const plain = buildMessage({ ...entry, feedTitle: '\\'.repeat(400) }, feedUrl)
    .embeds[0]!.author.name;
  assert.equal(plain.length, 256);
  assert.equal(plain, '\\'.repeat(255) + '…');
});

test('keeps ordinary opening prose and omits an exact title-only description', () => {
  assert.equal(
    buildMessage(
      {
        ...entry,
        title: 'News',
        description: 'News from the wider community.',
      },
      feedUrl,
    ).embeds[0]?.description,
    'News from the wider community\\.',
  );
  assert.equal(
    buildMessage({ ...entry, description: entry.title }, feedUrl).embeds[0]
      ?.description,
    undefined,
  );
  assert.equal(
    buildMessage(
      { ...entry, title: 'News', description: 'Newsletter\n\nSomething new.' },
      feedUrl,
    ).embeds[0]?.description,
    'Newsletter\n\nSomething new\\.',
  );
});

test('bounds feed metadata and handles legacy payloads without feed titles', () => {
  const embed = buildMessage(
    {
      ...entry,
      feedTitle: '@everyone <@123> ' + '🚀'.repeat(300),
      description: 'Word '.repeat(400),
    },
    feedUrl,
  ).embeds[0]!;
  assert.ok(embed.author.name.length <= 256);
  assert.equal(embed.author.name.isWellFormed(), true);
  assert.ok(!embed.author.name.includes('@everyone'));
  assert.ok(!embed.author.name.includes('<@123>'));
  assert.ok(embed.description!.length <= 700);
  assert.ok(embed.description!.endsWith('…'));
  assert.equal(
    buildMessage(entry, feedUrl).embeds[0]?.author.name,
    'example.test',
  );
  const missing = buildMessage({ ...entry, feedTitle: '\n\t' }, 'file:///feed')
    .embeds[0]!;
  assert.deepEqual(missing.author, { name: 'Feed update' });
  assert.deepEqual(missing.footer, { text: 'syndicord' });
});

test('requests server confirmation, preserves thread IDs, and forbids redirects', async () => {
  let requested = false;
  const fetcher: Fetcher = async (url, init) => {
    requested = true;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('wait'), 'true');
    assert.equal(parsed.searchParams.get('thread_id'), '456');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(
      JSON.parse(init!.body as string),
      buildMessage(entry, feedUrl),
    );
    return json({ id: '987654321' });
  };
  assert.deepEqual(
    await sendDiscord(
      webhook + '?thread_id=456&wait=false',
      entry,
      feedUrl,
      fetcher,
    ),
    { ok: true, cooldownMs: 0 },
  );
  assert.equal(requested, true);
});

test('honors fractional and long rate limits, choosing the longest advertised delay', async () => {
  const result = await sendDiscord(webhook, entry, feedUrl, async () =>
    json(
      { retry_after: 90_000.25, global: false },
      {
        status: 429,
        headers: { 'Retry-After': '5', 'X-RateLimit-Reset-After': '1.125' },
      },
    ),
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'rate_limited',
    status: 429,
    retryAfterMs: 90_000_250,
    global: false,
  });
  assert.deepEqual(
    await sendDiscord(webhook, entry, feedUrl, async () =>
      json({ retry_after: 1.125, global: true }, { status: 429 }),
    ),
    {
      ok: false,
      reason: 'rate_limited',
      status: 429,
      retryAfterMs: 1_125,
      global: true,
    },
  );
});

test('retains rate-limit headers with malformed responses and handles global scope', async () => {
  const result = await sendDiscord(
    webhook,
    entry,
    feedUrl,
    async () =>
      new Response('not JSON', {
        status: 429,
        headers: { 'Retry-After': '3', 'X-RateLimit-Scope': 'global' },
      }),
  );
  assert.deepEqual(result, {
    ok: false,
    reason: 'rate_limited',
    status: 429,
    retryAfterMs: 3_000,
    global: true,
  });
  const fallback = await sendDiscord(webhook, entry, feedUrl, async () =>
    json(
      { retry_after: -5 },
      {
        status: 429,
        headers: { 'Retry-After': 'Infinity', 'X-RateLimit-Reset-After': '-2' },
      },
    ),
  );
  assert.equal(!fallback.ok && fallback.retryAfterMs, 1_000);
});

test('honors successful exhausted buckets and HTTP-date Retry-After', async () => {
  const result = await sendDiscord(webhook, entry, feedUrl, async () =>
    json(
      { id: '123' },
      {
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset-After': '2.25',
        },
      },
    ),
  );
  assert.deepEqual(result, { ok: true, cooldownMs: 2_250 });
  const date = new Date(Date.now() + 10_000).toUTCString();
  const retry = await sendDiscord(
    webhook,
    entry,
    feedUrl,
    async () =>
      new Response('', { status: 503, headers: { 'Retry-After': date } }),
  );
  assert.ok(
    !retry.ok && retry.retryAfterMs! > 8_000 && retry.retryAfterMs! <= 10_000,
  );
});

test('rejects missing, malformed, and oversized delivery confirmations', async () => {
  const responses = [
    new Response(null, { status: 204 }),
    json({ success: true }),
    json({ id: 123 }),
    new Response('broken'),
    new Response('x'.repeat(65_537)),
  ];
  for (const response of responses) {
    const result = await sendDiscord(
      webhook,
      entry,
      feedUrl,
      async () => response,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'invalid_response');
  }
});

test('reports HTTP status without exposing remote errors or webhook secrets', async () => {
  for (const status of [301, 401, 403, 404, 500]) {
    const result = await sendDiscord(
      webhook,
      entry,
      feedUrl,
      async () => new Response(webhook, { status }),
    );
    assert.deepEqual(result, {
      ok: false,
      reason: 'http_error',
      status,
      retryAfterMs: null,
      global: false,
    });
    assert.ok(!JSON.stringify(result).includes('test-token'));
  }
  const result = await sendDiscord(webhook, entry, feedUrl, async () => {
    throw new Error(webhook);
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'network_error',
    status: null,
    retryAfterMs: null,
    global: false,
  });
});

test('rejects non-Discord and malformed endpoints before sending', async () => {
  for (const url of [
    'https://other.test/api/webhooks/123/token',
    'http://discord.com/api/webhooks/123/token',
    'https://discord.com/not-a-webhook',
    'https://discord.com:8443/api/webhooks/123/token',
    'https://user:pass@discord.com/api/webhooks/123/token',
  ]) {
    let requests = 0;
    const result = await sendDiscord(url, entry, feedUrl, async () => {
      requests++;
      return json({ id: '123' });
    });
    assert.equal(requests, 0);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, null);
  }
});

test('times out and aborts a stalled request without waiting for the transport', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | null = null;
  const pending = sendDiscord(webhook, entry, feedUrl, async (_url, init) => {
    signal = init!.signal!;
    return new Promise<Response>(() => {});
  });
  context.mock.timers.tick(6_000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'network_error');
  assert.equal((signal as AbortSignal | null)?.aborted, true);
});

test('timeout also cancels a response body that stops producing data', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      cancelled = true;
    },
  });
  const pending = sendDiscord(
    webhook,
    entry,
    feedUrl,
    async () => new Response(stream),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  context.mock.timers.tick(6_000);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'network_error');
  assert.equal(cancelled, true);
});

test('the Workers runtime sends webhook requests and refuses redirect responses', async () => {
  const source = await readFile(
    new NodeURL('../src/discord.ts', import.meta.url),
    'utf8',
  );
  const targets: string[] = [];
  let redirect = false;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: `${stripTypeScriptTypes(source)}\nexport default {
      async fetch() {
        return Response.json(await sendDiscord(${JSON.stringify(webhook)}, ${JSON.stringify(entry)}, ${JSON.stringify(feedUrl)}));
      }
    };`,
      compatibilityDate: '2026-11-18',
      cf: false,
      outboundService: async (request) => {
        targets.push(request.url);
        if (redirect)
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://other.test/collect' },
          });
        return Response.json({ id: '123456' });
      },
    }),
  );
  try {
    const success = await runtime.dispatchFetch('http://localhost/');
    assert.deepEqual(await success.json(), { ok: true, cooldownMs: 0 });
    redirect = true;
    const refusal = await runtime.dispatchFetch('http://localhost/');
    assert.deepEqual(await refusal.json(), {
      ok: false,
      reason: 'http_error',
      status: 302,
      retryAfterMs: null,
      global: false,
    });
    assert.deepEqual(targets, [`${webhook}?wait=true`, `${webhook}?wait=true`]);
  } finally {
    await runtime.dispose();
  }
});
