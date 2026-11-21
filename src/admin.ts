import { renderAccessPage, renderAdminPage } from './admin-page.ts';
import {
  AuthError,
  authConfiguration,
  handleAuth,
  requireAdmin,
} from './admin-auth.ts';
import type { AuthEnv } from './admin-auth.ts';
import {
  AdminError,
  configurationKey,
  readAdminConfiguration,
  saveAdminConfiguration,
} from './admin-store.ts';
import { ConfigurationError } from './config-store.ts';

export type AdminEnv = AuthEnv;

const MAX_BODY_BYTES = 128 * 1024;

function response(
  body: BodyInit | null,
  status: number,
  extra: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

function json(
  value: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  return response(JSON.stringify(value), status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extra,
  });
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES)
    throw new AdminError('Configuration exceeds 128 KiB.', 413);
  if (!request.body) throw new AdminError('Provide a JSON configuration.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES)
        throw new AdminError('Configuration exceeds 128 KiB.', 413);
      chunks.push(part.value);
    }
  } finally {
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
    throw new AdminError('Provide valid JSON.');
  }
}

const callbackMessages: Record<string, string> = {
  denied:
    'Your Discord account does not have access. You must belong to the configured server and have its required role. Ask a server administrator to grant access, or try another account.',
  expired: 'Your Discord authorization expired. Sign in again to continue.',
  invalid:
    'This sign-in request is invalid, expired, or already used. Start a new sign-in.',
  unavailable: 'Discord could not verify your account. Please try again later.',
  rate_limited:
    'Discord is limiting authentication requests. Wait a moment before trying again.',
  cancelled:
    'Discord sign-in was cancelled. You can try again when you are ready.',
};

function callbackMessage(url: URL): string | undefined {
  const code = url.searchParams.get('auth') ?? '';
  return Object.hasOwn(callbackMessages, code)
    ? callbackMessages[code]
    : undefined;
}

function html(
  render: (nonce: string) => string,
  status: number,
  extra: Record<string, string> = {},
) {
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))),
  );
  return response(render(nonce), status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Native same-origin form POSTs must retain their Origin for CSRF checks.
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    ...extra,
  });
}

export async function handleAdmin(
  request: Request,
  env: AdminEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  const api = url.pathname === '/admin/api/config';
  const page = ['/', '/admin', '/admin/'].includes(url.pathname);
  if (!api && !page && !url.pathname.startsWith('/admin/auth/')) return null;
  try {
    const authResponse = await handleAuth(request, env, fetcher);
    if (authResponse) return authResponse;
    if (!api && !page) return null;
    if (!authConfiguration(env, request)) {
      const message =
        'Administration is disabled. Ask the operator to configure Discord sign-in for this installation.';
      return api
        ? json({ error: message }, 503)
        : html(
            (nonce) =>
              renderAccessPage(nonce, {
                title: 'Administration is disabled',
                message,
                allowLogin: false,
              }),
            503,
          );
    }
    if (page && request.method !== 'GET')
      return response('Method not allowed.', 405, { Allow: 'GET' });
    if (url.pathname === '/')
      return response(null, 302, { Location: '/admin' });
    const user = await requireAdmin(request, env, fetcher);
    const signInMessage = callbackMessage(url);
    if (page && signInMessage)
      return html(
        (nonce) =>
          renderAccessPage(nonce, {
            title: 'Discord sign-in was not completed',
            message:
              signInMessage +
              ' The account shown is still signed in. Sign out to switch accounts, or try signing in again.',
            user,
            allowLogin: true,
            showLogout: true,
            retry: true,
          }),
        200,
      );
    const key = await configurationKey(env.CONFIG_ENCRYPTION_KEY);
    if (api) {
      if (request.method === 'GET')
        return json(await readAdminConfiguration(env, key));
      if (request.method !== 'PUT')
        return json({ error: 'Method not allowed.' }, 405, {
          Allow: 'GET, PUT',
        });
      if (request.headers.get('origin') !== url.origin)
        throw new AdminError(
          'Configuration changes must come from this site.',
          403,
        );
      if (
        request.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        throw new AdminError(
          'Use application/json for configuration changes.',
          415,
        );
      const input = await readBody(request);
      // Reading a streamed body can outlive the session or its Discord role.
      await requireAdmin(request, env, fetcher);
      return json(await saveAdminConfiguration(env, key, input));
    }
    return html((nonce) => renderAdminPage(nonce, user), 200);
  } catch (error) {
    const status = error instanceof AdminError ? error.status : 503;
    const message =
      error instanceof AdminError || error instanceof ConfigurationError
        ? error.message
        : 'Configuration is unavailable. Check database migrations and try again.';
    const extra: Record<string, string> =
      error instanceof AuthError && error.retryAfter
        ? { 'Retry-After': String(error.retryAfter) }
        : {};
    if (api || !page) return json({ error: message }, status, extra);
    const signInMessage = callbackMessage(url);
    const signedOut = error instanceof AuthError && status === 401;
    return html(
      (nonce) =>
        renderAccessPage(nonce, {
          title: signedOut
            ? 'Sign in to syndicord'
            : status === 403
              ? 'Your account does not have access'
              : 'Administration is unavailable',
          message: signedOut
            ? (signInMessage ??
              'Sign in with your Discord account to manage feeds, webhooks, and routing.')
            : message,
          user: error instanceof AuthError ? error.user : undefined,
          allowLogin: true,
          showLogout: true,
          retry: Boolean(signInMessage) || !signedOut,
        }),
      signedOut ? 200 : status,
      extra,
    );
  }
}
