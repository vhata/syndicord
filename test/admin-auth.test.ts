import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import test from 'node:test';
import * as oauth from 'oauth4webapi';
import {
  AuthError,
  authConfiguration,
  handleAuth,
  requireAdmin,
} from '../src/admin-auth.ts';
import type { AuthEnv, DiscordFetch } from '../src/admin-auth.ts';
import {
  configurationKey,
  readAdminConfiguration,
  readRelayConfiguration,
  saveAdminConfiguration,
} from '../src/admin-store.ts';
import { createTestDatabase } from './helpers/d1.ts';
import {
  authEnv,
  browserLogin,
  cliLogin,
  discordFixture,
  responseCookie,
  TEST_DISCORD_TOKEN,
  TEST_ROLE_ID,
  TEST_USER_ID,
} from './helpers/auth.ts';

const origin = 'https://syndicord.example';
function req(path: string, init: RequestInit = {}) {
  return new Request(origin + path, init);
}
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
function signed(cookie: string, path = '/admin') {
  return req(path, { headers: { Cookie: cookie } });
}
async function fixture() {
  const database = await createTestDatabase();
  return { ...database, env: authEnv(database.db) };
}
async function begin(env: AuthEnv, fetcher: DiscordFetch = discordFixture()) {
  const response = (await handleAuth(req('/admin/auth/login'), env, fetcher))!;
  assert.equal(response.status, 303, await response.clone().text());
  const target = new URL(response.headers.get('location')!);
  const cookie = responseCookie(response, '__Host-syndicord_oauth');
  const url = new URL('/admin/auth/callback', origin);
  url.search = new URLSearchParams({
    state: target.searchParams.get('state')!,
    code: 'private-authorization-code',
    iss: 'https://discord.com',
  }).toString();
  return { response, target, cookie, url };
}
function authError(status: number) {
  return (error: unknown) =>
    error instanceof AuthError && error.status === status;
}

test('missing or unsafe OAuth configuration disables authentication without changing relay data', async () => {
  const { env, db, dispose } = await fixture();
  try {
    for (const name of [
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'DISCORD_REDIRECT_URI',
      'DISCORD_GUILD_ID',
      'DISCORD_ROLE_ID',
      'CONFIG_ENCRYPTION_KEY',
    ] as const) {
      const changed = { ...env, [name]: '' };
      assert.equal(authConfiguration(changed), null);
      assert.equal(
        (await handleAuth(req('/admin/auth/login'), changed))!.status,
        503,
      );
    }
    for (const value of [
      'http://syndicord.example/admin/auth/callback',
      'https://u:p@syndicord.example/admin/auth/callback',
      'https://syndicord.example/admin/auth/callback?x=y',
      'https://syndicord.example/admin/auth/callback#secret',
      'https://syndicord.example/other',
    ])
      assert.equal(
        authConfiguration({ ...env, DISCORD_REDIRECT_URI: value }),
        null,
      );
    assert.ok(
      authConfiguration({
        ...env,
        DISCORD_REDIRECT_URI: 'http://127.0.0.1:8787/admin/auth/callback',
      }),
    );
    assert.equal(
      authConfiguration(env, new Request('https://other.example/admin')),
      null,
    );
    assert.equal(
      await db
        .prepare('SELECT COUNT(*) AS count FROM relay_configuration')
        .first('count'),
      0,
    );
    assert.equal(await handleAuth(req('/unknown'), env), null);
  } finally {
    await dispose();
  }
});

test('login uses exact scopes, S256 PKCE, cookie binding and one-time state; stores only hashed sessions and encrypted Discord tokens', async () => {
  const { env, db, dispose } = await fixture();
  const calls: Request[] = [];
  const fetcher = discordFixture({ calls });
  try {
    const start = await begin(env, fetcher);
    assert.equal(start.target.origin, 'https://discord.com');
    assert.equal(
      start.target.searchParams.get('scope'),
      'identify guilds.members.read',
    );
    assert.equal(start.target.searchParams.get('response_type'), 'code');
    assert.equal(
      start.target.searchParams.get('code_challenge_method'),
      'S256',
    );
    assert.equal(
      start.target.searchParams.get('redirect_uri'),
      env.DISCORD_REDIRECT_URI,
    );
    assert.match(
      start.response.headers.get('set-cookie')!,
      /HttpOnly; SameSite=Lax; Max-Age=600; Secure/,
    );
    assert.doesNotMatch(
      start.response.headers.get('location')!,
      /client_secret|private-discord/,
    );
    const callback = (await handleAuth(
      new Request(start.url, { headers: { Cookie: start.cookie } }),
      env,
      fetcher,
    ))!;
    assert.equal(callback.headers.get('location'), '/admin');
    const sessionCookie = responseCookie(callback, '__Host-syndicord_session');
    const tokenForm = new URLSearchParams(await calls[0]!.text());
    assert.equal(
      await oauth.calculatePKCECodeChallenge(tokenForm.get('code_verifier')!),
      start.target.searchParams.get('code_challenge'),
    );
    assert.equal(tokenForm.get('code'), 'private-authorization-code');
    const session = await db.prepare('SELECT * FROM admin_sessions').first<{
      token_hash: string;
      encrypted_token: string;
      expires_at_ms: number;
    }>();
    assert.ok(session);
    assert.notEqual(session.token_hash, sessionCookie.split('=')[1]);
    assert.doesNotMatch(JSON.stringify(session), /private-discord/);
    assert.ok(session.expires_at_ms <= Date.now() + 3600_000);
    const user = await requireAdmin(signed(sessionCookie), env, fetcher);
    assert.deepEqual(user, {
      id: TEST_USER_ID,
      name: 'Fixture User',
      kind: 'browser',
    });
    const replay = (await handleAuth(
      new Request(start.url, { headers: { Cookie: start.cookie } }),
      env,
      fetcher,
    ))!;
    assert.equal(replay.headers.get('location'), '/admin?auth=invalid');
    assert.equal(
      calls.filter((call) => new URL(call.url).pathname === '/api/oauth2/token')
        .length,
      1,
    );
  } finally {
    await dispose();
  }
});

test('callback rejects missing, wrong, duplicate, expired and replayed state without exchanging a code', async () => {
  const { env, db, dispose } = await fixture();
  const calls: Request[] = [];
  const fetcher = discordFixture({ calls });
  try {
    const start = await begin(env, fetcher);
    const wrong = new URL(start.url);
    wrong.searchParams.set('state', oauth.generateRandomState());
    const duplicate = new URL(start.url);
    duplicate.searchParams.append(
      'state',
      start.target.searchParams.get('state')!,
    );
    for (const [url, cookie] of [
      [start.url, ''],
      [wrong, start.cookie],
      [duplicate, start.cookie],
      [start.url, `${start.cookie}; ${start.cookie}`],
    ]) {
      const response = (await handleAuth(
        new Request(url!, { headers: { Cookie: String(cookie) } }),
        env,
        fetcher,
      ))!;
      assert.equal(response.headers.get('location'), '/admin?auth=invalid');
    }
    assert.equal(calls.length, 0);
    await db.prepare('UPDATE admin_oauth_requests SET expires_at_ms = 0').run();
    assert.equal(
      (await handleAuth(
        new Request(start.url, { headers: { Cookie: start.cookie } }),
        env,
        fetcher,
      ))!.headers.get('location'),
      '/admin?auth=invalid',
    );
    assert.equal(calls.length, 0);
  } finally {
    await dispose();
  }
});

test('denied consent, missing or wrong issuer, malformed responses and provider exchange failures never grant access', async () => {
  const { env, db, dispose } = await fixture();
  try {
    for (const kind of [
      'denied',
      'wrong-issuer',
      'missing-issuer',
      'duplicate-code',
      'bad-token',
      'server-failure',
      'network-failure',
      'rate-limited',
    ]) {
      const calls: Request[] = [];
      const fetcher: DiscordFetch =
        kind === 'network-failure'
          ? async () => {
              throw new Error(TEST_DISCORD_TOKEN);
            }
          : discordFixture({
              calls,
              tokenStatus:
                kind === 'bad-token'
                  ? 400
                  : kind === 'server-failure'
                    ? 500
                    : kind === 'rate-limited'
                      ? 429
                      : 200,
            });
      const start = await begin(env, fetcher);
      const url = new URL(start.url);
      if (kind === 'denied') {
        url.searchParams.delete('code');
        url.searchParams.set('error', 'access_denied');
        url.searchParams.set('error_description', TEST_DISCORD_TOKEN);
      }
      if (kind === 'wrong-issuer')
        url.searchParams.set('iss', 'https://evil.example');
      if (kind === 'missing-issuer') url.searchParams.delete('iss');
      if (kind === 'duplicate-code')
        url.searchParams.append('code', 'another-code');
      const response = (await handleAuth(
        new Request(url, { headers: { Cookie: start.cookie } }),
        env,
        fetcher,
      ))!;
      assert.match(
        response.headers.get('location')!,
        /^\/admin\?auth=(cancelled|invalid|expired|unavailable|rate_limited)$/,
      );
      assert.doesNotMatch(
        JSON.stringify([...response.headers]) + (await response.text()),
        /private-discord|evil.example|private-authorization/,
      );
      assert.equal(
        await db
          .prepare('SELECT COUNT(*) AS count FROM admin_sessions')
          .first('count'),
        0,
      );
      assert.equal(
        (await handleAuth(
          new Request(url, { headers: { Cookie: start.cookie } }),
          env,
          fetcher,
        ))!.headers.get('location'),
        '/admin?auth=invalid',
      );
    }
  } finally {
    await dispose();
  }
});

test('non-members and missing-role users retain only denied identity and cannot authorize reads or writes', async () => {
  const { env, dispose } = await fixture();
  try {
    for (const options of [{ roles: [] }, { status: 404 }, { status: 403 }]) {
      const fetcher = discordFixture(options);
      const { cookie, response } = await browserLogin(env, fetcher);
      assert.equal(response.headers.get('location'), '/admin?auth=denied');
      for (const path of ['/admin', '/admin/api/config'])
        await assert.rejects(
          requireAdmin(signed(cookie, path), env, fetcher),
          (error: unknown) =>
            error instanceof AuthError &&
            error.status === 403 &&
            error.user?.id === TEST_USER_ID,
        );
      const logout = (await handleAuth(
        req('/admin/auth/logout', {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin },
        }),
        env,
        fetcher,
      ))!;
      assert.equal(logout.headers.get('location'), '/admin');
    }
  } finally {
    await dispose();
  }
});

test('sessions are bounded, configuration-bound, invalidated by logout, and browser credentials cannot be used as CLI bearer credentials', async () => {
  const { env, db, dispose } = await fixture();
  const fetcher = discordFixture({ expiresIn: 30 * 86400 });
  try {
    const { cookie } = await browserLogin(env, fetcher);
    const expires = await db
      .prepare('SELECT expires_at_ms FROM admin_sessions')
      .first<number>('expires_at_ms');
    assert.ok(expires! <= Date.now() + 8 * 3600_000);
    for (const headers of [
      {},
      { Authorization: 'Basic YWRtaW46cGFzc3dvcmQ=' },
      { Cookie: `${cookie}; ${cookie}` },
      { Authorization: `Bearer ${cookie.split('=')[1]}` },
      { Cookie: cookie, Authorization: 'Bearer invalid' },
    ])
      await assert.rejects(
        requireAdmin(req('/admin', { headers }), env, fetcher),
        authError(401),
      );
    for (const changed of [
      { DISCORD_ROLE_ID: '100000000000000099' },
      { DISCORD_GUILD_ID: '100000000000000098' },
      { DISCORD_CLIENT_ID: '100000000000000097' },
      { DISCORD_CLIENT_SECRET: 'rotated' },
    ])
      await assert.rejects(
        requireAdmin(signed(cookie), { ...env, ...changed }, fetcher),
        authError(401),
      );
    for (const foreign of ['https://evil.example', 'null', ''])
      assert.equal(
        (await handleAuth(
          req('/admin/auth/logout', {
            method: 'POST',
            headers: { Cookie: cookie, Origin: foreign },
          }),
          env,
          fetcher,
        ))!.status,
        403,
      );
    assert.equal(
      (await handleAuth(signed(cookie, '/admin/auth/logout'), env, fetcher))!
        .status,
      405,
    );
    const logout = (await handleAuth(
      req('/admin/auth/logout', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin },
      }),
      env,
      fetcher,
    ))!;
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    await assert.rejects(
      requireAdmin(signed(cookie), env, fetcher),
      authError(401),
    );
    const next = await browserLogin(env, fetcher);
    await db.prepare('UPDATE admin_sessions SET expires_at_ms = 0').run();
    await assert.rejects(
      requireAdmin(signed(next.cookie), env, fetcher),
      authError(401),
    );
  } finally {
    await dispose();
  }
});

test('each access rechecks membership; role removal, revocation, malformed membership and Discord failures fail closed', async () => {
  const { env, db, dispose } = await fixture();
  const options: { roles: string[]; status: number } = {
    roles: [TEST_ROLE_ID],
    status: 200,
  };
  const fetcher = discordFixture(options);
  try {
    const { cookie } = await browserLogin(env, fetcher);
    await requireAdmin(signed(cookie), env, fetcher);
    options.roles = [];
    await assert.rejects(
      requireAdmin(signed(cookie), env, fetcher),
      authError(403),
    );
    options.roles = [TEST_ROLE_ID];
    options.status = 500;
    await assert.rejects(
      requireAdmin(signed(cookie), env, fetcher),
      authError(503),
    );
    await assert.rejects(
      requireAdmin(signed(cookie), env, async () =>
        Response.json({ roles: TEST_ROLE_ID }),
      ),
      authError(503),
    );
    await assert.rejects(
      requireAdmin(signed(cookie), env, async () =>
        Response.json({ roles: [TEST_ROLE_ID], user: { id: 'another-user' } }),
      ),
      authError(503),
    );
    options.status = 401;
    await assert.rejects(
      requireAdmin(signed(cookie), env, fetcher),
      authError(401),
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

test('Discord rate limits propagate Retry-After and prevent repeated membership calls during the cooldown', async () => {
  const { env, dispose } = await fixture();
  const options = { status: 200, retryAfter: '37', calls: [] as Request[] };
  const fetcher = discordFixture(options);
  try {
    const { cookie } = await browserLogin(env, fetcher);
    options.status = 429;
    await assert.rejects(
      requireAdmin(signed(cookie), env, fetcher),
      (error: unknown) => error instanceof AuthError && error.retryAfter === 37,
    );
    const count = options.calls.length;
    await assert.rejects(
      requireAdmin(signed(cookie), env, fetcher),
      authError(429),
    );
    assert.equal(options.calls.length, count);
    const path = '/admin/auth/cli?request=' + oauth.generateRandomState();
    assert.equal(
      (await handleAuth(signed(cookie, path), env, fetcher))!.status,
      410,
    );
  } finally {
    await dispose();
  }
});

for (const kind of ['browser', 'cli'] as const)
  test(`cached Discord cooldown retains its deadline for ${kind} sessions`, async (context) => {
    const { env, db, dispose } = await fixture();
    const options = { status: 200, retryAfter: '2', calls: [] as Request[] };
    const fetcher = discordFixture(options);
    try {
      const request =
        kind === 'browser'
          ? signed((await browserLogin(env, fetcher)).cookie)
          : req('/admin', {
              headers: {
                Authorization: `Bearer ${(await cliLogin(env, fetcher)).token}`,
              },
            });
      const started = Date.now();
      let now = started;
      context.mock.method(Date, 'now', () => now);
      const deadline = () =>
        db
          .prepare('SELECT retry_at_ms FROM admin_sessions WHERE kind = ?')
          .bind(kind)
          .first<number>('retry_at_ms');
      const limited = (seconds: number) => (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfter, seconds);
        assert.deepEqual(error.user, {
          id: TEST_USER_ID,
          name: 'Fixture User',
        });
        return true;
      };

      options.status = 429;
      await assert.rejects(requireAdmin(request, env, fetcher), limited(2));
      assert.equal(await deadline(), started + 2000);
      const calls = options.calls.length;
      options.status = 200;
      for (const [elapsed, seconds] of [
        [500, 2],
        [1000, 1],
        [1500, 1],
        [1999, 1],
      ] as const) {
        now = started + elapsed;
        await assert.rejects(
          requireAdmin(request, env, fetcher),
          limited(seconds),
        );
        assert.equal(await deadline(), started + 2000);
        assert.equal(options.calls.length, calls);
      }

      now = started + 2000;
      assert.equal((await requireAdmin(request, env, fetcher)).kind, kind);
      assert.equal(options.calls.length, calls + 1);

      now += 100;
      options.status = 429;
      options.retryAfter = '3';
      await assert.rejects(requireAdmin(request, env, fetcher), limited(3));
      assert.equal(await deadline(), now + 3000);
      assert.equal(options.calls.length, calls + 2);
    } finally {
      context.mock.restoreAll();
      await dispose();
    }
  });

test('CLI browser approval issues a separate opaque application token under the same role checks and logout invalidates it', async () => {
  const { env, dispose } = await fixture();
  const options = { roles: [TEST_ROLE_ID] };
  const fetcher = discordFixture(options);
  try {
    const session = await cliLogin(env, fetcher);
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(JSON.stringify(session), /private-discord/);
    const request = req('/admin/api/config', {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal((await requireAdmin(request, env, fetcher)).kind, 'cli');
    await assert.rejects(
      requireAdmin(
        signed(`__Host-syndicord_session=${session.token}`),
        env,
        fetcher,
      ),
      authError(401),
    );
    options.roles = [];
    await assert.rejects(requireAdmin(request, env, fetcher), authError(403));
    const logout = (await handleAuth(
      post(
        '/admin/auth/logout',
        {},
        { Authorization: `Bearer ${session.token}` },
      ),
      env,
      fetcher,
    ))!;
    assert.equal(logout.status, 200);
    await assert.rejects(requireAdmin(request, env, fetcher), authError(401));
  } finally {
    await dispose();
  }
});

test('CLI grants require explicit same-origin browser approval and the matching poll secret; approval and polling are single-use', async () => {
  const { env, db, dispose } = await fixture();
  const fetcher = discordFixture();
  try {
    const started = (await handleAuth(
      post('/admin/auth/cli/start', {}),
      env,
      fetcher,
    ))!;
    const pending = (await started.json()) as {
      requestId: string;
      secret: string;
      verificationUri: string;
      userCode: string;
    };
    assert.match(pending.userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
    const poll = () =>
      handleAuth(
        post('/admin/auth/cli/poll', {
          requestId: pending.requestId,
          secret: pending.secret,
        }),
        env,
        fetcher,
      );
    assert.equal((await poll())!.status, 202);
    assert.equal((await poll())!.status, 429);
    const { cookie } = await browserLogin(env, fetcher, pending.requestId);
    const page = (await handleAuth(
      new Request(pending.verificationUri, { headers: { Cookie: cookie } }),
      env,
      fetcher,
    ))!;
    const html = await page.text();
    assert.match(html, /Only approve if you started/);
    assert.doesNotMatch(html, new RegExp(pending.secret));
    const approval = /name="approval" value="([A-Za-z0-9_-]+)"/.exec(html)![1]!;
    const anotherBrowser = await browserLogin(env, fetcher);
    const form = (originValue: string, approvalValue = approval) =>
      req('/admin/auth/cli/approve', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: originValue,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          requestId: pending.requestId,
          approval: approvalValue,
          decision: 'approve',
        }),
      });
    assert.equal(
      (await handleAuth(form('https://evil.example'), env, fetcher))!.status,
      403,
    );
    assert.equal(
      (await handleAuth(
        form(origin, oauth.generateRandomState()),
        env,
        fetcher,
      ))!.status,
      410,
    );
    assert.equal(
      (await handleAuth(
        post('/admin/auth/cli/poll', {
          requestId: pending.requestId,
          secret: oauth.generateRandomState(),
        }),
        env,
        fetcher,
      ))!.status,
      401,
    );
    const stolenForm = form(origin);
    stolenForm.headers.set('Cookie', anotherBrowser.cookie);
    assert.equal((await handleAuth(stolenForm, env, fetcher))!.status, 410);
    assert.equal((await handleAuth(form(origin), env, fetcher))!.status, 200);
    assert.equal((await handleAuth(form(origin), env, fetcher))!.status, 410);
    await db.prepare('UPDATE admin_cli_requests SET poll_after_ms = 0').run();
    const concurrent = await Promise.all([poll(), poll()]);
    assert.equal(
      concurrent.filter((result) => result!.status === 200).length,
      1,
    );
    assert.ok(
      concurrent.some((result) => [401, 410, 429].includes(result!.status)),
    );
    assert.equal((await poll())!.status, 410);
  } finally {
    await dispose();
  }
});

test('pending CLI requests expire and cross-site JSON requests are rejected', async () => {
  const { env, db, dispose } = await fixture();
  const fetcher = discordFixture();
  try {
    for (const path of ['/admin/auth/cli/start', '/admin/auth/cli/poll'])
      assert.equal(
        (await handleAuth(
          post(path, {}, { Origin: 'https://evil.example' }),
          env,
          fetcher,
        ))!.status,
        403,
      );
    assert.equal(
      (await handleAuth(
        req('/admin/auth/cli/start', { method: 'POST', body: '{}' }),
        env,
        fetcher,
      ))!.status,
      415,
    );
    const pending = (await (await handleAuth(
      post('/admin/auth/cli/start', {}),
      env,
      fetcher,
    ))!.json()) as { requestId: string; secret: string };
    await db.prepare('UPDATE admin_cli_requests SET expires_at_ms = 0').run();
    assert.equal(
      (await handleAuth(post('/admin/auth/cli/poll', pending), env, fetcher))!
        .status,
      410,
    );
    assert.equal(
      (await handleAuth(
        req(`/admin/auth/login?request=${pending.requestId}`),
        env,
        fetcher,
      ))!.status,
      410,
    );
    assert.equal(
      (await handleAuth(req('/admin/auth/unknown'), env, fetcher))!.status,
      404,
    );
  } finally {
    await dispose();
  }
});

test('HTTP loopback authentication uses its own HttpOnly cookie names and cannot be enabled on remote HTTP', async () => {
  const { db, dispose } = await fixture();
  try {
    const env = authEnv(db, 'http://127.0.0.1:8787');
    const { cookie, response } = await browserLogin(env);
    assert.match(cookie, /^syndicord_session=/);
    assert.match(
      response.headers
        .getSetCookie()
        .find((part) => part.startsWith('syndicord_session='))!,
      /HttpOnly; SameSite=Lax/,
    );
    assert.equal(
      (
        await requireAdmin(
          new Request('http://127.0.0.1:8787/admin', {
            headers: { Cookie: cookie },
          }),
          env,
          discordFixture(),
        )
      ).id,
      TEST_USER_ID,
    );
    assert.equal(
      authConfiguration(authEnv(db, 'http://syndicord.example')),
      null,
    );
  } finally {
    await dispose();
  }
});

test('concurrent callbacks exchange an authorization code only once', async () => {
  const { env, db, dispose } = await fixture();
  const calls: Request[] = [];
  const fetcher = discordFixture({ calls });
  try {
    const start = await begin(env, fetcher);
    const callbacks = await Promise.all(
      [1, 2].map(() =>
        handleAuth(
          new Request(start.url, { headers: { Cookie: start.cookie } }),
          env,
          fetcher,
        ),
      ),
    );
    assert.deepEqual(
      callbacks.map((result) => result!.headers.get('location')).sort(),
      ['/admin', '/admin?auth=invalid'],
    );
    assert.equal(
      calls.filter((request) => request.url.endsWith('/oauth2/token')).length,
      1,
    );
    assert.equal(
      await db
        .prepare('SELECT COUNT(*) AS count FROM admin_sessions')
        .first('count'),
      1,
    );
  } finally {
    await dispose();
  }
});

test('failed CLI consent ends its terminal request and a validated failed account switch invalidates the old session', async () => {
  const { env, db, dispose } = await fixture();
  const fetcher = discordFixture();
  try {
    const original = await browserLogin(env, fetcher);
    const pending = (await (await handleAuth(
      post('/admin/auth/cli/start', {}),
      env,
      fetcher,
    ))!.json()) as { requestId: string; secret: string };
    const started = (await handleAuth(
      signed(original.cookie, `/admin/auth/login?request=${pending.requestId}`),
      env,
      fetcher,
    ))!;
    const target = new URL(started.headers.get('location')!);
    const callback = new URL(env.DISCORD_REDIRECT_URI!);
    callback.search = new URLSearchParams({
      state: target.searchParams.get('state')!,
      error: 'access_denied',
      iss: 'https://discord.com',
    }).toString();
    const cookie = `${responseCookie(started, '__Host-syndicord_oauth')}; ${original.cookie}`;
    const forged = await handleAuth(new Request(callback), env, fetcher);
    assert.equal(forged!.headers.get('location'), '/admin?auth=invalid');
    assert.equal(
      await db.prepare('SELECT status FROM admin_cli_requests').first('status'),
      'pending',
    );
    await requireAdmin(signed(original.cookie), env, fetcher);
    const denied = (await handleAuth(
      new Request(callback, { headers: { Cookie: cookie } }),
      env,
      fetcher,
    ))!;
    assert.equal(denied.headers.get('location'), '/admin?auth=cancelled');
    assert.ok(
      denied.headers
        .getSetCookie()
        .some(
          (part) =>
            part.startsWith('__Host-syndicord_session=;') &&
            part.includes('Max-Age=0'),
        ),
    );
    await assert.rejects(
      requireAdmin(signed(original.cookie), env, fetcher),
      authError(401),
    );
    assert.equal(
      (await handleAuth(post('/admin/auth/cli/poll', pending), env, fetcher))!
        .status,
      403,
    );
  } finally {
    await dispose();
  }
});

test('CLI approval denial offers identity, logout and account recovery and stops terminal polling', async () => {
  const { env, dispose } = await fixture();
  const options = { roles: [TEST_ROLE_ID] };
  const fetcher = discordFixture(options);
  try {
    const { cookie } = await browserLogin(env, fetcher);
    const pending = (await (await handleAuth(
      post('/admin/auth/cli/start', {}),
      env,
      fetcher,
    ))!.json()) as {
      requestId: string;
      secret: string;
      verificationUri: string;
    };
    options.roles = [];
    const page = (await handleAuth(
      new Request(pending.verificationUri, { headers: { Cookie: cookie } }),
      env,
      fetcher,
    ))!;
    assert.equal(page.status, 403);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    const html = await page.text();
    assert.match(html, /Fixture User/);
    assert.match(html, /Sign out/);
    assert.match(html, /Try another Discord account/);
    assert.match(html, /syndicord login/);
    assert.equal(
      (await handleAuth(post('/admin/auth/cli/poll', pending), env, fetcher))!
        .status,
      403,
    );
  } finally {
    await dispose();
  }
});

test('Discord redirects and oversized responses fail closed without following or exposing provider content', async () => {
  const { env, dispose } = await fixture();
  try {
    const { cookie } = await browserLogin(env);
    for (const response of [
      new Response('', {
        status: 302,
        headers: { Location: 'https://evil.example/private-token' },
      }),
      new Response('private-token' + 'x'.repeat(64 * 1024)),
      new Response('private-token', {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      let calls = 0;
      const fetcher: DiscordFetch = async (_input, init) => {
        calls++;
        assert.equal(init?.redirect, 'manual');
        return response;
      };
      await assert.rejects(
        requireAdmin(signed(cookie), env, fetcher),
        (error: unknown) =>
          error instanceof AuthError &&
          error.status === 503 &&
          !error.message.includes('private-token'),
      );
      assert.equal(calls, 1);
    }
  } finally {
    await dispose();
  }
});

test('the Discord timeout cancels a stalled response body and never authorizes access', async (context) => {
  const { env, dispose } = await fixture();
  let cancelled = false;
  try {
    const { cookie } = await browserLogin(env);
    let fetched!: () => void;
    const ready = new Promise<void>((resolve) => {
      fetched = resolve;
    });
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const check = requireAdmin(signed(cookie), env, async () => {
      fetched();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"roles":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const rejected = assert.rejects(check, authError(503));
    await ready;
    context.mock.timers.tick(10_000);
    await rejected;
    assert.ok(cancelled);
  } finally {
    context.mock.timers.reset();
    await dispose();
  }
});

test('the authentication migration preserves saved feeds, encrypted webhooks, revision and delivery ledger', async () => {
  const { env, db, dispose } = await fixture();
  try {
    await db.batch(
      ['admin_sessions', 'admin_oauth_requests', 'admin_cli_requests'].map(
        (table) => db.prepare(`DROP TABLE ${table}`),
      ),
    );
    const key = await configurationKey(env.CONFIG_ENCRYPTION_KEY);
    const original = await readAdminConfiguration(env, key);
    const feed = 'https://example.com/feed.xml';
    const webhook = 'https://discord.com/api/webhooks/123/preserved-webhook';
    const saved = await saveAdminConfiguration(env, key, {
      revision: original.revision,
      feeds: [{ url: feed, destinations: ['updates'] }],
      webhooks: { updates: webhook },
    });
    await db
      .prepare(
        "INSERT INTO relay_routes(feed_url,destination,baseline_id,initialized_at_ms) VALUES (?,'updates','baseline',1)",
      )
      .bind(feed)
      .run();
    await db
      .prepare(
        "INSERT INTO relay_deliveries(feed_url,destination,entry_id,state,first_seen_ms,next_attempt_ms) VALUES (?,'updates','entry','sent',2,3)",
      )
      .bind(feed)
      .run();
    const beforeConfig = await db
      .prepare('SELECT * FROM relay_configuration')
      .first();
    const beforeLedger = await db
      .prepare('SELECT * FROM relay_deliveries')
      .first();
    const migration = await readFile(
      new NodeURL('../migrations/0005_discord_auth.sql', import.meta.url),
      'utf8',
    );
    await db.batch(
      migration
        .split(';')
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => db.prepare(sql)),
    );
    assert.deepEqual(
      await db.prepare('SELECT * FROM relay_configuration').first(),
      beforeConfig,
    );
    assert.deepEqual(
      await db.prepare('SELECT * FROM relay_deliveries').first(),
      beforeLedger,
    );
    assert.equal(
      (await readAdminConfiguration(env, key)).revision,
      saved.revision,
    );
    assert.equal((await readRelayConfiguration(env)).webhooks.updates, webhook);
    const { cookie } = await browserLogin(env);
    await requireAdmin(signed(cookie), env, discordFixture());
  } finally {
    await dispose();
  }
});

test('CLI form pages preserve same-origin POST Origin while OAuth redirects suppress referrers', async () => {
  const { env, dispose } = await fixture();
  try {
    const started = (await handleAuth(post('/admin/auth/cli/start', {}), env))!;
    const pending = (await started.json()) as {
      requestId: string;
      verificationUri: string;
    };
    const signedOut = (await handleAuth(
      new Request(pending.verificationUri),
      env,
    ))!;
    assert.equal(signedOut.headers.get('referrer-policy'), 'same-origin');
    const login = await begin(env);
    assert.equal(login.response.headers.get('referrer-policy'), 'no-referrer');
    const { cookie, response } = await browserLogin(env);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const approval = (await handleAuth(
      new Request(pending.verificationUri, { headers: { Cookie: cookie } }),
      env,
      discordFixture(),
    ))!;
    assert.equal(approval.headers.get('referrer-policy'), 'same-origin');
    assert.match(await approval.text(), /method="post"/);
  } finally {
    await dispose();
  }
});

test('CLI approval POST handles role removal, session expiry and Discord failures without a JSON dead end or forged denial', async () => {
  const { env, db, dispose } = await fixture();
  const options = {
    roles: [TEST_ROLE_ID],
    status: 200,
    calls: [] as Request[],
  };
  const fetcher = discordFixture(options);
  try {
    for (const failure of ['role', 'expired', 'revoked', 'provider', 'rate']) {
      options.roles = [TEST_ROLE_ID];
      options.status = 200;
      const pending = (await (await handleAuth(
        post('/admin/auth/cli/start', {}),
        env,
        fetcher,
      ))!.json()) as {
        requestId: string;
        secret: string;
        verificationUri: string;
      };
      const { cookie } = await browserLogin(env, fetcher);
      const page = (await handleAuth(
        new Request(pending.verificationUri, { headers: { Cookie: cookie } }),
        env,
        fetcher,
      ))!;
      const approval = /name="approval" value="([A-Za-z0-9_-]+)"/.exec(
        await page.text(),
      )![1]!;
      if (failure === 'role') options.roles = [];
      if (failure === 'expired')
        await db.prepare('UPDATE admin_sessions SET expires_at_ms = 0').run();
      if (failure === 'revoked') options.status = 401;
      if (failure === 'provider') options.status = 500;
      if (failure === 'rate') options.status = 429;
      const form = (nonce: string) =>
        req('/admin/auth/cli/approve', {
          method: 'POST',
          headers: {
            Origin: origin,
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            requestId: pending.requestId,
            approval: nonce,
            decision: 'approve',
          }),
        });
      const before = options.calls.length;
      assert.equal(
        (await handleAuth(form(oauth.generateRandomState()), env, fetcher))!
          .status,
        410,
      );
      assert.equal(
        options.calls.length,
        before,
        'a forged form must not query Discord or cancel a terminal request',
      );
      assert.equal(
        await db
          .prepare('SELECT status FROM admin_cli_requests WHERE request_id = ?')
          .bind(pending.requestId)
          .first('status'),
        'pending',
      );
      const result = (await handleAuth(form(approval), env, fetcher))!;
      const expected =
        failure === 'role'
          ? 403
          : failure === 'provider'
            ? 503
            : failure === 'rate'
              ? 429
              : 401;
      assert.equal(result.status, expected);
      assert.match(result.headers.get('content-type')!, /text\/html/);
      assert.equal(result.headers.get('referrer-policy'), 'same-origin');
      const html = await result.text();
      assert.match(html, /Sign out/);
      assert.match(
        html,
        failure === 'provider' || failure === 'rate'
          ? /Try again/
          : /Try another Discord account/,
      );
      assert.doesNotMatch(html, /private-discord/);
      const poll = (await handleAuth(
        post('/admin/auth/cli/poll', {
          requestId: pending.requestId,
          secret: pending.secret,
        }),
        env,
        fetcher,
      ))!;
      assert.equal(
        poll.status,
        failure === 'provider' || failure === 'rate' ? 202 : 403,
      );
    }
  } finally {
    await dispose();
  }
});
