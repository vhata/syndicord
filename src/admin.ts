import { renderAdminPage } from './admin-page.ts';
import {
  AdminError,
  configurationKey,
  readAdminConfiguration,
  saveAdminConfiguration,
} from './admin-store.ts';
import type { ConfigurationEnv } from './admin-store.ts';
import { ConfigurationError } from './config-store.ts';

export interface AdminEnv extends ConfigurationEnv {
  ADMIN_PASSWORD?: string;
}

const MAX_BODY_BYTES = 128 * 1024;
const encoder = new TextEncoder();

async function authenticated(request: Request, password: string) {
  try {
    const authorization = request.headers.get('authorization');
    if (!authorization || authorization.length > 16384) return false;
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    if (!match) return false;
    const credentials = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(
      Uint8Array.from(atob(match[1]!), (character) => character.charCodeAt(0)),
    );
    const [actual, expected] = await Promise.all(
      [credentials, `admin:${password}`].map(
        async (value) =>
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', encoder.encode(value)),
          ),
      ),
    );
    let different = 0;
    for (let index = 0; index < 32; index++)
      different |= actual![index]! ^ expected![index]!;
    return different === 0;
  } catch {
    return false;
  }
}

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

function json(value: unknown, status = 200) {
  return response(JSON.stringify(value), status, {
    'Content-Type': 'application/json; charset=utf-8',
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

export async function handleAdmin(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/', '/admin', '/admin/', '/admin/api/config'].includes(url.pathname))
    return null;
  if (!env.ADMIN_PASSWORD)
    return response('Web administration is disabled.', 404);
  if (!(await authenticated(request, env.ADMIN_PASSWORD)))
    return response('Authentication required.', 401, {
      'WWW-Authenticate': 'Basic realm="syndicord", charset="UTF-8"',
    });
  try {
    const key = await configurationKey(env.CONFIG_ENCRYPTION_KEY);
    if (url.pathname === '/admin/api/config') {
      if (request.method === 'GET')
        return json(await readAdminConfiguration(env, key));
      if (request.method !== 'PUT')
        return response('Method not allowed.', 405, { Allow: 'GET, PUT' });
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
      return json(
        await saveAdminConfiguration(env, key, await readBody(request)),
      );
    }
    if (request.method !== 'GET')
      return response('Method not allowed.', 405, { Allow: 'GET' });
    if (url.pathname === '/')
      return response(null, 302, { Location: '/admin' });
    const nonce = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))),
    );
    return response(renderAdminPage(nonce), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    });
  } catch (error) {
    if (error instanceof AdminError)
      return json({ error: error.message }, error.status);
    if (error instanceof ConfigurationError)
      return json({ error: error.message }, 503);
    return json(
      {
        error:
          'Configuration is unavailable. Check database migrations and try again.',
      },
      503,
    );
  }
}
