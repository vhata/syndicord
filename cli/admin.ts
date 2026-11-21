import { loadFeeds } from '../src/config.ts';
import type { FeedRoute } from '../src/types.ts';
import type { Environment } from './cloudflare.ts';

export type AdminFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface AdminSnapshot {
  feeds: FeedRoute[];
  destinations: string[];
  revision: string;
}

const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 10_000;
const INVALID_RESPONSE =
  'The administration API returned an invalid response. Check SYNDICORD_ADMIN_URL and the Worker configuration.';

function endpoint(env: Environment) {
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
      'SYNDICORD_ADMIN_URL must be an HTTPS origin without credentials, path, query, or fragment. HTTP is allowed for localhost, 127.0.0.1, or [::1]. See docs/WEB.md.',
    );
  }
}

function snapshot(value: unknown): AdminSnapshot {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error();
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.revision !== 'string' ||
      !raw.revision ||
      raw.revision.length > 256 ||
      !Array.isArray(raw.destinations) ||
      !raw.destinations.every(
        (name) =>
          typeof name === 'string' &&
          /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name),
      ) ||
      new Set(raw.destinations).size !== raw.destinations.length
    )
      throw new Error();
    return {
      feeds: loadFeeds(raw.feeds),
      destinations: raw.destinations,
      revision: raw.revision,
    };
  } catch {
    throw new Error(INVALID_RESPONSE);
  }
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    Number(response.headers.get('content-length')) > MAX_BYTES ||
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
      if (size > MAX_BYTES) throw new Error(INVALID_RESPONSE);
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

export function adminClient(env: Environment, fetcher: AdminFetch = fetch) {
  const destination = endpoint(env);
  if (!env.SYNDICORD_ADMIN_PASSWORD)
    throw new Error(
      'Set SYNDICORD_ADMIN_PASSWORD to the web interface password. See docs/WEB.md for CLI configuration.',
    );
  const authorization = `Basic ${Buffer.from(`admin:${env.SYNDICORD_ADMIN_PASSWORD}`, 'utf8').toString('base64')}`;

  async function request(
    method: 'GET' | 'PUT',
    payload?: unknown,
  ): Promise<AdminSnapshot> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined && Buffer.byteLength(body) > MAX_BYTES)
      throw new Error(
        'Configuration exceeds the administration API limit of 128 KiB. No changes were sent.',
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response | undefined;
    try {
      try {
        response = await fetcher(destination.url, {
          method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            ...(method === 'PUT'
              ? {
                  Origin: destination.origin,
                  'Content-Type': 'application/json',
                }
              : {}),
          },
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        throw new Error(
          method === 'PUT'
            ? 'The configuration save could not be confirmed. Inspect the current configuration before retrying; the request was not retried.'
            : 'Cannot reach the administration API. Check its URL, availability, and network connection.',
        );
      }
      if (response.status === 401)
        throw new Error(
          'Administration authentication failed. Check SYNDICORD_ADMIN_PASSWORD.',
        );
      if (response.status === 409)
        throw new Error(
          'Configuration changed while this command was running. Read the latest configuration, reapply your changes, and retry manually.',
        );
      if (response.status === 400) {
        let message: unknown;
        try {
          const value = await readResponse(response, controller.signal);
          if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
          )
            message = (value as Record<string, unknown>).error;
        } catch {
          // Arbitrary or malformed server diagnostics never enter CLI output.
        }
        if (
          typeof message === 'string' &&
          (message === 'Each destination must have a distinct webhook URL' ||
            /^Missing webhook for destination [A-Za-z][A-Za-z0-9_-]{0,63}$/.test(
              message,
            ))
        )
          throw new Error(`Configuration rejected: ${message}.`);
      }
      if (!response.ok)
        throw new Error(
          method === 'PUT'
            ? `The administration API rejected or could not confirm the save (HTTP ${response.status}). Check the configuration and inspect its current state before retrying.`
            : `The administration API is unavailable (HTTP ${response.status}). Check that web administration is enabled at SYNDICORD_ADMIN_URL.`,
        );
      try {
        return snapshot(await readResponse(response, controller.signal));
      } catch {
        throw new Error(
          method === 'PUT'
            ? 'The configuration save response was invalid or incomplete. Inspect the current configuration before retrying; the request was not retried.'
            : INVALID_RESPONSE,
        );
      }
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
    }
  }

  return {
    read: () => request('GET'),
    write: (
      current: AdminSnapshot,
      feeds: FeedRoute[],
      webhooks: Record<string, string | null>,
    ) => request('PUT', { revision: current.revision, feeds, webhooks }),
  };
}
