import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { WRITE_CONFIGURATION_SQL } from '../src/config-store.ts';
import {
  configurationKey,
  readAdminConfiguration,
  saveAdminConfiguration,
} from '../src/admin-store.ts';

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
      bindings: {
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'),
      },
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
    const env = {
      DB: db as unknown as D1Database,
      CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'),
    };
    const cryptoKey = await configurationKey(env.CONFIG_ENCRYPTION_KEY);
    const current = await readAdminConfiguration(env, cryptoKey);
    await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds,
      webhooks,
    });
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
  const guildId = '100000000000000002';
  const roleId = '100000000000000003';
  let cookie = '';
  let roles = [roleId];
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
        DISCORD_CLIENT_ID: '100000000000000001',
        DISCORD_CLIENT_SECRET: 'runtime-client-secret',
        DISCORD_REDIRECT_URI: 'http://localhost/admin/auth/callback',
        DISCORD_GUILD_ID: guildId,
        DISCORD_ROLE_ID: roleId,
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      },
      outboundService: async (request) => {
        if (request.url === 'https://discord.com/api/oauth2/token') {
          const body = new URLSearchParams(await request.text());
          assert.equal(body.get('grant_type'), 'authorization_code');
          assert.equal(body.get('code'), 'runtime-authorization-code');
          assert.ok(body.get('code_verifier'));
          return Response.json({
            access_token: 'runtime-discord-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'identify guilds.members.read',
          });
        }
        if (request.url === 'https://discord.com/api/v10/users/@me')
          return Response.json({
            id: '100000000000000004',
            username: 'runtime-user',
            global_name: 'Runtime admin',
          });
        if (
          request.url ===
          `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`
        ) {
          assert.equal(
            request.headers.get('authorization'),
            'Bearer runtime-discord-token',
          );
          return Response.json({ roles });
        }
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
    const signedOut = await runtime.dispatchFetch('http://localhost/admin');
    assert.equal(signedOut.status, 200);
    assert.match(await signedOut.text(), /Sign in with Discord/);
    assert.equal(
      (await runtime.dispatchFetch('http://localhost/admin/api/config')).status,
      401,
    );
    const login = await runtime.dispatchFetch(
      'http://localhost/admin/auth/login',
      { redirect: 'manual' },
    );
    assert.equal(login.status, 303);
    const authorize = new URL(login.headers.get('location')!);
    assert.equal(authorize.hostname, 'discord.com');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      authorize.searchParams.get('scope'),
      'identify guilds.members.read',
    );
    const callback = new URL('http://localhost/admin/auth/callback');
    callback.searchParams.set('code', 'runtime-authorization-code');
    callback.searchParams.set('state', authorize.searchParams.get('state')!);
    callback.searchParams.set('iss', 'https://discord.com');
    const stateCookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const authorized = await runtime.dispatchFetch(callback.href, {
      redirect: 'manual',
      headers: { Cookie: stateCookie },
    });
    assert.equal(authorized.status, 303);
    assert.equal(authorized.headers.get('location'), '/admin');
    cookie = authorized.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');
    const page = await runtime.dispatchFetch('http://localhost/admin', {
      headers: { Cookie: cookie },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /syndicord/i);
    const endpoint = 'http://localhost/admin/api/config';
    const initialResponse = await runtime.dispatchFetch(endpoint, {
      headers: { Cookie: cookie },
    });
    assert.equal(initialResponse.status, 200);
    const initial = (await initialResponse.json()) as { revision: string };
    const saved = await runtime.dispatchFetch(endpoint, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
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
    assert.doesNotMatch(await saved.text(), /web-created-token/);
    const stored = await db
      .prepare('SELECT encrypted_webhooks FROM relay_configuration')
      .first<{ encrypted_webhooks: string }>();
    assert.match(stored!.encrypted_webhooks, /^v1\./);
    assert.doesNotMatch(stored!.encrypted_webhooks, /web-created-token/);
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
      headers: { Cookie: cookie },
    });
    const configuration = (await reloaded.json()) as {
      revision: string;
      feeds: unknown;
      destinations: string[];
    };
    assert.deepEqual(configuration.feeds, [
      { url: feedUrl, destinations: ['news'] },
    ]);
    assert.deepEqual(configuration.destinations, ['news']);
    roles = [];
    assert.equal(
      (await runtime.dispatchFetch(endpoint, { headers: { Cookie: cookie } }))
        .status,
      200,
      'the built Worker retains cached role grants within the two-minute window',
    );
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
      .bind(Date.now() - 120_000)
      .run();
    const denied = await runtime.dispatchFetch(endpoint, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: configuration.revision,
        feeds: [],
        webhooks: {},
      }),
    });
    assert.equal(denied.status, 403);
    await trigger();
    assert.equal(
      sent.length,
      1,
      'removing the administrator role does not disable the scheduled relay',
    );
    const logout = await runtime.dispatchFetch(
      'http://localhost/admin/auth/logout',
      {
        redirect: 'manual',
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'http://localhost' },
      },
    );
    assert.equal(logout.status, 303);
    assert.equal(
      (await runtime.dispatchFetch(endpoint, { headers: { Cookie: cookie } }))
        .status,
      401,
    );
  } finally {
    await runtime.dispose();
  }
});
