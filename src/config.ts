import type { FeedRoute } from './types.ts';

export interface RelayConfig {
  feeds: FeedRoute[];
  webhooks: Record<string, string>;
}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MAX_ROUTES = 20;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function feedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Feed URL must be a URL of at most 2048 characters');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Feed URL must be an absolute HTTP or HTTPS URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.length > 2048
  ) {
    throw new Error(
      'Feed URL must use HTTP or HTTPS without credentials or fragments',
    );
  }
  return url.href;
}

function webhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Each destination needs a Discord webhook URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Each destination needs a Discord webhook URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'discord.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)
  ) {
    throw new Error(
      'Webhook URLs must use https://discord.com/api/webhooks/ID/TOKEN',
    );
  }
  const parameters = [...url.searchParams];
  if (
    parameters.length > 1 ||
    parameters.some(([key, val]) => key !== 'thread_id' || !/^\d+$/.test(val))
  ) {
    throw new Error('Webhook URLs support only an optional numeric thread_id');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.href;
}

export function loadConfig(feeds: unknown, secret: unknown): RelayConfig {
  if (!Array.isArray(feeds) || feeds.length > MAX_ROUTES) {
    throw new Error(
      `feeds.json must be an array with at most ${MAX_ROUTES} feeds`,
    );
  }
  const routes: FeedRoute[] = [];
  const urls = new Set<string>();
  const destinations = new Set<string>();
  let routeCount = 0;
  for (const raw of feeds) {
    if (
      !record(raw) ||
      Object.keys(raw).some((key) => !['url', 'destinations'].includes(key)) ||
      !Array.isArray(raw.destinations) ||
      raw.destinations.length === 0
    ) {
      throw new Error(
        'Each feed needs a url and a nonempty destinations array',
      );
    }
    const url = feedUrl(raw.url);
    if (urls.has(url)) throw new Error('Each feed URL must appear only once');
    urls.add(url);
    const names: string[] = [];
    for (const name of raw.destinations) {
      if (
        typeof name !== 'string' ||
        !NAME.test(name) ||
        names.includes(name)
      ) {
        throw new Error(
          'Destination names must be unique letters, digits, underscores or hyphens, starting with a letter',
        );
      }
      names.push(name);
      destinations.add(name);
    }
    routeCount += names.length;
    if (routeCount > MAX_ROUTES) {
      throw new Error(
        `At most ${MAX_ROUTES} feed/destination pairs are supported`,
      );
    }
    routes.push({ url, destinations: names });
  }
  const webhooks: Record<string, string> = Object.create(null);
  if (routes.length === 0) return { feeds: routes, webhooks };
  let values: unknown;
  try {
    if (typeof secret !== 'string') throw new Error();
    values = JSON.parse(secret);
  } catch {
    throw new Error(
      'WEBHOOKS must be a JSON object mapping destination names to webhook URLs',
    );
  }
  if (!record(values)) throw new Error('WEBHOOKS must be a JSON object');
  const used = new Set<string>();
  for (const name of destinations) {
    if (!Object.hasOwn(values, name))
      throw new Error(`Missing webhook for destination ${name}`);
    const url = webhookUrl(values[name]);
    if (used.has(url))
      throw new Error('Each destination must have a distinct webhook URL');
    used.add(url);
    webhooks[name] = url;
  }
  return { feeds: routes, webhooks };
}

export async function webhookFingerprints(
  webhooks: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const [name, url] of Object.entries(webhooks)) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(url),
    );
    result[name] = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  }
  return result;
}
