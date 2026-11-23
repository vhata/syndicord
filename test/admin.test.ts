import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin as handleAdminRequest } from '../src/admin.ts';
import type { AdminEnv } from '../src/admin.ts';
import {
  configurationKey,
  readAdminConfiguration,
  readRelayConfiguration,
  saveAdminConfiguration,
} from '../src/admin-store.ts';
import { WRITE_CONFIGURATION_SQL } from '../src/config-store.ts';
import {
  CONFIGURATION_SIZE_ERROR,
  MAX_CONFIGURATION_BYTES,
} from '../src/config.ts';
import { createTestDatabase } from './helpers/d1.ts';

const origin = 'https://syndicord.example';
const key = Buffer.alloc(32, 7).toString('base64');
const secret = 'https://discord.com/api/webhooks/123/private-webhook-token';
const other = 'https://discord.com/api/webhooks/456/other-private-token';
const feeds = [
  {
    url: 'https://example.com/feed?token=private-feed-token',
    destinations: ['updates'],
  },
];

test('large route configurations save and round-trip through the authenticated API', async () => {
  const { env, dispose, handleAdmin, request, put } = await fixture();
  try {
    const initial = await readAdminConfiguration(
      env,
      await configurationKey(key),
    );
    const names = Array.from({ length: 30 }, (_, index) => `d${index}`);
    const expanded = Array.from({ length: 30 }, (_, index) => ({
      url: `https://example.com/feed/${index}`,
      destinations: names,
    }));
    const webhooks = Object.fromEntries(
      names.map((name, index) => [
        name,
        `https://discord.com/api/webhooks/${index + 1}/token`,
      ]),
    );
    const response = (await handleAdmin(
      put({
        revision: initial.revision,
        feeds: expanded,
        webhooks,
      }),
    ))!;
    assert.equal(response.status, 200, await response.clone().text());
    const saved = (await response.json()) as {
      maxRoutes: null;
      feeds: unknown;
    };
    assert.equal(saved.maxRoutes, null);
    assert.deepEqual(saved.feeds, expanded);
    const read = (await handleAdmin(request()))!;
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), saved);
    assert.deepEqual((await readRelayConfiguration(env)).feeds, expanded);
  } finally {
    await dispose();
  }
});

test('merged saves preserve the old maximum URL range and reject cumulative size growth atomically', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = { DB: db, CONFIG_ENCRYPTION_KEY: key };
  const encryptionKey = await configurationKey(key);
  const longWebhook = (index: number) => {
    const prefix = `https://discord.com/api/webhooks/${index + 1}/`;
    return prefix + 'x'.repeat(2048 - prefix.length);
  };
  try {
    let current = await readAdminConfiguration(env, encryptionKey);
    const longFeeds = Array.from({ length: 20 }, (_, index) => {
      const prefix = `https://example.com/${index}/`;
      return {
        url: prefix + 'x'.repeat(2048 - prefix.length),
        destinations: [`d${index}`],
      };
    });
    const oldWebhooks = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `d${index}`,
        longWebhook(index),
      ]),
    );
    const size = Buffer.byteLength(
      JSON.stringify({ feeds: longFeeds, webhooks: oldWebhooks }),
    );
    assert.ok(size > 64 * 1024 && size < MAX_CONFIGURATION_BYTES);
    current = await saveAdminConfiguration(env, encryptionKey, {
      revision: current.revision,
      feeds: longFeeds,
      webhooks: oldWebhooks,
    });
    const largerWebhooks = Object.fromEntries(
      Array.from({ length: 47 }, (_, index) => [
        `d${index}`,
        longWebhook(index),
      ]),
    );
    current = await saveAdminConfiguration(env, encryptionKey, {
      revision: current.revision,
      feeds: [],
      webhooks: largerWebhooks,
    });
    const extra = {
      revision: current.revision,
      feeds: [],
      webhooks: { d47: longWebhook(47) },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(extra)) < 4096);
    await assert.rejects(saveAdminConfiguration(env, encryptionKey, extra), {
      message: CONFIGURATION_SIZE_ERROR,
    });
    assert.deepEqual(await readAdminConfiguration(env, encryptionKey), current);

    // Earlier versions allowed accumulated webhook maps to grow without a
    // total-size bound. Such configurations can still be read and reduced.
    await db
      .prepare('UPDATE relay_configuration SET feeds = ? WHERE id = 1')
      .bind(JSON.stringify(longFeeds))
      .run();
    const legacy = await readAdminConfiguration(env, encryptionKey);
    assert.deepEqual(legacy.feeds, longFeeds);
    assert.deepEqual((await readRelayConfiguration(env)).feeds, longFeeds);
    const reduced = await saveAdminConfiguration(env, encryptionKey, {
      revision: legacy.revision,
      feeds: [],
      webhooks: {},
    });
    assert.deepEqual(reduced.feeds, []);
    assert.deepEqual(reduced.destinations, current.destinations);
  } finally {
    await dispose();
  }
});
async function fixture() {
  const database = await createTestDatabase();
  const env: AdminEnv = {
    DB: database.db,
    CONFIG_ENCRYPTION_KEY: key,
    DISCORD_CLIENT_ID: '100000000000000001',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    DISCORD_REDIRECT_URI: origin + '/admin/auth/callback',
    DISCORD_GUILD_ID: '100000000000000002',
    DISCORD_ROLE_ID: '100000000000000003',
  };
  let roles = [env.DISCORD_ROLE_ID!];
  let providerStatus = 200;
  const fetcher: typeof fetch = async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === 'https://discord.com/api/oauth2/token')
      return Response.json({
        access_token: 'test-discord-access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'identify guilds.members.read',
      });
    if (outbound.url === 'https://discord.com/api/v10/users/@me')
      return Response.json({
        id: '100000000000000004',
        username: 'test-admin',
        global_name: 'Test admin',
      });
    if (
      outbound.url ===
      `https://discord.com/api/v10/users/@me/guilds/${env.DISCORD_GUILD_ID}/member`
    ) {
      if (providerStatus !== 200)
        return Response.json(
          { error: 'private-provider-error' },
          { status: providerStatus, headers: { 'Retry-After': '12' } },
        );
      return Response.json({ roles, user: { id: '100000000000000004' } });
    }
    throw new Error('Unexpected Discord request');
  };
  const handleAdmin = (request: Request, target = env) =>
    handleAdminRequest(request, target, fetcher);
  const start = (await handleAdmin(new Request(origin + '/admin/auth/login')))!;
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get('location')!).searchParams.get(
    'state',
  )!;
  const stateCookie = start.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  const callback = new URL(origin + '/admin/auth/callback');
  callback.searchParams.set('code', 'test-authorization-code');
  callback.searchParams.set('state', state);
  callback.searchParams.set('iss', 'https://discord.com');
  const finished = (await handleAdmin(
    new Request(callback, { headers: { Cookie: stateCookie } }),
  ))!;
  assert.equal(finished.status, 303, await finished.clone().text());
  assert.equal(finished.headers.get('location'), '/admin');
  const cookie = finished.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  const request = (path = '/admin/api/config', init: RequestInit = {}) =>
    new Request(origin + path, {
      ...init,
      headers: { Cookie: cookie, ...init.headers },
    });
  const put = (body: unknown, extra: Record<string, string> = {}) =>
    request('/admin/api/config', {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  return {
    ...database,
    env,
    handleAdmin,
    request,
    put,
    setRoles: (value: string[]) => {
      roles = value;
    },
    setProviderStatus: (value: number) => {
      providerStatus = value;
    },
  };
}

test('administration requires configured Discord OAuth and signed-out pages show sign-in without exposing the editor', async () => {
  const { env, dispose, handleAdmin, request } = await fixture();
  try {
    for (const path of ['/', '/admin', '/admin/', '/admin/api/config']) {
      assert.equal(
        (await handleAdmin(request(path), { ...env, DISCORD_CLIENT_ID: '' }))!
          .status,
        503,
      );
    }
    for (const path of ['/admin', '/admin/']) {
      const response = (await handleAdmin(new Request(origin + path)))!;
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'same-origin');
      assert.equal(response.headers.get('www-authenticate'), null);
      const page = await response.text();
      assert.match(page, /Sign in with Discord/);
      assert.doesNotMatch(
        page,
        /id="feed-form"|id="webhook-form"|test-client-secret|test-discord-access-token/,
      );
    }
    for (const code of [
      'cancelled',
      'invalid',
      'toString',
      '<script>alert(1)</script>',
    ]) {
      const response = (await handleAdmin(
        new Request(origin + '/admin?auth=' + encodeURIComponent(code)),
      ))!;
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /<script>alert|function toString/);
      if (code === 'cancelled') assert.match(text, /sign-in was cancelled/);
      if (code === 'invalid') assert.match(text, /already used/);
    }
    for (const authorization of [
      '',
      'Bearer secret',
      'Basic $$$',
      `Basic ${Buffer.from('admin:old-password').toString('base64')}`,
    ]) {
      const response = (await handleAdmin(
        new Request(origin + '/admin/api/config', {
          headers: { Authorization: authorization },
        }),
      ))!;
      assert.equal(response.status, 401);
      assert.match(response.headers.get('content-type')!, /application\/json/);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.doesNotMatch(
        await response.text(),
        /private-|test-client-secret|test-discord-access-token/,
      );
    }
    for (const code of [
      'cancelled',
      'invalid',
      'unavailable',
      'rate_limited',
    ]) {
      const response = (await handleAdmin(request('/admin?auth=' + code)))!;
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /Discord sign-in was not completed/);
      assert.match(text, /Test admin/);
      assert.match(text, /account shown is still signed in/);
      assert.doesNotMatch(text, /id="feed-form"|id="webhook-form"/);
    }
    const redirect = (await handleAdmin(request('/')))!;
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/admin');
    assert.equal(redirect.headers.get('referrer-policy'), 'no-referrer');
    const page = (await handleAdmin(request('/admin')))!;
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.match(
      page.headers.get('content-security-policy')!,
      /frame-ancestors 'none'/,
    );
    const html = await page.text();
    assert.match(html, /Signed in as <strong>Test admin/);
    assert.match(html, /action="\/admin\/auth\/logout" method="post"/);
    assert.match(html, /id="feed-form"/);
    assert.equal(await handleAdmin(request('/unknown')), null);
    assert.equal(
      (await handleAdmin(request('/admin', { method: 'POST' })))!.status,
      405,
    );
    assert.equal(
      (await handleAdmin(request(), {
        ...env,
        CONFIG_ENCRYPTION_KEY: 'invalid',
      }))!.status,
      503,
    );
  } finally {
    await dispose();
  }
});

test('branding bindings reach the editor and every access state without invalidating sessions', async () => {
  const { env, db, dispose, handleAdmin, request, setRoles } = await fixture();
  try {
    const branded = {
      ...env,
      ADMIN_NAME: 'Community relay',
      ADMIN_HEADER_COLOR: '#eeeeee',
    };
    const responses = [
      (await handleAdmin(request('/admin'), branded))!,
      (await handleAdmin(new Request(origin + '/admin'), branded))!,
      (await handleAdmin(request('/admin?auth=cancelled'), branded))!,
      (await handleAdmin(request('/admin'), {
        ...branded,
        DISCORD_CLIENT_ID: '',
      }))!,
    ];
    setRoles([]);
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
      .bind(Date.now() - 120_000)
      .run();
    responses.push((await handleAdmin(request('/admin'), branded))!);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200, 503, 403],
    );
    for (const response of responses) {
      const page = await response.text();
      assert.match(
        page,
        /<span class="installation-name">Community relay<\/span>/,
      );
      assert.match(
        page,
        /--header: #eeeeee;[^}]*background: var\(--header\); color: #000000/,
      );
    }
  } finally {
    await dispose();
  }
});

test('expired membership evidence blocks editor, direct reads, and writes after role removal; Discord refresh failures never authorize configuration', async () => {
  const {
    env,
    db,
    dispose,
    handleAdmin,
    request,
    put,
    setRoles,
    setProviderStatus,
  } = await fixture();
  try {
    const initial = await readAdminConfiguration(
      env,
      await configurationKey(key),
    );
    setRoles([]);
    assert.equal(
      (await handleAdmin(request()))!.status,
      200,
      'fresh cached access remains usable',
    );
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
      .bind(Date.now() - 120_000)
      .run();
    for (const denied of [
      request('/admin'),
      request(),
      put({ revision: initial.revision, feeds: [], webhooks: {} }),
    ]) {
      const response = (await handleAdmin(denied))!;
      assert.equal(response.status, 403);
      const text = await response.text();
      assert.doesNotMatch(
        text,
        /id="feed-form"|id="webhook-form"|test-discord-access-token|private-provider-error/,
      );
      if (denied.url.endsWith('/admin')) {
        assert.match(text, /Test admin/);
        assert.match(text, /Sign out/);
        assert.match(text, /sign-in again/);
      }
    }
    setRoles([env.DISCORD_ROLE_ID!]);
    for (const code of [500, 429]) {
      setProviderStatus(code);
      const response = (await handleAdmin(
        put({ revision: initial.revision, feeds: [], webhooks: {} }),
      ))!;
      assert.ok([429, 503].includes(response.status));
      assert.doesNotMatch(await response.text(), /private-provider-error/);
      assert.equal(
        (await readAdminConfiguration(env, await configurationKey(key)))
          .revision,
        initial.revision,
      );
    }
  } finally {
    await dispose();
  }
});

test('an empty installation accepts encrypted configuration and leaves the ledger intact', async () => {
  const { env, db, dispose, handleAdmin, request, put } = await fixture();
  try {
    const initial = (await (await handleAdmin(request(), env))!.json()) as {
      revision: string;
      feeds: unknown;
      destinations: string[];
    };
    assert.deepEqual(initial.feeds, []);
    assert.deepEqual(initial.destinations, []);
    assert.deepEqual((await readRelayConfiguration({ DB: db })).feeds, []);
    assert.doesNotMatch(
      JSON.stringify(initial),
      /private-webhook-token|discord.com/,
    );
    await db
      .prepare(
        "INSERT INTO relay_routes(feed_url, destination, baseline_id, initialized_at_ms) VALUES (?, 'updates', 'existing', 1)",
      )
      .bind(feeds[0]!.url)
      .run();
    const response = (await handleAdmin(
      put({
        revision: initial.revision,
        feeds,
        webhooks: { updates: secret, other },
      }),
      env,
    ))!;
    assert.equal(response.status, 200, await response.clone().text());
    const saved = (await response.json()) as {
      revision: string;
      destinations: string[];
    };
    assert.notEqual(saved.revision, initial.revision);
    assert.deepEqual(saved.destinations, ['other', 'updates']);
    assert.doesNotMatch(
      JSON.stringify(saved),
      /private-webhook-token|other-private-token|discord.com/,
    );
    const row = await db
      .prepare('SELECT * FROM relay_configuration')
      .first<{ feeds: string; encrypted_webhooks: string }>();
    assert.deepEqual(JSON.parse(row!.feeds), feeds);
    assert.match(row!.encrypted_webhooks, /^v1\./);
    assert.doesNotMatch(
      row!.encrypted_webhooks,
      /private-webhook-token|other-private-token|discord.com/,
    );
    assert.equal(
      (await db
        .prepare('SELECT baseline_id FROM relay_routes')
        .first<{ baseline_id: string }>())!.baseline_id,
      'existing',
    );
    assert.equal((await readRelayConfiguration(env)).webhooks.updates, secret);
    const changedEnvironment = {
      ...env,
      DISCORD_CLIENT_SECRET: 'rotated-secret',
    };
    assert.equal(
      (await readRelayConfiguration(changedEnvironment)).webhooks.updates,
      secret,
    );
    const reopened = await readAdminConfiguration(
      changedEnvironment,
      await configurationKey(key),
    );
    assert.equal(reopened.revision, saved.revision);
    assert.deepEqual(reopened.destinations, ['other', 'updates']);
    await assert.rejects(
      readRelayConfiguration({
        ...env,
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
      }),
      /Cannot read saved webhooks/,
    );
    await assert.rejects(
      readRelayConfiguration({ ...env, CONFIG_ENCRYPTION_KEY: '' }),
      /Configure CONFIG_ENCRYPTION_KEY/,
    );
  } finally {
    await dispose();
  }
});

test('webhook rotation, destination removal, and route edits preserve unedited secrets and validate every reference', async () => {
  const { env, db, dispose, handleAdmin, put } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    const cryptoKey = await configurationKey(key);
    let current = await readAdminConfiguration(env, cryptoKey);
    current = await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds,
      webhooks: { updates: secret, unused: other },
    });
    for (const invalid of [
      { feeds, webhooks: { updates: null } },
      { feeds, webhooks: { duplicate: secret } },
      { feeds, webhooks: { unused: 'https://example.com/private-token' } },
      {
        feeds: [{ url: 'https://example.com', destinations: ['missing'] }],
        webhooks: {},
      },
      {
        feeds: [
          { url: 'https://private.example/?secret=hidden', destinations: [] },
        ],
        webhooks: {},
      },
      { feeds, webhooks: { updates: false } },
      { feeds, webhooks: { 'invalid name': null } },
    ]) {
      const response = (await handleAdmin(
        put({ revision: current.revision, ...invalid }),
        env,
      ))!;
      assert.equal(response.status, 400);
      assert.doesNotMatch(
        await response.text(),
        /private-token|private-webhook-token|secret=hidden/,
      );
      assert.equal(
        (await readAdminConfiguration(env, cryptoKey)).revision,
        current.revision,
      );
    }
    const rotated = 'https://discord.com/api/webhooks/789/rotated-token';
    current = await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds,
      webhooks: { updates: rotated },
    });
    assert.equal((await readRelayConfiguration(env)).webhooks.updates, rotated);
    assert.deepEqual(current.destinations, ['unused', 'updates']);
    current = await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds: [],
      webhooks: { updates: null },
    });
    assert.deepEqual(current.feeds, []);
    assert.deepEqual(current.destinations, ['unused']);
    assert.deepEqual((await readRelayConfiguration(env)).feeds, []);
  } finally {
    await dispose();
  }
});

test('stale tabs, direct database edits, and concurrent first writes cannot overwrite newer configuration', async () => {
  const { env, db, dispose, handleAdmin, put } = await fixture();
  try {
    const cryptoKey = await configurationKey(key);
    const initial = await readAdminConfiguration(env, cryptoKey);
    const results = await Promise.all(
      [other, 'https://discord.com/api/webhooks/789/third-token'].map((value) =>
        handleAdmin(
          put({
            revision: initial.revision,
            feeds,
            webhooks: { updates: secret, added: value },
          }),
          env,
        ),
      ),
    );
    assert.deepEqual(
      results.map((response) => response!.status).sort(),
      [200, 409],
    );
    const beforeCli = await readAdminConfiguration(env, cryptoKey);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    assert.equal(
      (await handleAdmin(
        put({ revision: beforeCli.revision, feeds, webhooks: {} }),
        env,
      ))!.status,
      409,
    );
    assert.deepEqual((await readAdminConfiguration(env, cryptoKey)).feeds, []);
    const current = await readAdminConfiguration(env, cryptoKey);
    const concurrent = await Promise.all(
      ['first', 'second'].map((name) =>
        handleAdmin(
          put({
            revision: current.revision,
            feeds: [
              {
                url: `https://${name}.example/feed`,
                destinations: ['updates'],
              },
            ],
            webhooks: {},
          }),
          env,
        ),
      ),
    );
    assert.deepEqual(
      concurrent.map((response) => response!.status).sort(),
      [200, 409],
    );
  } finally {
    await dispose();
  }
});

test('mutations require a same-origin JSON request and enforce the body limit before parsing', async () => {
  const { env, dispose, handleAdmin, request, put } = await fixture();
  try {
    const current = await readAdminConfiguration(
      env,
      await configurationKey(key),
    );
    const body = { revision: current.revision, feeds, webhooks: {} };
    for (const origin of ['https://evil.example', 'null', '']) {
      assert.equal(
        (await handleAdmin(put(body, { Origin: origin }), env))!.status,
        403,
      );
    }
    assert.equal(
      (await handleAdmin(put(body, { 'Content-Type': 'text/plain' }), env))!
        .status,
      415,
    );
    assert.equal(
      (await handleAdmin(
        request('/admin/api/config', { method: 'DELETE' }),
        env,
      ))!.status,
      405,
    );
    assert.equal(
      (await handleAdmin(
        put(body, { 'Content-Length': String(128 * 1024 + 1) }),
        env,
      ))!.status,
      413,
    );
    assert.equal(
      (await handleAdmin(
        put({ ...body, padding: 'x'.repeat(128 * 1024) }),
        env,
      ))!.status,
      413,
    );
    const malformed = request('/admin/api/config', {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{secret-token',
    });
    const result = (await handleAdmin(malformed, env))!;
    assert.equal(result.status, 400);
    assert.doesNotMatch(await result.text(), /secret-token/);
    assert.equal(
      (await handleAdmin(put({ ...body, extra: 'ignored?' }), env))!.status,
      400,
    );
  } finally {
    await dispose();
  }
});

test(
  'configuration writes recheck expired membership evidence and local session expiry after a delayed body finishes',
  { timeout: 10_000 },
  async () => {
    for (const revoked of ['role', 'session']) {
      const { env, db, dispose, handleAdmin, request, setRoles } =
        await fixture();
      const reading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let pending: Promise<Response | null> | undefined;
      try {
        const cryptoKey = await configurationKey(key);
        const before = await readAdminConfiguration(env, cryptoKey);
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            revision: before.revision,
            feeds: [],
            webhooks: { updates: secret },
          }),
        );
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              reading.resolve();
              await release.promise;
              controller.enqueue(bytes);
              controller.close();
            },
          },
          { highWaterMark: 0 },
        );
        const init = {
          method: 'PUT',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: stream,
          duplex: 'half',
        };
        pending = handleAdmin(request('/admin/api/config', init));
        await Promise.race([
          reading.promise,
          pending.then(() => {
            throw new Error('Request finished before reading its body');
          }),
        ]);
        if (revoked === 'role') {
          setRoles([]);
          // The body outlives the cached membership window. Keep the local
          // session active so the final check must observe Discord's denial.
          await db
            .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
            .bind(Date.now() - 120_000)
            .run();
        } else {
          // Local revocation stays immediate even while membership is cached.
          await db.prepare('UPDATE admin_sessions SET expires_at_ms = 0').run();
        }
        release.resolve();
        const response = (await pending)!;
        assert.equal(response.status, revoked === 'role' ? 403 : 401);
        assert.equal(
          (await readAdminConfiguration(env, cryptoKey)).revision,
          before.revision,
        );
      } finally {
        release.resolve();
        await pending;
        await dispose();
      }
    }
  },
);

test('corrupt encrypted configuration fails closed without exposing the stored value', async () => {
  const { env, db, dispose, handleAdmin, request } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    await db
      .prepare('UPDATE relay_configuration SET encrypted_webhooks = ?')
      .bind('private-corrupt-ciphertext')
      .run();
    const response = (await handleAdmin(request(), env))!;
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      await response.text(),
      /private-corrupt-ciphertext|private-webhook-token/,
    );
    await assert.rejects(
      readRelayConfiguration(env),
      /Cannot read saved webhooks/,
    );
  } finally {
    await dispose();
  }
});

test('a database write during a configuration save is detected by the database compare-and-swap', async () => {
  const { env, db, dispose, handleAdmin, put } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    const initial = await readAdminConfiguration(
      env,
      await configurationKey(key),
    );
    let injected = false;
    const racingDb = {
      prepare(sql: string) {
        return new Proxy(db.prepare(sql), {
          get(statement, property) {
            if (
              property === 'first' &&
              sql.includes('FROM relay_configuration')
            )
              return async () => {
                const before = await statement.first();
                if (!injected) {
                  injected = true;
                  await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
                }
                return before;
              };
            const value = Reflect.get(statement, property);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      },
    } as D1Database;
    const response = (await handleAdmin(
      put({
        revision: initial.revision,
        feeds,
        webhooks: { updates: secret, other },
      }),
      { ...env, DB: racingDb },
    ))!;
    assert.ok(injected);
    assert.equal(response.status, 409);
    const row = await db
      .prepare('SELECT feeds, encrypted_webhooks FROM relay_configuration')
      .first<{ feeds: string; encrypted_webhooks: string | null }>();
    assert.equal(row!.feeds, '[]');
    assert.equal(
      row!.encrypted_webhooks,
      null,
      'the conflicting save writes neither feeds nor webhooks',
    );
  } finally {
    await dispose();
  }
});
