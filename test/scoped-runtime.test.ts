import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { applyTestMigrations, createTestDatabase } from './helpers/d1.ts';
import { runRelay } from '../src/runner.ts';
import { handleAdmin } from '../src/admin.ts';
import {
  authEnv,
  browserLogin,
  discordFixture,
  TEST_ROLE_ID,
  TEST_GUILD_ID,
} from './helpers/auth.ts';
import type { RelayConfig } from '../src/config.ts';
import type {
  CatalogSnapshot,
  CatalogOperation,
} from '../src/catalog-types.ts';

const guild = '100000000000000002';
const feedRole = '100000000000000003';
const routeRole = '100000000000000005';
const channel = '100000000000000006';
const hookId = '100000000000000007';
const hook = `https://discord.com/api/webhooks/${hookId}/private-hook-token`;
const source = 'https://feeds.example/private/feed?key=private-feed-token';
const rss = (ids: string[]) =>
  `<rss version="2.0"><channel><title>Fixture</title>${ids.map((id) => `<item><guid>${id}</guid><title>${id}</title></item>`).join('')}</channel></rss>`;

test('built Worker enforces scoped browser operations and verified delivery', async () => {
  let roles = [feedRole, routeRole];
  let revokeDuringLookup = false;
  let actualChannel = channel;
  let ids = ['old'];
  let sends = 0;
  let lookups = 0;
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
      d1Databases: { DB: 'scoped-runtime' },
      bindings: {
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        DISCORD_CLIENT_ID: '100000000000000001',
        DISCORD_CLIENT_SECRET: 'runtime-secret',
        DISCORD_REDIRECT_URI: 'http://localhost/admin/auth/callback',
        DISCORD_AUTH_POLICY: JSON.stringify({
          version: 1,
          grants: [
            { guildId: guild, roleId: feedRole, addFeeds: true },
            { guildId: guild, roleId: routeRole, channelIds: [channel] },
          ],
        }),
      },
      outboundService: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/api/oauth2/token')
          return Response.json({
            access_token: 'runtime-token',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'identify guilds.members.read',
          });
        if (path === '/api/v10/users/@me')
          return Response.json({
            id: '100000000000000004',
            username: 'scoped-user',
          });
        if (path === `/api/v10/users/@me/guilds/${guild}/member`)
          return Response.json({ roles });
        if (path === `/api/v10/webhooks/${hookId}/private-hook-token`) {
          assert.equal(request.method, 'GET');
          assert.equal(request.headers.get('authorization'), null);
          lookups++;
          if (revokeDuringLookup) {
            roles = [feedRole];
            // Simulate the lookup outliving cached evidence, so the final
            // authorization must refresh before committing the destination.
            const database = await runtime.getD1Database('DB');
            await database
              .prepare(
                'UPDATE admin_sessions SET permissions_checked_at_ms = ?',
              )
              .bind(Date.now() - 120_000)
              .run();
          }
          return Response.json({
            id: hookId,
            type: 1,
            guild_id: guild,
            channel_id: actualChannel,
          });
        }
        if (request.url === source) return new Response(rss(ids));
        assert.equal(request.url, `${hook}?wait=true`);
        assert.equal(request.method, 'POST');
        sends++;
        return Response.json({ id: '12345' });
      },
    }),
  );
  try {
    const db = await runtime.getD1Database('DB');
    await applyTestMigrations(db as unknown as D1Database);
    const start = await runtime.dispatchFetch(
      'http://localhost/admin/auth/login',
      { redirect: 'manual' },
    );
    const state = new URL(start.headers.get('location')!).searchParams.get(
      'state',
    )!;
    const cookieFor = (response: { headers: { getSetCookie(): string[] } }) =>
      response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; ');
    const signedIn = await runtime.dispatchFetch(
      `http://localhost/admin/auth/callback?code=fixture&iss=https%3A%2F%2Fdiscord.com&state=${state}`,
      { redirect: 'manual', headers: { Cookie: cookieFor(start) } },
    );
    assert.equal(signedIn.headers.get('location'), '/admin');
    const headers = {
      Cookie: cookieFor(signedIn),
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
    };
    const endpoint = 'http://localhost/admin/api/catalog';
    let current = (await (
      await runtime.dispatchFetch(endpoint, { headers })
    ).json()) as CatalogSnapshot;
    assert.equal(current.initialized, false);
    const apply = async (operation: CatalogOperation, expected = 200) => {
      const response = await runtime.dispatchFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ revision: current.revision, operation }),
      });
      assert.equal(response.status, expected, await response.clone().text());
      if (expected === 200)
        current = (await response.json()) as CatalogSnapshot;
      return response;
    };
    await apply({ type: 'initialize' });
    await apply({ type: 'feed.create', label: 'Private source', url: source });
    const original = current.feeds[0]!.id;
    revokeDuringLookup = true;
    await apply(
      { type: 'destination.create', label: 'Updates', webhookUrl: hook },
      403,
    );
    assert.equal(
      (
        (await (
          await runtime.dispatchFetch(endpoint, { headers })
        ).json()) as CatalogSnapshot
      ).revision,
      current.revision,
    );
    revokeDuringLookup = false;
    roles = [feedRole, routeRole];
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
      .bind(Date.now() - 120_000)
      .run();
    await apply({
      type: 'destination.create',
      label: 'Updates',
      webhookUrl: hook,
    });
    const destination = current.destinations[0]!.id;
    await apply({
      type: 'subscription.add',
      feedId: original,
      destinationId: destination,
    });
    assert.doesNotMatch(
      JSON.stringify(current),
      /private-feed-token|private-hook-token|feeds\.example/,
    );
    const old = await runtime.dispatchFetch(
      'http://localhost/admin/api/config',
      { headers },
    );
    assert.equal(old.status, 400);
    assert.equal(
      ((await old.json()) as { code: string }).code,
      'scoped_catalog_required',
    );
    const csrf = await runtime.dispatchFetch(endpoint, {
      method: 'POST',
      headers: { Cookie: headers.Cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: current.revision,
        operation: { type: 'feed.delete', id: original },
      }),
    });
    assert.equal(csrf.status, 403);
    const stale = current.revision;
    await apply({
      type: 'feed.create',
      label: 'Replacement source',
      url: 'https://replacement.example/feed',
    });
    assert.deepEqual(current.subscriptions, [
      { feedId: original, destinationId: destination },
    ]);
    const conflict = await runtime.dispatchFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        revision: stale,
        operation: { type: 'feed.rename', id: original, label: 'Changed' },
      }),
    });
    assert.equal(conflict.status, 409);
    const trigger = async () =>
      assert.equal(
        (
          await runtime.dispatchFetch(
            'http://localhost/cdn-cgi/local/scheduled',
          )
        ).status,
        200,
      );
    await trigger();
    assert.equal(sends, 0);
    ids = ['old', 'new'];
    await trigger();
    assert.equal(sends, 1);
    actualChannel = '100000000000000099';
    ids = ['old', 'new', 'blocked'];
    await trigger();
    assert.equal(sends, 1, 'moved webhook must never receive new content');
    assert.ok(lookups >= 4);
    roles = [routeRole];
    assert.equal(
      (await runtime.dispatchFetch(endpoint, { headers })).status,
      200,
    );
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
      .bind(Date.now() - 120_000)
      .run();
    await apply(
      {
        type: 'feed.create',
        label: 'Denied',
        url: 'https://denied.example/feed',
      },
      403,
    );
    roles = [];
    assert.equal(
      (await runtime.dispatchFetch(endpoint, { headers })).status,
      200,
    );
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
      .bind(Date.now() - 120_000)
      .run();
    assert.equal(
      (await runtime.dispatchFetch(endpoint, { headers })).status,
      403,
    );
    await trigger();
    assert.equal(sends, 1);
  } finally {
    await runtime.dispose();
  }
});

test('scoped delivery fails closed on missing bindings and honors global verification cooldowns', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    let ids = ['old'];
    let gets = 0;
    let posts = 0;
    let mode: 'missing' | 'limited' | 'ok' = 'missing';
    const config: RelayConfig = {
      feeds: [{ url: source, destinations: ['first', 'second'] }],
      webhooks: {
        first: hook,
        second: `https://discord.com/api/webhooks/100000000000000008/second-token`,
      },
      destinationBindings: {},
    };
    const fetcher = async (url: string, init?: RequestInit) => {
      if (url === source) return new Response(rss(ids));
      if (init?.method === 'GET') {
        gets++;
        if (mode === 'limited')
          return Response.json(
            { retry_after: 120, global: true },
            { status: 429 },
          );
        return Response.json({
          id: new URL(url).pathname.split('/').at(-2),
          type: 1,
          guild_id: guild,
          channel_id: channel,
        });
      }
      posts++;
      return Response.json({ id: '123' });
    };
    await runRelay(config, db, { fetcher, log: () => {} });
    ids = ['old', 'new'];
    const blocked = await runRelay(config, db, { fetcher, log: () => {} });
    assert.equal(blocked.deferred, 2);
    assert.equal(posts, 0);
    assert.equal(gets, 0);
    for (const name of ['first', 'second'])
      config.destinationBindings![name] = {
        guildId: guild,
        channelId: channel,
      };
    await db
      .prepare(
        "UPDATE relay_deliveries SET next_attempt_ms=0 WHERE state='pending'",
      )
      .run();
    mode = 'limited';
    await runRelay(config, db, { fetcher, log: () => {} });
    assert.equal(
      gets,
      1,
      'global metadata rate limit stops other destination lookups',
    );
    await runRelay(config, db, { fetcher, log: () => {} });
    assert.equal(gets, 1, 'persisted global cooldown survives next invocation');
    assert.equal(posts, 0);
    mode = 'ok';
    await db.prepare('UPDATE relay_destinations SET cooldown_until_ms=0').run();
    await db
      .prepare(
        "UPDATE relay_deliveries SET next_attempt_ms=0 WHERE state='pending'",
      )
      .run();
    assert.equal(
      (await runRelay(config, db, { fetcher, log: () => {} })).sent,
      2,
    );
  } finally {
    await dispose();
  }
});

test('an initialized catalog cannot fall back to broad legacy sessions when policy is removed', async () => {
  const { db, dispose } = await createTestDatabase();
  try {
    const env = authEnv(db);
    const discord = discordFixture();
    const oldSession = await browserLogin(env, discord);
    env.DISCORD_AUTH_POLICY = JSON.stringify({
      version: 1,
      grants: [
        { guildId: TEST_GUILD_ID, roleId: TEST_ROLE_ID, addFeeds: true },
      ],
    });
    const scopedSession = await browserLogin(env, discord);
    const headers = {
      Cookie: scopedSession.cookie,
      Origin: 'https://syndicord.example',
      'Content-Type': 'application/json',
    };
    const endpoint = 'https://syndicord.example/admin/api/catalog';
    const before = (await (await handleAdmin(
      new Request(endpoint, { headers }),
      env,
      discord,
    ))!.json()) as CatalogSnapshot;
    const initialized = (await handleAdmin(
      new Request(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          revision: before.revision,
          operation: { type: 'initialize' },
        }),
      }),
      env,
      discord,
    ))!;
    assert.equal(initialized.status, 200, await initialized.text());
    delete env.DISCORD_AUTH_POLICY;
    for (const path of ['/admin', '/admin/api/config', '/admin/api/catalog']) {
      const response = (await handleAdmin(
        new Request(`https://syndicord.example${path}`, {
          headers: { Cookie: oldSession.cookie },
        }),
        env,
        discord,
      ))!;
      assert.equal(response.status, 503);
      assert.match(
        await response.text(),
        /Restore the operator authorization policy/,
      );
    }
  } finally {
    await dispose();
  }
});
