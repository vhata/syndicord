import { feedUrl } from './config.ts';
import { ConfigurationError } from './config-store.ts';
import type { ChannelScope } from './catalog-types.ts';
import type { FeedRoute } from './types.ts';

export interface CatalogFeed {
  id: string;
  label: string;
  url: string;
}

export interface CatalogDestination extends ChannelScope {
  id: string;
  label: string;
  deliveryKey: string;
}

export interface CatalogDocument {
  version: 1;
  feeds: CatalogFeed[];
  destinations: CatalogDestination[];
  subscriptions: { feedId: string; destinationId: string }[];
}

export const MAX_CATALOG_BYTES = 96 * 1024;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SNOWFLAKE = /^\d{1,20}$/;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function catalogLabel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 100 ||
    // oxlint-disable-next-line no-control-regex -- Labels must not contain control characters.
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error('Labels must contain 1 to 100 printable characters.');
  return value.trim();
}

export function catalogId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function parseCatalog(value: string): CatalogDocument {
  try {
    const raw: unknown = JSON.parse(value);
    if (
      !record(raw) ||
      !exactKeys(raw, ['version', 'feeds', 'destinations', 'subscriptions']) ||
      raw.version !== 1 ||
      !Array.isArray(raw.feeds) ||
      !Array.isArray(raw.destinations) ||
      !Array.isArray(raw.subscriptions)
    )
      throw new Error();
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const feed of raw.feeds) {
      if (
        !record(feed) ||
        !exactKeys(feed, ['id', 'label', 'url']) ||
        !catalogId(feed.id) ||
        ids.has(feed.id) ||
        catalogLabel(feed.label) !== feed.label ||
        typeof feed.url !== 'string' ||
        feedUrl(feed.url) !== feed.url ||
        urls.has(feed.url)
      )
        throw new Error();
      ids.add(feed.id);
      urls.add(feed.url);
    }
    const destinationIds = new Set<string>();
    const deliveryKeys = new Set<string>();
    for (const destination of raw.destinations) {
      if (
        !record(destination) ||
        !exactKeys(destination, [
          'id',
          'label',
          'deliveryKey',
          'guildId',
          'channelId',
        ]) ||
        !catalogId(destination.id) ||
        destinationIds.has(destination.id) ||
        catalogLabel(destination.label) !== destination.label ||
        !catalogId(destination.deliveryKey) ||
        deliveryKeys.has(destination.deliveryKey) ||
        typeof destination.guildId !== 'string' ||
        !SNOWFLAKE.test(destination.guildId) ||
        typeof destination.channelId !== 'string' ||
        !SNOWFLAKE.test(destination.channelId)
      )
        throw new Error();
      destinationIds.add(destination.id);
      deliveryKeys.add(destination.deliveryKey);
    }
    const subscriptions = new Set<string>();
    for (const subscription of raw.subscriptions) {
      if (
        !record(subscription) ||
        !exactKeys(subscription, ['feedId', 'destinationId']) ||
        typeof subscription.feedId !== 'string' ||
        !ids.has(subscription.feedId) ||
        typeof subscription.destinationId !== 'string' ||
        !destinationIds.has(subscription.destinationId)
      )
        throw new Error();
      const identity = `${subscription.feedId}:${subscription.destinationId}`;
      if (subscriptions.has(identity)) throw new Error();
      subscriptions.add(identity);
    }
    return raw as unknown as CatalogDocument;
  } catch {
    throw new ConfigurationError(
      'The saved feed catalog is invalid. Ask the operator to restore its last valid configuration.',
    );
  }
}

export function catalogRoutes(catalog: CatalogDocument): FeedRoute[] {
  const destinations = new Map(
    catalog.destinations.map((destination) => [
      destination.id,
      destination.deliveryKey,
    ]),
  );
  const subscriptions = new Map<string, string[]>();
  for (const subscription of catalog.subscriptions) {
    const values = subscriptions.get(subscription.feedId) ?? [];
    values.push(destinations.get(subscription.destinationId)!);
    subscriptions.set(subscription.feedId, values);
  }
  return catalog.feeds.flatMap((feed) => {
    const names = subscriptions.get(feed.id);
    return names?.length ? [{ url: feed.url, destinations: names }] : [];
  });
}
