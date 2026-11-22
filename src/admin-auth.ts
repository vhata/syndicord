import * as oauth from 'oauth4webapi';
import { AdminError, configurationKey } from './admin-store.ts';
import type { ConfigurationEnv } from './admin-store.ts';

export interface AuthEnv extends ConfigurationEnv {
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_ROLE_ID?: string;
}

export interface AuthConfiguration {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  origin: string;
  guildId: string;
  roleId: string;
}

export interface AdminIdentity {
  id: string;
  name: string;
  kind: 'browser' | 'cli';
}

export class AuthError extends AdminError {
  user?: { id: string; name: string };
  retryAfter?: number;
}

export type DiscordFetch = typeof fetch;

interface Session {
  token_hash: string;
  kind: 'browser' | 'cli';
  user_id: string;
  user_name: string;
  encrypted_token: string;
  expires_at_ms: number;
  config_hash: string;
  retry_at_ms: number;
}

interface OAuthRequest {
  verifier: string;
  cli_request_id: string | null;
}

interface CliRequest {
  request_id: string;
  user_code: string;
  status: 'pending' | 'approved' | 'denied';
  session_hash: string | null;
  expires_at_ms: number;
  poll_after_ms: number;
}

const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[1-9][0-9]{16,19}$/;
const encoder = new TextEncoder();
const server: oauth.AuthorizationServer = {
  issuer: 'https://discord.com',
  authorization_endpoint: 'https://discord.com/oauth2/authorize',
  token_endpoint: 'https://discord.com/api/oauth2/token',
  authorization_response_iss_parameter_supported: true,
};

export function authConfiguration(
  env: AuthEnv,
  request?: Request,
): AuthConfiguration | null {
  if (
    !ID_PATTERN.test(env.DISCORD_CLIENT_ID ?? '') ||
    !ID_PATTERN.test(env.DISCORD_GUILD_ID ?? '') ||
    !ID_PATTERN.test(env.DISCORD_ROLE_ID ?? '') ||
    !env.DISCORD_CLIENT_SECRET ||
    !env.CONFIG_ENCRYPTION_KEY ||
    !env.DISCORD_REDIRECT_URI
  )
    return null;
  try {
    const callback = new URL(env.DISCORD_REDIRECT_URI);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
      callback.hostname,
    );
    if (
      callback.href !== env.DISCORD_REDIRECT_URI ||
      (callback.protocol !== 'https:' &&
        !(loopback && callback.protocol === 'http:')) ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      callback.pathname !== '/admin/auth/callback' ||
      (request && new URL(request.url).origin !== callback.origin)
    )
      return null;
    return {
      clientId: env.DISCORD_CLIENT_ID!,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      redirectUri: callback.href,
      origin: callback.origin,
      guildId: env.DISCORD_GUILD_ID!,
      roleId: env.DISCORD_ROLE_ID!,
    };
  } catch {
    return null;
  }
}

function configured(env: AuthEnv, request: Request) {
  const config = authConfiguration(env, request);
  if (!config) throw new AuthError('Administration is not configured.', 503);
  return config;
}

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function unbase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function digest(value: string) {
  return base64(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
}

async function configurationHash(config: AuthConfiguration) {
  return digest(JSON.stringify(config));
}

function random() {
  return oauth.generateRandomState();
}

function cookieName(config: AuthConfiguration, kind: 'session' | 'oauth') {
  return `${config.origin.startsWith('https:') ? '__Host-' : ''}syndicord_${kind}`;
}

function cookie(
  config: AuthConfiguration,
  kind: 'session' | 'oauth',
  value: string,
  seconds: number,
) {
  return `${cookieName(config, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(seconds))}${config.origin.startsWith('https:') ? '; Secure' : ''}`;
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get('cookie') ?? '';
  if (cookies.length > 8192) return null;
  const matches = cookies
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}

function credential(request: Request, config: AuthConfiguration) {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    return match ? { token: match[1]!, kind: 'cli' as const } : null;
  }
  const token = cookieValue(request, cookieName(config, 'session'));
  return token ? { token, kind: 'browser' as const } : null;
}

async function seal(token: string, key: CryptoKey, tokenHash: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(`syndicord-oauth-v1:${tokenHash}`),
    },
    key,
    encoder.encode(token),
  );
  return `${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}

async function open(session: Session, key: CryptoKey) {
  try {
    const [iv, ciphertext, extra] = session.encrypted_token.split('.');
    if (!iv || !ciphertext || extra) throw new Error();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: unbase64(iv),
          additionalData: encoder.encode(
            `syndicord-oauth-v1:${session.token_hash}`,
          ),
        },
        key,
        unbase64(ciphertext),
      ),
    );
  } catch {
    throw new AuthError(
      'Your session is no longer valid. Sign in with Discord again.',
      401,
    );
  }
}

function response(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit = {},
) {
  const result = new Response(body, { status, headers });
  result.headers.set('Cache-Control', 'no-store');
  if (!result.headers.has('Referrer-Policy'))
    result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  return result;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  const result = response(JSON.stringify(body), status, headers);
  result.headers.set('Content-Type', 'application/json; charset=utf-8');
  return result;
}

function redirect(location: string, cookies: string[] = []) {
  const result = response(null, 303, { Location: location });
  for (const value of cookies) result.headers.append('Set-Cookie', value);
  return result;
}

function sameOrigin(
  request: Request,
  config: AuthConfiguration,
  optional = false,
) {
  const origin = request.headers.get('origin');
  if ((origin !== null || !optional) && origin !== config.origin)
    throw new AuthError('This action must come from this syndicord site.', 403);
  if (request.headers.get('sec-fetch-site') === 'cross-site')
    throw new AuthError('This action must come from this syndicord site.', 403);
}

async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  signal?: AbortSignal,
) {
  if (!body) throw new AuthError('The request was incomplete.', 400);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request timed out');
      const part = await reader.read();
      if (signal?.aborted) throw new Error('Request timed out');
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new AuthError('The request was too large.', 413);
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    bytes,
  );
}

async function jsonBody(request: Request) {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  )
    throw new AuthError('Use application/json for this request.', 415);
  try {
    const result: unknown = JSON.parse(await boundedText(request.body, 4096));
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error();
    return result as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError('Provide a valid JSON request.', 400);
  }
}

function retryError(value: string | null) {
  const seconds = Number(value);
  const error = new AuthError(
    'Discord is rate limiting access checks. Wait and try again.',
    429,
  );
  error.retryAfter =
    Number.isFinite(seconds) && seconds > 0
      ? Math.min(3600, Math.max(1, Math.ceil(seconds)))
      : 60;
  return error;
}

// Buffer bounded responses while the timeout is active. Neither provider response
// bodies nor thrown provider errors are included in client responses or logs.
async function discordRequest(
  fetcher: DiscordFetch,
  url: string,
  init: RequestInit,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const result = await fetcher(url, {
      ...init,
      // workerd supports manual/follow, not the browser's error mode.
      redirect: 'manual',
      signal: controller.signal,
    });
    if (result.status >= 300 && result.status < 400) {
      await result.body?.cancel();
      throw new Error('Unexpected Discord redirect');
    }
    if (result.status === 429) {
      await result.body?.cancel();
      throw retryError(result.headers.get('retry-after'));
    }
    const text = await boundedText(result.body, 64 * 1024, controller.signal);
    return new Response(text, {
      status: result.status,
      headers: result.headers,
    });
  } catch (error) {
    if (error instanceof AuthError && error.status === 429) throw error;
    throw new AuthError('Discord is unavailable. Try again shortly.', 503);
  } finally {
    clearTimeout(timeout);
  }
}

async function discordJson(fetcher: DiscordFetch, path: string, token: string) {
  const result = await discordRequest(
    fetcher,
    `https://discord.com/api/v10${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (result.status === 401)
    throw new AuthError(
      'Your Discord authorization expired or was revoked. Sign in again.',
      401,
    );
  if (result.status === 403 || result.status === 404)
    throw new AuthError(
      'You must belong to the configured Discord server and have its required role. Ask a server administrator for access, or try another account.',
      403,
    );
  if (!result.ok)
    throw new AuthError('Discord is unavailable. Try again shortly.', 503);
  try {
    const value: unknown = await result.json();
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AuthError(
      'Discord returned an invalid response. Try again shortly.',
      503,
    );
  }
}

async function membership(
  config: AuthConfiguration,
  token: string,
  userId: string,
  fetcher: DiscordFetch,
) {
  const member = await discordJson(
    fetcher,
    `/users/@me/guilds/${config.guildId}/member`,
    token,
  );
  if (
    !Array.isArray(member.roles) ||
    !member.roles.every(
      (role) => typeof role === 'string' && ID_PATTERN.test(role),
    )
  )
    throw new AuthError(
      'Discord returned an invalid membership response. Try again shortly.',
      503,
    );
  if (
    member.user &&
    (typeof member.user !== 'object' ||
      (member.user as { id?: unknown }).id !== userId)
  )
    throw new AuthError(
      'Discord returned an invalid membership response. Try again shortly.',
      503,
    );
  if (!member.roles.includes(config.roleId))
    throw new AuthError(
      'Your Discord account does not have the required server role. Ask a server administrator for access, or try another account.',
      403,
    );
}

async function readSession(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
) {
  const auth = credential(request, config);
  if (!auth)
    throw new AuthError('Sign in with Discord to administer this relay.', 401);
  const tokenHash = await digest(auth.token);
  const session = await env.DB.prepare(
    'SELECT * FROM admin_sessions WHERE token_hash = ? AND kind = ? AND expires_at_ms > ? AND config_hash = ?',
  )
    .bind(tokenHash, auth.kind, Date.now(), await configurationHash(config))
    .first<Session>();
  if (!session)
    throw new AuthError(
      'Your session expired. Sign in with Discord again.',
      401,
    );
  return session;
}

async function checkSession(
  session: Session,
  env: AuthEnv,
  config: AuthConfiguration,
  fetcher: DiscordFetch,
) {
  const now = Date.now();
  if (session.retry_at_ms > now) {
    const error = retryError(
      String(Math.ceil((session.retry_at_ms - now) / 1000)),
    );
    error.user = { id: session.user_id, name: session.user_name };
    throw error;
  }
  try {
    await membership(
      config,
      await open(session, await configurationKey(env.CONFIG_ENCRYPTION_KEY)),
      session.user_id,
      fetcher,
    );
  } catch (error) {
    if (error instanceof AuthError) {
      error.user = { id: session.user_id, name: session.user_name };
      if (error.status === 401)
        await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
          .bind(session.token_hash)
          .run();
      if (error.retryAfter)
        await env.DB.prepare(
          'UPDATE admin_sessions SET retry_at_ms = ? WHERE token_hash = ?',
        )
          .bind(Date.now() + error.retryAfter * 1000, session.token_hash)
          .run();
    }
    throw error;
  }
  return { id: session.user_id, name: session.user_name, kind: session.kind };
}

export async function requireAdmin(
  request: Request,
  env: AuthEnv,
  fetcher: DiscordFetch = fetch,
): Promise<AdminIdentity> {
  const config = configured(env, request);
  const session = await readSession(request, env, config);
  return checkSession(session, env, config, fetcher);
}

async function createSession(
  env: AuthEnv,
  config: AuthConfiguration,
  kind: Session['kind'],
  user: { id: string; name: string },
  accessToken: string,
  expiresAt: number,
) {
  const token = random();
  const tokenHash = await digest(token);
  const encrypted = await seal(
    accessToken,
    await configurationKey(env.CONFIG_ENCRYPTION_KEY),
    tokenHash,
  );
  await env.DB.prepare(
    'INSERT INTO admin_sessions (token_hash, kind, user_id, user_name, encrypted_token, expires_at_ms, config_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      tokenHash,
      kind,
      user.id,
      user.name,
      encrypted,
      expiresAt,
      await configurationHash(config),
    )
    .run();
  return { token, expiresAt, user };
}

async function cleanup(env: AuthEnv) {
  const now = Date.now();
  await env.DB.batch(
    ['admin_sessions', 'admin_oauth_requests', 'admin_cli_requests'].map(
      (table) =>
        env.DB.prepare(`DELETE FROM ${table} WHERE expires_at_ms <= ?`).bind(
          now,
        ),
    ),
  );
}

async function login(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
) {
  const cliRequest = new URL(request.url).searchParams.get('request');
  if (cliRequest && !(await findCli(env, config, cliRequest)))
    throw new AuthError(
      'This CLI login request expired. Run syndicord login again.',
      410,
    );
  await configurationKey(env.CONFIG_ENCRYPTION_KEY);
  await cleanup(env);
  const state = random();
  const binding = random();
  const verifier = oauth.generateRandomCodeVerifier();
  await env.DB.prepare(
    'INSERT INTO admin_oauth_requests (state_hash, browser_hash, verifier, cli_request_id, expires_at_ms, config_hash) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      await digest(state),
      await digest(binding),
      verifier,
      cliRequest,
      Date.now() + LOGIN_MS,
      await configurationHash(config),
    )
    .run();
  const target = new URL(server.authorization_endpoint!);
  target.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'identify guilds.members.read',
    state,
    code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();
  return redirect(target.href, [
    cookie(config, 'oauth', binding, LOGIN_MS / 1000),
  ]);
}

function errorCode(error: unknown) {
  if (!(error instanceof AuthError)) return 'invalid';
  if (error.status === 403) return 'denied';
  if (error.status === 401) return 'expired';
  if (error.status === 429) return 'rate_limited';
  if (error.status === 503) return 'unavailable';
  return 'invalid';
}

async function callback(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
  fetcher: DiscordFetch,
) {
  const cleared = cookie(config, 'oauth', '', 0);
  let pending: OAuthRequest | null = null;
  let clearPrevious = false;
  async function denyCli() {
    if (pending?.cli_request_id)
      await env.DB.prepare(
        "UPDATE admin_cli_requests SET status = 'denied' WHERE request_id = ? AND status = 'pending'",
      )
        .bind(pending.cli_request_id)
        .run();
  }
  function failureCookies() {
    return clearPrevious
      ? [cleared, cookie(config, 'session', '', 0)]
      : [cleared];
  }
  try {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const binding = cookieValue(request, cookieName(config, 'oauth'));
    if (
      !state ||
      !TOKEN_PATTERN.test(state) ||
      !binding ||
      url.searchParams.getAll('state').length !== 1
    )
      throw new AuthError('Invalid sign-in request. Start again.', 400);
    pending = await env.DB.prepare(
      'DELETE FROM admin_oauth_requests WHERE state_hash = ? AND browser_hash = ? AND expires_at_ms > ? AND config_hash = ? RETURNING verifier, cli_request_id',
    )
      .bind(
        await digest(state),
        await digest(binding),
        Date.now(),
        await configurationHash(config),
      )
      .first<OAuthRequest>();
    if (!pending)
      throw new AuthError(
        'This sign-in request expired or was already used. Start again.',
        400,
      );
    // Once the browser-bound transaction is consumed, a failed account switch
    // must not silently leave the previous account authenticated.
    const previous = credential(request, config);
    if (previous?.kind === 'browser') {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
        .bind(await digest(previous.token))
        .run();
      clearPrevious = true;
    }
    const client = { client_id: config.clientId };
    let parameters: URLSearchParams;
    try {
      parameters = oauth.validateAuthResponse(server, client, url, state);
    } catch {
      if (
        url.searchParams.get('error') === 'access_denied' &&
        url.searchParams.get('iss') === server.issuer
      ) {
        await denyCli();
        return redirect('/admin?auth=cancelled', failureCookies());
      }
      throw new AuthError('Invalid sign-in response. Start again.', 400);
    }
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      server,
      client,
      oauth.ClientSecretPost(config.clientSecret),
      parameters,
      config.redirectUri,
      pending.verifier,
      {
        [oauth.customFetch]: (url, init) =>
          discordRequest(fetcher, String(url), init),
      },
    );
    if (tokenResponse.status === 400 || tokenResponse.status === 401)
      throw new AuthError(
        'Discord could not complete this sign-in. Start again.',
        401,
      );
    if (!tokenResponse.ok)
      throw new AuthError('Discord is unavailable. Try again shortly.', 503);
    const token = await oauth.processAuthorizationCodeResponse(
      server,
      client,
      tokenResponse,
    );
    const scopes = new Set(token.scope?.split(' '));
    if (
      !scopes.has('identify') ||
      !scopes.has('guilds.members.read') ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in! <= 0
    )
      throw new AuthError(
        'Discord did not grant the required authorization. Sign in again.',
        403,
      );
    const identity = await discordJson(
      fetcher,
      '/users/@me',
      token.access_token,
    );
    if (
      typeof identity.id !== 'string' ||
      !ID_PATTERN.test(identity.id) ||
      typeof identity.username !== 'string' ||
      !identity.username ||
      identity.username.length > 128
    )
      throw new AuthError(
        'Discord returned an invalid identity. Try again shortly.',
        503,
      );
    const user = {
      id: identity.id,
      name:
        typeof identity.global_name === 'string' &&
        identity.global_name.length > 0 &&
        identity.global_name.length <= 128
          ? identity.global_name
          : identity.username,
    };
    let denied = false;
    try {
      await membership(config, token.access_token, user.id, fetcher);
    } catch (error) {
      if (!(error instanceof AuthError) || error.status !== 403) throw error;
      denied = true;
      await denyCli();
    }
    const session = await createSession(
      env,
      config,
      'browser',
      user,
      token.access_token,
      Date.now() + Math.min(SESSION_MS, token.expires_in! * 1000),
    );
    const target = denied
      ? '/admin?auth=denied'
      : pending.cli_request_id
        ? `/admin/auth/cli?request=${pending.cli_request_id}`
        : '/admin';
    return redirect(target, [
      cleared,
      cookie(
        config,
        'session',
        session.token,
        (session.expiresAt - Date.now()) / 1000,
      ),
    ]);
  } catch (error) {
    await denyCli();
    return redirect(`/admin?auth=${errorCode(error)}`, failureCookies());
  }
}

async function logout(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
) {
  const auth = credential(request, config);
  if (!auth || auth.kind === 'browser') sameOrigin(request, config);
  else sameOrigin(request, config, true);
  if (auth)
    await env.DB.prepare(
      'DELETE FROM admin_sessions WHERE token_hash = ? AND kind = ?',
    )
      .bind(await digest(auth.token), auth.kind)
      .run();
  return auth?.kind === 'cli'
    ? json({ signedOut: true })
    : redirect('/admin', [
        cookie(config, 'session', '', 0),
        cookie(config, 'oauth', '', 0),
      ]);
}

async function findCli(
  env: AuthEnv,
  config: AuthConfiguration,
  requestId: string,
) {
  if (!TOKEN_PATTERN.test(requestId)) return null;
  return env.DB.prepare(
    'SELECT * FROM admin_cli_requests WHERE request_id = ? AND config_hash = ? AND expires_at_ms > ?',
  )
    .bind(requestId, await configurationHash(config), Date.now())
    .first<CliRequest>();
}

async function startCli(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
) {
  sameOrigin(request, config, true);
  await jsonBody(request);
  await configurationKey(env.CONFIG_ENCRYPTION_KEY);
  await cleanup(env);
  const requestId = random();
  const secret = random();
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const code = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
  await env.DB.prepare(
    'INSERT INTO admin_cli_requests (request_id, secret_hash, user_code, expires_at_ms, config_hash) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(
      requestId,
      await digest(secret),
      userCode,
      Date.now() + LOGIN_MS,
      await configurationHash(config),
    )
    .run();
  return json({
    requestId,
    secret,
    verificationUri: `${config.origin}/admin/auth/cli?request=${requestId}`,
    userCode,
    expiresIn: LOGIN_MS / 1000,
    interval: POLL_MS / 1000,
  });
}

function escape(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cliPage(title: string, content: string, status = 200) {
  return response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · syndicord</title></head><body><main><h1>${escape(title)}</h1>${content}<p><a href="/admin">Return to syndicord</a></p></main></body></html>`,
    status,
    {
      'Content-Type': 'text/html; charset=utf-8',
      // Native same-origin POST forms need a non-null Origin header. This
      // still omits referrers when navigating from here to Discord.
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  );
}

async function cliAccessFailure(
  error: unknown,
  session: Session | null,
  requestId: string,
  env: AuthEnv,
) {
  if (!(error instanceof AuthError)) throw error;
  const failed = error.status === 401 || error.status === 403;
  if (failed)
    await env.DB.prepare(
      "UPDATE admin_cli_requests SET status = 'denied' WHERE request_id = ? AND status = 'pending'",
    )
      .bind(requestId)
      .run();
  const identity = session
    ? `<p>Signed in as <strong>${escape(session.user_name)}</strong> (${escape(session.user_id)}).</p>`
    : '';
  const page = cliPage(
    'CLI access unavailable',
    `${identity}<p>${escape(error.message)}</p>${failed ? '<p>Run <code>syndicord login</code> again to start a new terminal request.</p><p><a href="/admin/auth/login">Try another Discord account</a></p>' : `<p><a href="/admin/auth/cli?request=${requestId}">Try again</a></p>`}<form action="/admin/auth/logout" method="post"><button>Sign out</button></form>`,
    error.status,
  );
  if (error.retryAfter)
    page.headers.set('Retry-After', String(error.retryAfter));
  return page;
}

async function approveCliPage(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
  fetcher: DiscordFetch,
) {
  const requestId = new URL(request.url).searchParams.get('request') ?? '';
  const pending = await findCli(env, config, requestId);
  if (!pending || pending.status !== 'pending')
    return cliPage(
      'CLI sign-in unavailable',
      '<p>This request expired or was already completed. Run <code>syndicord login</code> again.</p>',
      410,
    );
  let session: Session;
  try {
    session = await readSession(request, env, config);
  } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 401) throw error;
    return cliPage(
      'Sign in to authorize your CLI',
      `<p>Only continue if you started <code>syndicord login</code> and your terminal shows <strong>${escape(pending.user_code)}</strong>.</p><a href="/admin/auth/login?request=${requestId}">Sign in with Discord</a>`,
    );
  }
  if (session.kind !== 'browser')
    throw new AuthError('Approve CLI access in your browser.', 403);
  try {
    await checkSession(session, env, config, fetcher);
  } catch (error) {
    return cliAccessFailure(error, session, requestId, env);
  }
  const approval = random();
  await env.DB.prepare(
    "UPDATE admin_cli_requests SET approval_hash = ?, approval_session_hash = ? WHERE request_id = ? AND status = 'pending'",
  )
    .bind(await digest(approval), session.token_hash, requestId)
    .run();
  return cliPage(
    'Authorize syndicord CLI',
    `<p>Signed in as <strong>${escape(session.user_name)}</strong> (${escape(session.user_id)}).</p><p>This will allow your terminal to manage this relay's feeds, webhooks, and routing for up to eight hours.</p><p>Only approve if you started <code>syndicord login</code> and its code matches <strong>${escape(pending.user_code)}</strong>. Never approve a request sent by someone else.</p><form action="/admin/auth/cli/approve" method="post"><input type="hidden" name="requestId" value="${requestId}"><input type="hidden" name="approval" value="${approval}"><button name="decision" value="approve">Authorize this CLI</button> <button name="decision" value="deny">Deny</button></form><p><a href="/admin/auth/login?request=${requestId}">Try another Discord account</a></p><form action="/admin/auth/logout" method="post"><button>Sign out</button></form>`,
  );
}

async function approveCli(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
  fetcher: DiscordFetch,
) {
  sameOrigin(request, config);
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/x-www-form-urlencoded'
  )
    throw new AuthError('Submit the CLI approval form in your browser.', 415);
  const form = new URLSearchParams(await boundedText(request.body, 4096));
  if (
    ['requestId', 'approval', 'decision'].some(
      (name) => form.getAll(name).length !== 1,
    )
  )
    throw new AuthError('Invalid CLI approval. Start again.', 400);
  const requestId = form.get('requestId')!;
  const approval = form.get('approval')!;
  const decision = form.get('decision');
  if (
    !TOKEN_PATTERN.test(requestId) ||
    !TOKEN_PATTERN.test(approval) ||
    !['approve', 'deny'].includes(decision!)
  )
    throw new AuthError('Invalid CLI approval. Start again.', 400);
  const auth = credential(request, config);
  if (auth?.kind !== 'browser')
    throw new AuthError('Approve CLI access in your browser.', 403);
  const sessionHash = await digest(auth.token);
  const approvalHash = await digest(approval);
  // Validate the browser-bound form before a failed access check may deny a
  // terminal request. A forged POST must not cancel someone else's login.
  const validForm = await env.DB.prepare(
    "SELECT request_id FROM admin_cli_requests WHERE request_id = ? AND approval_hash = ? AND approval_session_hash = ? AND status = 'pending' AND expires_at_ms > ? AND config_hash = ?",
  )
    .bind(
      requestId,
      approvalHash,
      sessionHash,
      Date.now(),
      await configurationHash(config),
    )
    .first();
  if (!validForm)
    throw new AuthError(
      'This CLI approval expired or was already used. Start again.',
      410,
    );
  let session: Session | null = null;
  try {
    session = await readSession(request, env, config);
    await checkSession(session, env, config, fetcher);
  } catch (error) {
    return cliAccessFailure(error, session, requestId, env);
  }
  const result = await env.DB.prepare(
    "UPDATE admin_cli_requests SET status = ?, session_hash = ?, approval_hash = NULL WHERE request_id = ? AND approval_hash = ? AND approval_session_hash = ? AND status = 'pending' AND expires_at_ms > ? AND config_hash = ?",
  )
    .bind(
      decision === 'approve' ? 'approved' : 'denied',
      session.token_hash,
      requestId,
      approvalHash,
      session.token_hash,
      Date.now(),
      await configurationHash(config),
    )
    .run();
  if (result.meta.changes !== 1)
    throw new AuthError(
      'This CLI approval expired or was already used. Start again.',
      410,
    );
  return cliPage(
    decision === 'approve' ? 'CLI authorized' : 'CLI access denied',
    '<p>Return to your terminal. You can close this page.</p>',
  );
}

async function pollCli(
  request: Request,
  env: AuthEnv,
  config: AuthConfiguration,
  fetcher: DiscordFetch,
) {
  sameOrigin(request, config, true);
  const input = await jsonBody(request);
  if (
    typeof input.requestId !== 'string' ||
    !TOKEN_PATTERN.test(input.requestId) ||
    typeof input.secret !== 'string' ||
    !TOKEN_PATTERN.test(input.secret)
  )
    throw new AuthError('Invalid CLI login request.', 401);
  const pending = await findCli(env, config, input.requestId);
  if (!pending)
    throw new AuthError(
      'This CLI login request expired or was already used. Run syndicord login again.',
      410,
    );
  const claimed = await env.DB.prepare(
    'UPDATE admin_cli_requests SET poll_after_ms = ? WHERE request_id = ? AND secret_hash = ? AND poll_after_ms <= ? RETURNING *',
  )
    .bind(
      Date.now() + POLL_MS,
      input.requestId,
      await digest(input.secret),
      Date.now(),
    )
    .first<CliRequest>();
  if (!claimed) {
    const valid = await env.DB.prepare(
      'SELECT request_id FROM admin_cli_requests WHERE request_id = ? AND secret_hash = ?',
    )
      .bind(input.requestId, await digest(input.secret))
      .first();
    if (!valid) throw new AuthError('Invalid CLI login credentials.', 401);
    const error = new AuthError('Wait before checking CLI sign-in again.', 429);
    error.retryAfter = 2;
    throw error;
  }
  if (claimed.status === 'pending') return json({ status: 'pending' }, 202);
  if (claimed.status === 'denied')
    throw new AuthError(
      'CLI access was denied in the browser. Run syndicord login to try again.',
      403,
    );
  const session = await env.DB.prepare(
    'SELECT * FROM admin_sessions WHERE token_hash = ? AND kind = ? AND expires_at_ms > ? AND config_hash = ?',
  )
    .bind(
      claimed.session_hash,
      'browser',
      Date.now(),
      await configurationHash(config),
    )
    .first<Session>();
  if (!session)
    throw new AuthError(
      'The approving browser session expired or signed out. Run syndicord login again.',
      401,
    );
  const user = await checkSession(session, env, config, fetcher);
  const consumed = await env.DB.prepare(
    "DELETE FROM admin_cli_requests WHERE request_id = ? AND secret_hash = ? AND status = 'approved' RETURNING request_id",
  )
    .bind(input.requestId, await digest(input.secret))
    .first();
  if (!consumed)
    throw new AuthError(
      'This CLI login request was already used. Run syndicord login again.',
      410,
    );
  return json(
    await createSession(
      env,
      config,
      'cli',
      user,
      await open(session, await configurationKey(env.CONFIG_ENCRYPTION_KEY)),
      session.expires_at_ms,
    ),
  );
}

export async function handleAuth(
  request: Request,
  env: AuthEnv,
  fetcher: DiscordFetch = fetch,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/admin/auth/')) return null;
  try {
    const config = configured(env, request);
    const routes: Record<
      string,
      { method: string; run: () => Promise<Response> }
    > = {
      '/admin/auth/login': {
        method: 'GET',
        run: () => login(request, env, config),
      },
      '/admin/auth/callback': {
        method: 'GET',
        run: () => callback(request, env, config, fetcher),
      },
      '/admin/auth/logout': {
        method: 'POST',
        run: () => logout(request, env, config),
      },
      '/admin/auth/cli/start': {
        method: 'POST',
        run: () => startCli(request, env, config),
      },
      '/admin/auth/cli': {
        method: 'GET',
        run: () => approveCliPage(request, env, config, fetcher),
      },
      '/admin/auth/cli/approve': {
        method: 'POST',
        run: () => approveCli(request, env, config, fetcher),
      },
      '/admin/auth/cli/poll': {
        method: 'POST',
        run: () => pollCli(request, env, config, fetcher),
      },
    };
    const route = routes[path];
    if (!route) return json({ error: 'Not found.' }, 404);
    if (request.method !== route.method)
      return json({ error: 'Method not allowed.' }, 405, {
        Allow: route.method,
      });
    return await route.run();
  } catch (error) {
    if (error instanceof AuthError) {
      const headers: Record<string, string> = {};
      if (error.retryAfter) headers['Retry-After'] = String(error.retryAfter);
      return json({ error: error.message }, error.status, headers);
    }
    return json(
      {
        error:
          'Authentication is unavailable. Check administration configuration and database migrations, then try again.',
      },
      503,
    );
  }
}
