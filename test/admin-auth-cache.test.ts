import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import {
  configurationKey,
  readAdminConfiguration,
  saveAdminConfiguration,
} from '../src/admin-store.ts';
import { AuthError, handleAuth, requireAdmin } from '../src/admin-auth.ts';
import { createTestDatabase } from './helpers/d1.ts';
import {
  authEnv,
  browserLogin,
  cliLogin,
  discordFixture,
  TEST_ROLE_ID,
  TEST_USER_ID,
} from './helpers/auth.ts';

const origin = 'https://syndicord.example';
const ttl = 120_000;
const signed = (cookie: string) =>
  new Request(`${origin}/admin`, { headers: { Cookie: cookie } });
const bearer = (token: string) =>
  new Request(`${origin}/admin/api/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
const denied = (status: number) => (error: unknown) =>
  error instanceof AuthError && error.status === status;
const post = (path: string, body: unknown) =>
  new Request(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

for (const kind of ['browser', 'cli'] as const) {
  test(`${kind} permissions reuse the login check for a fixed two-minute window`, async (context) => {
    const { db, dispose } = await createTestDatabase();
    const env = authEnv(db);
    const options = { roles: [TEST_ROLE_ID], calls: [] as Request[] };
    const fetcher = discordFixture(options);
    try {
      const request =
        kind === 'browser'
          ? signed((await browserLogin(env, fetcher)).cookie)
          : bearer((await cliLogin(env, fetcher)).token);
      const checkedAt = (await db
        .prepare(
          'SELECT permissions_checked_at_ms FROM admin_sessions WHERE kind = ?',
        )
        .bind(kind)
        .first<number>('permissions_checked_at_ms'))!;
      const calls = options.calls.length;
      let now = checkedAt;
      context.mock.method(Date, 'now', () => now);
      options.roles = [];
      for (const elapsed of [0, 30_000, 119_999]) {
        now = checkedAt + elapsed;
        assert.equal((await requireAdmin(request, env, fetcher)).kind, kind);
        assert.equal(options.calls.length, calls);
        assert.equal(
          await db
            .prepare(
              'SELECT permissions_checked_at_ms FROM admin_sessions WHERE kind = ?',
            )
            .bind(kind)
            .first<number>('permissions_checked_at_ms'),
          checkedAt,
        );
      }
      now = checkedAt + ttl;
      await assert.rejects(requireAdmin(request, env, fetcher), denied(403));
      assert.equal(options.calls.length, calls + 1);
    } finally {
      context.mock.restoreAll();
      await dispose();
    }
  });
}

test('expired permissions never authorize through provider failure or extend the cooldown deadline', async (context) => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const options = { roles: [TEST_ROLE_ID], calls: [] as Request[] };
  const normal = discordFixture(options);
  try {
    const { cookie } = await browserLogin(env, normal);
    const checkedAt = (await db
      .prepare('SELECT permissions_checked_at_ms FROM admin_sessions')
      .first<number>('permissions_checked_at_ms'))!;
    let now = checkedAt + ttl;
    context.mock.method(Date, 'now', () => now);
    await assert.rejects(
      requireAdmin(
        signed(cookie),
        env,
        async () => new Response('private-provider-error', { status: 503 }),
      ),
      denied(503),
    );
    assert.equal(
      await db
        .prepare('SELECT permissions_checked_at_ms FROM admin_sessions')
        .first('permissions_checked_at_ms'),
      checkedAt,
    );
    let calls = 0;
    const limited: typeof fetch = async () => {
      calls++;
      return Response.json(
        { retry_after: 2.25, message: 'private-provider-error' },
        { status: 429 },
      );
    };
    await assert.rejects(
      requireAdmin(signed(cookie), env, limited),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal(error.retryAfter, 3);
        assert.match(error.message, /Wait 3 seconds/);
        assert.doesNotMatch(error.message, /private-provider-error/);
        return true;
      },
    );
    const deadline = now + 3000;
    now += 1000;
    await assert.rejects(
      requireAdmin(signed(cookie), env, limited),
      (error: unknown) => error instanceof AuthError && error.retryAfter === 2,
    );
    assert.equal(calls, 1);
    assert.equal(
      await db
        .prepare('SELECT retry_at_ms FROM admin_sessions')
        .first('retry_at_ms'),
      deadline,
    );
    now = deadline;
    options.roles = [];
    await assert.rejects(
      requireAdmin(signed(cookie), env, normal),
      denied(403),
    );
  } finally {
    context.mock.restoreAll();
    await dispose();
  }
});

test('malformed, future-dated, wrong-mode and legacy empty cache records require a provider check', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const options = { roles: [TEST_ROLE_ID], calls: [] as Request[] };
  const fetcher = discordFixture(options);
  try {
    const { cookie } = await browserLogin(env, fetcher);
    options.roles = [];
    const valid = JSON.stringify({
      mode: 'legacy',
      addFeeds: true,
      channels: [],
    });
    for (const [value, checkedAt] of [
      [null, null],
      ['{', Date.now()],
      [valid, Date.now() + 60_000],
      [
        JSON.stringify({ mode: 'scoped', addFeeds: true, channels: [] }),
        Date.now(),
      ],
      [
        JSON.stringify({ mode: 'legacy', addFeeds: false, channels: [] }),
        Date.now(),
      ],
      [
        JSON.stringify({
          mode: 'legacy',
          addFeeds: true,
          channels: [],
          unexpected: true,
        }),
        Date.now(),
      ],
      ['x'.repeat(128 * 1024 + 1), Date.now()],
    ] as const) {
      await db
        .prepare(
          'UPDATE admin_sessions SET permissions_json = ?, permissions_checked_at_ms = ?',
        )
        .bind(value, checkedAt)
        .run();
      const before = options.calls.length;
      await assert.rejects(
        requireAdmin(signed(cookie), env, fetcher),
        denied(403),
      );
      assert.equal(options.calls.length, before + 1);
    }
  } finally {
    await dispose();
  }
});

test('populated caches do not bypass policy changes, known expiry, logout, encryption key rotation or credential kind', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  try {
    for (const change of ['policy', 'expiry', 'logout', 'key', 'kind']) {
      const { cookie } = await browserLogin(env);
      let target = env;
      let request = signed(cookie);
      if (change === 'policy')
        target = { ...env, DISCORD_ROLE_ID: '100000000000000099' };
      if (change === 'expiry')
        await db.prepare('UPDATE admin_sessions SET expires_at_ms = 0').run();
      if (change === 'logout')
        await handleAuth(
          new Request(origin + '/admin/auth/logout', {
            method: 'POST',
            headers: { Cookie: cookie, Origin: origin },
          }),
          env,
        );
      if (change === 'key')
        target = {
          ...env,
          CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        };
      if (change === 'kind') request = bearer(cookie.split('=')[1]!);
      await assert.rejects(
        requireAdmin(request, target, async () => {
          throw new Error('Invalid local sessions must not call Discord');
        }),
        denied(401),
      );
    }
  } finally {
    await dispose();
  }
});

test('a successful refresh cannot recreate a session deleted while Discord responded', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const discord = discordFixture();
  try {
    const { cookie } = await browserLogin(env, discord);
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = 0')
      .run();
    await assert.rejects(
      requireAdmin(signed(cookie), env, async (input, init) => {
        const response = await discord(input, init);
        await db.prepare('DELETE FROM admin_sessions').run();
        return response;
      }),
      denied(401),
    );
    assert.equal(
      await db
        .prepare('SELECT COUNT(*) AS count FROM admin_sessions')
        .first('count'),
      0,
    );
  } finally {
    await dispose();
  }
});

test('a concurrent cooldown overrides a successful refresh without moving its deadline', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const discord = discordFixture();
  try {
    const { cookie } = await browserLogin(env, discord);
    await db
      .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = 0')
      .run();
    const deadline = Date.now() + 30_000;
    await assert.rejects(
      requireAdmin(signed(cookie), env, async (input, init) => {
        const response = await discord(input, init);
        await db
          .prepare('UPDATE admin_sessions SET retry_at_ms = ?')
          .bind(deadline)
          .run();
        return response;
      }),
      denied(429),
    );
    assert.equal(
      await db
        .prepare('SELECT retry_at_ms FROM admin_sessions')
        .first('retry_at_ms'),
      deadline,
    );
    assert.equal(
      await db
        .prepare('SELECT permissions_checked_at_ms FROM admin_sessions')
        .first('permissions_checked_at_ms'),
      0,
    );
  } finally {
    await dispose();
  }
});

test('CLI approval inherits the original browser evidence deadline instead of restarting two minutes', async (context) => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const options = { roles: [TEST_ROLE_ID], calls: [] as Request[] };
  const fetcher = discordFixture(options);
  try {
    const pending = (await (await handleAuth(
      post('/admin/auth/cli/start', {}),
      env,
      fetcher,
    ))!.json()) as {
      requestId: string;
      secret: string;
      verificationUri: string;
    };
    const { cookie } = await browserLogin(env, fetcher, pending.requestId);
    const checkedAt = (await db
      .prepare(
        "SELECT permissions_checked_at_ms FROM admin_sessions WHERE kind = 'browser'",
      )
      .first<number>('permissions_checked_at_ms'))!;
    let now = checkedAt + 119_000;
    context.mock.method(Date, 'now', () => now);
    const page = (await handleAuth(
      new Request(pending.verificationUri, { headers: { Cookie: cookie } }),
      env,
      fetcher,
    ))!;
    const approval = /name="approval" value="([A-Za-z0-9_-]+)"/.exec(
      await page.text(),
    )![1]!;
    const approved = (await handleAuth(
      new Request(origin + '/admin/auth/cli/approve', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          requestId: pending.requestId,
          approval,
          decision: 'approve',
        }),
      }),
      env,
      fetcher,
    ))!;
    assert.equal(approved.status, 200);
    const result = (await handleAuth(
      post('/admin/auth/cli/poll', pending),
      env,
      fetcher,
    ))!;
    assert.equal(result.status, 200);
    const token = ((await result.json()) as { token: string }).token;
    assert.equal(
      await db
        .prepare(
          "SELECT permissions_checked_at_ms FROM admin_sessions WHERE kind = 'cli'",
        )
        .first('permissions_checked_at_ms'),
      checkedAt,
    );
    options.roles = [];
    now = checkedAt + ttl;
    await assert.rejects(
      requireAdmin(bearer(token), env, fetcher),
      denied(403),
    );
  } finally {
    context.mock.restoreAll();
    await dispose();
  }
});

test('another browser account cannot inherit an existing successful cache', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const discord = discordFixture();
  try {
    const first = await browserLogin(env, discord);
    const otherId = '100000000000000099';
    const other: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === '/api/v10/users/@me')
        return Response.json({ id: otherId, username: 'Other user' });
      if (path.endsWith('/member'))
        return Response.json({ roles: [], user: { id: otherId } });
      return discord(input, init);
    };
    const second = await browserLogin(env, other);
    assert.equal(
      (await requireAdmin(signed(first.cookie), env, discord)).id,
      TEST_USER_ID,
    );
    await assert.rejects(
      requireAdmin(signed(second.cookie), env, other),
      denied(403),
    );
    assert.equal(
      await db
        .prepare(
          'SELECT permissions_json FROM admin_sessions WHERE user_id = ?',
        )
        .bind(otherId)
        .first('permissions_json'),
      null,
    );
  } finally {
    await dispose();
  }
});

for (const [name, header, body, expected] of [
  ['body only', null, JSON.stringify({ retry_after: 2.25 }), 3],
  ['longer body', '2', JSON.stringify({ retry_after: 7.1 }), 8],
  ['malformed body', '9', '{private-provider-error', 9],
  [
    'oversized body',
    '13',
    'private-provider-error' + 'x'.repeat(64 * 1024),
    13,
  ],
  ['no valid delay', null, JSON.stringify({ retry_after: -1 }), 60],
] as const) {
  test(`access-check rate limit uses a bounded safe delay for ${name}`, async () => {
    const { db, dispose } = await createTestDatabase();
    const env = authEnv(db);
    try {
      const { cookie } = await browserLogin(env);
      await db
        .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = 0')
        .run();
      await assert.rejects(
        requireAdmin(
          signed(cookie),
          env,
          async () =>
            new Response(body, {
              status: 429,
              headers: header ? { 'Retry-After': header } : {},
            }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.equal(error.status, 429);
          assert.equal(error.retryAfter, expected);
          assert.match(error.message, new RegExp(`Wait ${expected} seconds`));
          assert.doesNotMatch(error.message, /private-provider-error/);
          return true;
        },
      );
    } finally {
      await dispose();
    }
  });
}

test('permission-cache migration preserves populated old sessions and relay data', async (context) => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  const options = { calls: [] as Request[] };
  const fetcher = discordFixture(options);
  const fields =
    'token_hash, kind, user_id, user_name, encrypted_token, expires_at_ms, config_hash, retry_at_ms';
  const statements = (sql: string) =>
    sql
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
  try {
    const browser = await browserLogin(env, fetcher);
    const cli = await cliLogin(env, fetcher);
    const deadline = Date.now() + 30_000;
    await db
      .prepare(
        "UPDATE admin_sessions SET retry_at_ms = ? WHERE kind = 'browser'",
      )
      .bind(deadline)
      .run();
    const sessions = await db
      .prepare(`SELECT ${fields} FROM admin_sessions ORDER BY token_hash`)
      .all<Record<string, string | number>>();
    const key = await configurationKey(env.CONFIG_ENCRYPTION_KEY);
    const before = await readAdminConfiguration(env, key);
    await saveAdminConfiguration(env, key, {
      revision: before.revision,
      feeds: [
        {
          url: 'https://example.com/preserved-feed',
          destinations: ['updates'],
        },
      ],
      webhooks: {
        updates: 'https://discord.com/api/webhooks/123/private-preserved-token',
      },
    });
    await db
      .prepare(
        "INSERT INTO relay_routes(feed_url, destination, baseline_id, initialized_at_ms) VALUES ('https://example.com/preserved-feed', 'updates', 'baseline', 1)",
      )
      .run();
    const savedConfiguration = await db
      .prepare('SELECT * FROM relay_configuration')
      .all();
    const savedRoutes = await db.prepare('SELECT * FROM relay_routes').all();

    // Recreate the actual pre-cache table from its original migration, keeping
    // valid opaque credentials and encrypted tokens created by the login flow.
    const oldMigration = statements(
      await readFile(
        new NodeURL('../migrations/0005_discord_auth.sql', import.meta.url),
        'utf8',
      ),
    );
    await db.prepare('DROP TABLE admin_sessions').run();
    await db.batch(oldMigration.slice(0, 2).map((sql) => db.prepare(sql)));
    const insertOld = (row: Record<string, string | number>) =>
      db
        .prepare(
          `INSERT INTO admin_sessions (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...fields.split(', ').map((name) => row[name]));
    await db.batch(sessions.results.map(insertOld));
    const upgrade = statements(
      await readFile(
        new NodeURL(
          '../migrations/0007_session_permission_cache.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await db.batch(upgrade.map((sql) => db.prepare(sql)));
    assert.deepEqual(
      (
        await db
          .prepare(`SELECT ${fields} FROM admin_sessions ORDER BY token_hash`)
          .all()
      ).results,
      sessions.results,
    );
    const caches = (
      await db
        .prepare(
          'SELECT permissions_json, permissions_checked_at_ms FROM admin_sessions',
        )
        .all()
    ).results;
    assert.equal(caches.length, sessions.results.length);
    assert.ok(
      caches.every(
        (row) =>
          row.permissions_json === null &&
          row.permissions_checked_at_ms === null,
      ),
    );

    // An old Worker can still use the old INSERT column list after migration.
    const oldRow = sessions.results[0]!;
    await db
      .prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
      .bind(oldRow.token_hash)
      .run();
    await insertOld(oldRow).run();
    assert.equal(
      await db
        .prepare(
          'SELECT permissions_json FROM admin_sessions WHERE token_hash = ?',
        )
        .bind(oldRow.token_hash)
        .first('permissions_json'),
      null,
    );
    const count = options.calls.length;
    await assert.rejects(
      requireAdmin(signed(browser.cookie), env, fetcher),
      denied(429),
    );
    assert.equal(options.calls.length, count);
    assert.equal(
      await db
        .prepare(
          "SELECT retry_at_ms FROM admin_sessions WHERE kind = 'browser' LIMIT 1",
        )
        .first('retry_at_ms'),
      deadline,
    );
    context.mock.method(Date, 'now', () => deadline);
    assert.equal(
      (await requireAdmin(signed(browser.cookie), env, fetcher)).kind,
      'browser',
    );
    assert.equal(
      (await requireAdmin(bearer(cli.token), env, fetcher)).kind,
      'cli',
    );
    assert.equal(
      options.calls.length,
      count + 2,
      'old browser and CLI rows each refresh once',
    );
    assert.deepEqual(
      (await db.prepare('SELECT * FROM relay_configuration').all()).results,
      savedConfiguration.results,
    );
    assert.deepEqual(
      (await db.prepare('SELECT * FROM relay_routes').all()).results,
      savedRoutes.results,
    );
  } finally {
    context.mock.restoreAll();
    await dispose();
  }
});
