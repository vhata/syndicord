import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { AdminFetch } from './admin.ts';
import type { Environment } from './cloudflare.ts';

const MAX_BYTES = 128 * 1024;
const INVALID_RESPONSE =
  'The administration API returned an invalid response. Check SYNDICORD_ADMIN_URL and the Worker configuration.';
const LOGIN_REQUIRED =
  'No valid administration session is saved for this installation. Run syndicord login. See docs/FEEDS.md#select-an-installation.';
const PRIVATE_SESSION =
  'Cannot read the private CLI session. Run syndicord login to create a new session. See docs/FEEDS.md#select-an-installation.';
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

interface Session {
  token: string;
  expiresAt: number;
  user: { id: string; name: string };
}

export interface LoginDependencies {
  fetcher?: AdminFetch;
  openBrowser?: (url: string) => Promise<void>;
  progress?: (message: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export function adminEndpoint(env: Environment) {
  const value = env.SYNDICORD_ADMIN_URL?.trim() ?? '';
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      !/^https?:\/\/[^/?#]+\/?$/i.test(value) ||
      value.includes('\\') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return { origin: url.origin, url: new URL('/admin/api/config', url).href };
  } catch {
    throw new Error(
      'SYNDICORD_ADMIN_URL must be an HTTPS origin without credentials, path, query, or fragment. HTTP is allowed for localhost, 127.0.0.1, or [::1]. See docs/FEEDS.md#select-an-installation.',
    );
  }
}

export async function readAdminResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_BYTES,
): Promise<unknown> {
  if (
    Number(response.headers.get('content-length')) > maxBytes ||
    !response.body
  )
    throw new Error(INVALID_RESPONSE);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error(INVALID_RESPONSE);
      const part = await reader.read();
      if (signal.aborted) throw new Error(INVALID_RESPONSE);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error(INVALID_RESPONSE);
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new Error(INVALID_RESPONSE);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function session(value: unknown, now: number): Session {
  if (
    !record(value) ||
    !TOKEN.test(String(value.token)) ||
    typeof value.token !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt > now + 8 * 60 * 60 * 1000 ||
    !record(value.user) ||
    typeof value.user.id !== 'string' ||
    !/^\d{1,20}$/.test(value.user.id) ||
    typeof value.user.name !== 'string' ||
    !value.user.name ||
    value.user.name.length > 100
  )
    throw new Error(INVALID_RESPONSE);
  return {
    token: value.token,
    expiresAt: value.expiresAt,
    user: { id: value.user.id, name: value.user.name },
  };
}

function sessionLocation(env: Environment) {
  const origin = adminEndpoint(env).origin;
  const configured = env.XDG_CONFIG_HOME?.trim();
  if (configured && !isAbsolute(configured))
    throw new Error('XDG_CONFIG_HOME must be an absolute directory path.');
  const directory = join(configured || join(homedir(), '.config'), 'syndicord');
  const path = join(
    directory,
    `${createHash('sha256').update(origin).digest('hex')}.json`,
  );
  return { origin, directory, path };
}

export async function readSession(env: Environment): Promise<Session> {
  const { origin, path } = sessionLocation(env);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > 4096
    )
      throw new Error();
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (!record(value) || value.origin !== origin) throw new Error();
    try {
      return session(value, Date.now());
    } catch {
      throw new Error(LOGIN_REQUIRED);
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error instanceof Error && error.message === LOGIN_REQUIRED)
    )
      throw new Error(LOGIN_REQUIRED);
    throw new Error(PRIVATE_SESSION);
  } finally {
    await file?.close();
  }
}

async function saveSession(env: Environment, value: Session) {
  const { origin, directory, path } = sessionLocation(env);
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
    await chmod(directory, 0o700);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify({ origin, ...value }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch {
    throw new Error(
      'Could not save the private CLI session. Check your configuration directory permissions and run syndicord login again.',
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function removeSession(env: Environment) {
  try {
    await unlink(sessionLocation(env).path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(
        'Could not remove the local CLI session file. Check your configuration directory permissions.',
      );
  }
}

async function openBrowser(url: string) {
  const [command, args] =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const)
        : (['xdg-open', [url]] as const);
  await promisify(execFile)(command, args, {
    timeout: 10_000,
    maxBuffer: 4096,
  });
}

async function authRequest(
  origin: string,
  path: string,
  body: unknown,
  fetcher: AdminFetch,
  token?: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response | undefined;
  try {
    response = await fetcher(origin + path, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    let value: unknown;
    if (response.ok && response.status !== 204)
      value = await readAdminResponse(response, controller.signal);
    return {
      status: response.status,
      value,
      retryAfter: response.headers.get('retry-after'),
    };
  } catch {
    throw new Error(
      'Cannot complete administration authentication. Check the installation URL and network, then try again.',
    );
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
}

function failure(status: number): never {
  if (status === 403)
    throw new Error(
      'Access was denied. Your Discord account must have one of the server roles configured by this installation’s operator. Run syndicord login to try another account.',
    );
  if (status === 401 || status === 410)
    throw new Error(
      'The login request expired or was invalidated. Run syndicord login again.',
    );
  if (status === 429)
    throw new Error(
      'Authentication is rate limited. Wait before running syndicord login again.',
    );
  throw new Error(
    `Administration authentication is unavailable (HTTP ${status}). Check the Worker OAuth configuration and try again.`,
  );
}

export async function login(
  env: Environment,
  dependencies: LoginDependencies = {},
) {
  const { origin } = adminEndpoint(env);
  // Validate the local location before requesting a browser login.
  sessionLocation(env);
  const fetcher = dependencies.fetcher ?? fetch;
  const progress =
    dependencies.progress ??
    ((message) => process.stderr.write(message + '\n'));
  const wait =
    dependencies.wait ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const begunAt = now();
  const started = await authRequest(
    origin,
    '/admin/auth/cli/start',
    {},
    fetcher,
  );
  if (started.status !== 200) failure(started.status);
  const value = started.value;
  if (
    !record(value) ||
    typeof value.requestId !== 'string' ||
    !TOKEN.test(value.requestId) ||
    typeof value.secret !== 'string' ||
    !TOKEN.test(value.secret) ||
    typeof value.userCode !== 'string' ||
    !/^[A-Z0-9-]{4,16}$/.test(value.userCode) ||
    typeof value.verificationUri !== 'string' ||
    value.verificationUri !==
      `${origin}/admin/auth/cli?request=${value.requestId}` ||
    typeof value.expiresIn !== 'number' ||
    !Number.isInteger(value.expiresIn) ||
    value.expiresIn < 1 ||
    value.expiresIn > 600 ||
    typeof value.interval !== 'number' ||
    !Number.isInteger(value.interval) ||
    value.interval < 2 ||
    value.interval > 30
  )
    throw new Error(INVALID_RESPONSE);
  const deadline = begunAt + value.expiresIn * 1000;
  progress(
    `Sign in to ${origin} with Discord. Approve only the terminal request showing code ${value.userCode}.`,
  );
  progress(`Open ${value.verificationUri}`);
  try {
    await (dependencies.openBrowser ?? openBrowser)(value.verificationUri);
  } catch {
    progress(
      'Could not open a browser automatically. Open the address above in your browser.',
    );
  }
  let delay = value.interval * 1000;
  while (now() < deadline) {
    await wait(Math.min(delay, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const result = await authRequest(
      origin,
      '/admin/auth/cli/poll',
      { requestId: value.requestId, secret: value.secret },
      fetcher,
    );
    if (
      result.status === 202 &&
      record(result.value) &&
      result.value.status === 'pending'
    ) {
      delay = value.interval * 1000;
      continue;
    }
    if (result.status === 429) {
      const seconds = Number(result.retryAfter);
      delay =
        Math.max(
          value.interval,
          Number.isFinite(seconds) && seconds > 0 ? Math.min(60, seconds) : 5,
        ) * 1000;
      continue;
    }
    if (result.status !== 200) failure(result.status);
    if (now() >= deadline) break;
    const saved = session(result.value, now());
    await saveSession(env, saved);
    return `Signed in as ${JSON.stringify(saved.user.name)} (${saved.user.id}) at ${origin}. Session expires ${new Date(saved.expiresAt).toISOString()}.`;
  }
  throw new Error('The browser login timed out. Run syndicord login again.');
}

export async function logout(env: Environment, fetcher: AdminFetch = fetch) {
  const { origin } = adminEndpoint(env);
  let saved: Session;
  try {
    saved = await readSession(env);
  } catch (error) {
    if (error instanceof Error && error.message === LOGIN_REQUIRED) {
      await removeSession(env);
      return `No active CLI session is saved for ${origin}.`;
    }
    throw error;
  }
  const response = await authRequest(
    origin,
    '/admin/auth/logout',
    {},
    fetcher,
    saved.token,
  );
  if (![200, 204, 401].includes(response.status))
    throw new Error(
      'The server could not confirm logout. The local session was retained so you can retry syndicord logout.',
    );
  await removeSession(env);
  return `Signed out of ${origin}.`;
}
