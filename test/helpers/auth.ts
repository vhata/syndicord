import assert from 'node:assert/strict';
import { authConfiguration, handleAuth } from '../../src/admin-auth.ts';
import type { AuthEnv, DiscordFetch } from '../../src/admin-auth.ts';

export const TEST_CLIENT_ID = '100000000000000001';
export const TEST_GUILD_ID = '100000000000000002';
export const TEST_ROLE_ID = '100000000000000003';
export const TEST_USER_ID = '100000000000000004';
export const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
export const TEST_DISCORD_TOKEN = 'private-discord-access-token';

export function authEnv(
  db: D1Database,
  origin = 'https://syndicord.example',
): AuthEnv {
  return {
    DB: db,
    CONFIG_ENCRYPTION_KEY: TEST_KEY,
    DISCORD_CLIENT_ID: TEST_CLIENT_ID,
    DISCORD_CLIENT_SECRET: 'private-discord-client-secret',
    DISCORD_REDIRECT_URI: `${origin}/admin/auth/callback`,
    DISCORD_GUILD_ID: TEST_GUILD_ID,
    DISCORD_ROLE_ID: TEST_ROLE_ID,
  };
}

export interface DiscordFixtureOptions {
  roles?: string[];
  status?: number;
  tokenStatus?: number;
  expiresIn?: number;
  name?: string;
  retryAfter?: string;
  calls?: Request[];
}

// Options are read on each request so tests can revoke a role after login.
export function discordFixture(
  options: DiscordFixtureOptions = {},
): DiscordFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    options.calls?.push(request.clone());
    const path = new URL(request.url).pathname;
    if (path === '/api/oauth2/token') {
      assert.equal(request.method, 'POST');
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('client_id'), TEST_CLIENT_ID);
      assert.equal(form.get('client_secret'), 'private-discord-client-secret');
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.match(form.get('code_verifier')!, /^[A-Za-z0-9_-]{43}$/);
      return Response.json(
        {
          access_token: TEST_DISCORD_TOKEN,
          token_type: 'Bearer',
          expires_in: options.expiresIn ?? 3600,
          scope: 'identify guilds.members.read',
        },
        {
          status: options.tokenStatus ?? 200,
          headers: { 'Retry-After': options.retryAfter ?? '2' },
        },
      );
    }
    assert.equal(
      request.headers.get('authorization'),
      `Bearer ${TEST_DISCORD_TOKEN}`,
    );
    if (path === '/api/v10/users/@me')
      return Response.json({
        id: TEST_USER_ID,
        username: 'fixture-user',
        global_name: options.name ?? 'Fixture User',
      });
    assert.equal(path, `/api/v10/users/@me/guilds/${TEST_GUILD_ID}/member`);
    return Response.json(
      { roles: options.roles ?? [TEST_ROLE_ID], user: { id: TEST_USER_ID } },
      {
        status: options.status ?? 200,
        headers: { 'Retry-After': options.retryAfter ?? '2' },
      },
    );
  };
}

export function responseCookie(response: Response, name: string) {
  const value = response.headers
    .getSetCookie()
    .find((part) => part.startsWith(`${name}=`));
  assert.ok(value, `Expected ${name} cookie`);
  return value.split(';')[0]!;
}

export async function browserLogin(
  env: AuthEnv,
  fetcher: DiscordFetch = discordFixture(),
  requestId?: string,
) {
  const config = authConfiguration(env)!;
  const prefix = config.origin.startsWith('https:') ? '__Host-' : '';
  const start = (await handleAuth(
    new Request(
      `${config.origin}/admin/auth/login${requestId ? `?request=${requestId}` : ''}`,
    ),
    env,
    fetcher,
  ))!;
  assert.equal(start.status, 303, await start.clone().text());
  const target = new URL(start.headers.get('location')!);
  const state = target.searchParams.get('state')!;
  const callback = new URL(config.redirectUri);
  callback.search = new URLSearchParams({
    state,
    code: 'fixture-authorization-code',
    iss: 'https://discord.com',
  }).toString();
  const response = (await handleAuth(
    new Request(callback, {
      headers: { Cookie: responseCookie(start, `${prefix}syndicord_oauth`) },
    }),
    env,
    fetcher,
  ))!;
  const cookie = responseCookie(response, `${prefix}syndicord_session`);
  return { cookie, response };
}

export async function cliLogin(
  env: AuthEnv,
  fetcher: DiscordFetch = discordFixture(),
) {
  const config = authConfiguration(env)!;
  const start = (await handleAuth(
    new Request(`${config.origin}/admin/auth/cli/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
    env,
    fetcher,
  ))!;
  assert.equal(start.status, 200, await start.clone().text());
  const pending = (await start.json()) as {
    requestId: string;
    secret: string;
    verificationUri: string;
  };
  const { cookie } = await browserLogin(env, fetcher, pending.requestId);
  const page = (await handleAuth(
    new Request(pending.verificationUri, { headers: { Cookie: cookie } }),
    env,
    fetcher,
  ))!;
  assert.equal(page.status, 200, await page.clone().text());
  const approval = /name="approval" value="([A-Za-z0-9_-]+)"/.exec(
    await page.text(),
  )![1]!;
  const approved = (await handleAuth(
    new Request(`${config.origin}/admin/auth/cli/approve`, {
      method: 'POST',
      headers: {
        Origin: config.origin,
        Cookie: cookie,
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
  assert.equal(approved.status, 200, await approved.clone().text());
  const response = (await handleAuth(
    new Request(`${config.origin}/admin/auth/cli/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: pending.requestId,
        secret: pending.secret,
      }),
    }),
    env,
    fetcher,
  ))!;
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as {
    token: string;
    expiresAt: number;
    user: { id: string; name: string };
  };
}
