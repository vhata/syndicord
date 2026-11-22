import { CONFIGURATION_SIZE_ERROR, loadFeeds } from '../src/config.ts';
import type { FeedRoute } from '../src/types.ts';
import type { Environment } from './cloudflare.ts';
import { adminEndpoint, readAdminResponse, readSession } from './auth.ts';

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

export function adminClient(env: Environment, fetcher: AdminFetch = fetch) {
  const destination = adminEndpoint(env);

  async function request(
    method: 'GET' | 'PUT',
    payload?: unknown,
  ): Promise<AdminSnapshot> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    if (body !== undefined && Buffer.byteLength(body) > MAX_BYTES)
      throw new Error(
        'Configuration exceeds the administration API limit of 128 KiB. No changes were sent.',
      );
    const session = await readSession(env);
    const authorization = `Bearer ${session.token}`;
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
          'Your administration session expired or was revoked. Run syndicord login again. See docs/WEB.md.',
        );
      if (response.status === 403)
        throw new Error(
          'Your Discord account no longer has the required server membership and role. Ask the server administrator for access, or run syndicord login with another account.',
        );
      if (response.status === 429)
        throw new Error(
          'Discord is rate limiting access checks. Wait before trying again; no save was authorized.',
        );
      if (response.status === 409)
        throw new Error(
          'Configuration changed while this command was running. Read the latest configuration, reapply your changes, and retry manually.',
        );
      if (response.status === 400) {
        let message: unknown;
        try {
          const value = await readAdminResponse(response, controller.signal);
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
          (message === CONFIGURATION_SIZE_ERROR ||
            message === 'Each destination must have a distinct webhook URL' ||
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
        return snapshot(await readAdminResponse(response, controller.signal));
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
