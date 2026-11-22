import {
  AdminError,
  configurationRevision,
  readConfigurationSnapshot,
  sealWebhooks,
} from './admin-store.ts';
import type {
  ConfigurationEnv,
  ConfigurationRow,
  ConfigurationSnapshot,
} from './admin-store.ts';
import { canManageChannel } from './admin-policy.ts';
import type { AdminPermissions } from './admin-policy.ts';
import {
  catalogId,
  catalogLabel,
  catalogRoutes,
  exactKeys,
  MAX_CATALOG_BYTES,
  parseCatalog,
  record,
} from './catalog-document.ts';
import type {
  CatalogDocument,
  CatalogDestination,
} from './catalog-document.ts';
import type { CatalogOperation, CatalogSnapshot } from './catalog-types.ts';
import { feedUrl, loadConfig, validateWebhooks } from './config.ts';
import { ConfigurationError } from './config-store.ts';
import { verifyWebhook } from './webhook-verification.ts';
import type { Fetcher } from './types.ts';

function scoped(permissions: AdminPermissions) {
  if (
    permissions.mode !== 'scoped' ||
    (!permissions.addFeeds && permissions.channels.length === 0)
  )
    throw new AdminError(
      'Your current Discord roles do not grant catalog access.',
      403,
    );
}

function feedAdmin(permissions: AdminPermissions) {
  scoped(permissions);
  if (!permissions.addFeeds)
    throw new AdminError(
      'Your current Discord roles do not grant feed administration.',
      403,
    );
}

function destinationAdmin(
  permissions: AdminPermissions,
  target: { guildId: string; channelId: string },
) {
  scoped(permissions);
  if (!canManageChannel(permissions, target.guildId, target.channelId))
    throw new AdminError(
      'Your current Discord roles do not grant access to this destination channel.',
      403,
    );
}

function storedCatalog(before: ConfigurationSnapshot): CatalogDocument | null {
  if (!before.row?.catalog) return null;
  const catalog = parseCatalog(before.row.catalog);
  if (
    JSON.stringify(catalogRoutes(catalog)) !== before.row.feeds ||
    Object.keys(before.webhooks).length !== catalog.destinations.length ||
    catalog.destinations.some(
      (destination) => !Object.hasOwn(before.webhooks, destination.deliveryKey),
    )
  )
    throw new ConfigurationError(
      'The saved catalog and relay configuration disagree. Ask the operator to restore their last consistent version.',
    );
  return catalog;
}

function publicCatalog(
  catalog: CatalogDocument | null,
  revision: string,
  permissions: AdminPermissions,
): CatalogSnapshot {
  const destinations =
    catalog?.destinations.filter((destination) =>
      canManageChannel(permissions, destination.guildId, destination.channelId),
    ) ?? [];
  const visible = new Set(destinations.map((destination) => destination.id));
  return {
    mode: 'scoped',
    initialized: catalog !== null,
    revision,
    permissions: {
      addFeeds: permissions.addFeeds,
      channels: permissions.channels.map(({ guildId, channelId }) => ({
        guildId,
        channelId,
      })),
    },
    feeds: catalog?.feeds.map(({ id, label }) => ({ id, label })) ?? [],
    destinations: destinations.map(({ id, label, guildId, channelId }) => ({
      id,
      label,
      guildId,
      channelId,
    })),
    subscriptions:
      catalog?.subscriptions.filter((subscription) =>
        visible.has(subscription.destinationId),
      ) ?? [],
    maxBytes: MAX_CATALOG_BYTES,
  };
}

export async function readCatalog(
  env: ConfigurationEnv,
  key: CryptoKey,
  permissions: AdminPermissions,
): Promise<CatalogSnapshot> {
  scoped(permissions);
  const before = await readConfigurationSnapshot(env, key);
  return publicCatalog(storedCatalog(before), before.revision, permissions);
}

function operation(value: unknown): CatalogOperation {
  if (!record(value) || typeof value.type !== 'string')
    throw new AdminError('Provide one catalog operation.');
  const shapes: Record<string, string[]> = {
    initialize: ['type'],
    'feed.create': ['type', 'label', 'url'],
    'feed.rename': ['type', 'id', 'label'],
    'feed.delete': ['type', 'id'],
    'destination.create': ['type', 'label', 'webhookUrl'],
    'destination.rename': ['type', 'id', 'label'],
    'destination.rotate': ['type', 'id', 'webhookUrl'],
    'destination.delete': ['type', 'id'],
    'subscription.add': ['type', 'feedId', 'destinationId'],
    'subscription.remove': ['type', 'feedId', 'destinationId'],
  };
  const keys = Object.hasOwn(shapes, value.type)
    ? shapes[value.type]
    : undefined;
  if (!keys || !exactKeys(value, keys))
    throw new AdminError(
      'Provide one supported catalog operation with only its documented fields.',
    );
  for (const name of ['id', 'feedId', 'destinationId'])
    if (Object.hasOwn(value, name) && !catalogId(value[name]))
      throw new AdminError('Provide a valid catalog identity.');
  const parsed: Record<string, unknown> = { ...value };
  try {
    if (Object.hasOwn(parsed, 'label'))
      parsed.label = catalogLabel(parsed.label);
    if (Object.hasOwn(parsed, 'url')) parsed.url = feedUrl(parsed.url);
    if (
      Object.hasOwn(parsed, 'webhookUrl') &&
      typeof parsed.webhookUrl !== 'string'
    )
      throw new Error('Provide a valid Discord webhook URL.');
  } catch (error) {
    throw new AdminError(
      error instanceof Error ? error.message : 'Invalid catalog operation.',
    );
  }
  return parsed as unknown as CatalogOperation;
}

async function initialize(
  before: ConfigurationSnapshot,
  fetcher: Fetcher,
): Promise<CatalogDocument> {
  try {
    loadConfig(before.feeds, before.webhooks);
  } catch {
    throw new AdminError(
      'Existing routes have missing or invalid webhooks. Ask the operator to repair them before initializing the catalog.',
    );
  }
  const catalog: CatalogDocument = {
    version: 1,
    feeds: [],
    destinations: [],
    subscriptions: [],
  };
  const destinationIds = new Map<string, string>();
  for (const [deliveryKey, webhook] of Object.entries(before.webhooks)) {
    const verified = await verifyWebhook(webhook, fetcher);
    const id = `d_${crypto.randomUUID()}`;
    catalog.destinations.push({
      id,
      label: deliveryKey,
      deliveryKey,
      guildId: verified.guildId,
      channelId: verified.channelId,
    });
    destinationIds.set(deliveryKey, id);
  }
  for (const [index, feed] of before.feeds.entries()) {
    const id = `f_${crypto.randomUUID()}`;
    catalog.feeds.push({
      id,
      label: `Imported feed ${index + 1}`,
      url: feed.url,
    });
    for (const deliveryKey of feed.destinations)
      catalog.subscriptions.push({
        feedId: id,
        destinationId: destinationIds.get(deliveryKey)!,
      });
  }
  return catalog;
}

function findDestination(
  catalog: CatalogDocument,
  id: string,
): CatalogDestination {
  const destination = catalog.destinations.find(
    (candidate) => candidate.id === id,
  );
  if (!destination)
    throw new AdminError('Destination not found. Reload the catalog.', 404);
  return destination;
}

function findFeed(catalog: CatalogDocument, id: string) {
  const feed = catalog.feeds.find((candidate) => candidate.id === id);
  if (!feed) throw new AdminError('Feed not found. Reload the catalog.', 404);
  return feed;
}

export async function saveCatalog(
  env: ConfigurationEnv,
  key: CryptoKey,
  input: unknown,
  permissions: AdminPermissions,
  fetcher: Fetcher,
  recheck: () => Promise<AdminPermissions>,
): Promise<CatalogSnapshot> {
  scoped(permissions);
  if (
    !record(input) ||
    !exactKeys(input, ['revision', 'operation']) ||
    typeof input.revision !== 'string'
  )
    throw new AdminError(
      'Provide the current revision and one catalog operation.',
    );
  const action = operation(input.operation);
  const before = await readConfigurationSnapshot(env, key);
  if (input.revision !== before.revision)
    throw new AdminError(
      'Configuration changed. Reload it before saving your changes.',
      409,
    );
  let catalog = storedCatalog(before);
  if ((catalog === null) !== (action.type === 'initialize'))
    throw new AdminError(
      catalog === null
        ? 'Initialize the catalog before editing it.'
        : 'The catalog is already initialized.',
      409,
    );
  const webhooks: Record<string, string> = Object.assign(
    Object.create(null),
    before.webhooks,
  );
  let authorize: (current: AdminPermissions) => void = scoped;
  if (action.type === 'initialize') {
    catalog = await initialize(before, fetcher);
  } else {
    const document = catalog!;
    switch (action.type) {
      case 'feed.create': {
        authorize = feedAdmin;
        authorize(permissions);
        if (document.feeds.some((feed) => feed.url === action.url))
          throw new AdminError(
            'This feed source is already in the catalog. Use its existing identity.',
          );
        document.feeds.push({
          id: `f_${crypto.randomUUID()}`,
          label: action.label,
          url: action.url,
        });
        break;
      }
      case 'feed.rename': {
        authorize = feedAdmin;
        authorize(permissions);
        findFeed(document, action.id).label = action.label;
        break;
      }
      case 'feed.delete': {
        authorize = feedAdmin;
        authorize(permissions);
        findFeed(document, action.id);
        if (
          document.subscriptions.some(
            (subscription) => subscription.feedId === action.id,
          )
        )
          throw new AdminError(
            'Remove every subscription before deleting this feed. Other destination administrators may still use it.',
          );
        document.feeds = document.feeds.filter((feed) => feed.id !== action.id);
        break;
      }
      case 'destination.create': {
        const verified = await verifyWebhook(action.webhookUrl, fetcher);
        authorize = (current) => destinationAdmin(current, verified);
        authorize(permissions);
        const id = `d_${crypto.randomUUID()}`;
        document.destinations.push({
          id,
          label: action.label,
          deliveryKey: id,
          guildId: verified.guildId,
          channelId: verified.channelId,
        });
        webhooks[id] = verified.url;
        break;
      }
      case 'destination.rotate': {
        const destination = findDestination(document, action.id);
        authorize = (current) => destinationAdmin(current, destination);
        authorize(permissions);
        const verified = await verifyWebhook(action.webhookUrl, fetcher);
        if (
          verified.guildId !== destination.guildId ||
          verified.channelId !== destination.channelId
        )
          throw new AdminError(
            'Replacement webhooks must target the same server and channel. Create a new destination to move subscriptions explicitly.',
          );
        webhooks[destination.deliveryKey] = verified.url;
        break;
      }
      case 'destination.rename': {
        const destination = findDestination(document, action.id);
        authorize = (current) => destinationAdmin(current, destination);
        authorize(permissions);
        destination.label = action.label;
        break;
      }
      case 'destination.delete': {
        const destination = findDestination(document, action.id);
        authorize = (current) => destinationAdmin(current, destination);
        authorize(permissions);
        if (
          document.subscriptions.some(
            (subscription) => subscription.destinationId === destination.id,
          )
        )
          throw new AdminError(
            'Remove all subscriptions before deleting this destination.',
          );
        document.destinations = document.destinations.filter(
          (candidate) => candidate.id !== destination.id,
        );
        delete webhooks[destination.deliveryKey];
        break;
      }
      case 'subscription.add':
      case 'subscription.remove': {
        const destination = findDestination(document, action.destinationId);
        authorize = (current) => destinationAdmin(current, destination);
        authorize(permissions);
        findFeed(document, action.feedId);
        const matches = (subscription: {
          feedId: string;
          destinationId: string;
        }) =>
          subscription.feedId === action.feedId &&
          subscription.destinationId === action.destinationId;
        if (action.type === 'subscription.add') {
          if (document.subscriptions.some(matches))
            throw new AdminError(
              'This destination is already subscribed to the feed.',
            );
          document.subscriptions.push({
            feedId: action.feedId,
            destinationId: action.destinationId,
          });
        } else {
          if (!document.subscriptions.some(matches))
            throw new AdminError(
              'This destination is not subscribed to the feed.',
            );
          document.subscriptions = document.subscriptions.filter(
            (subscription) => !matches(subscription),
          );
        }
        break;
      }
    }
  }
  const document = catalog!;
  const feeds = catalogRoutes(document);
  try {
    validateWebhooks(webhooks);
  } catch {
    throw new AdminError(
      'Each destination must have a distinct valid Discord webhook URL.',
    );
  }
  if (
    new TextEncoder().encode(
      JSON.stringify({ catalog: document, feeds, webhooks }),
    ).byteLength > MAX_CATALOG_BYTES
  )
    throw new AdminError(
      'The complete feed catalog exceeds the 96 KiB configuration limit.',
      413,
    );
  const storedCatalogText = JSON.stringify(document);
  parseCatalog(storedCatalogText);
  const encrypted = await sealWebhooks(webhooks, key);
  const storedFeeds = JSON.stringify(feeds);
  // Provider lookups and body reads can outlive membership or a policy change.
  const currentPermissions = await recheck();
  scoped(currentPermissions);
  authorize(currentPermissions);
  const result =
    before.row === null
      ? await env.DB.prepare(
          `
      INSERT INTO relay_configuration (id, feeds, encrypted_webhooks, catalog, updated_at_ms)
      SELECT 1, ?, ?, ?, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      WHERE NOT EXISTS (SELECT 1 FROM relay_configuration WHERE id = 1)
    `,
        )
          .bind(storedFeeds, encrypted, storedCatalogText)
          .run()
      : await env.DB.prepare(
          `
      UPDATE relay_configuration SET feeds = ?, encrypted_webhooks = ?, catalog = ?,
        updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      WHERE id = 1 AND feeds = ? AND encrypted_webhooks IS ? AND catalog IS ?
    `,
        )
          .bind(
            storedFeeds,
            encrypted,
            storedCatalogText,
            before.row.feeds,
            before.row.encrypted_webhooks,
            before.row.catalog,
          )
          .run();
  if (result.meta.changes !== 1)
    throw new AdminError(
      'Configuration changed. Reload it before saving your changes.',
      409,
    );
  const row: ConfigurationRow = {
    feeds: storedFeeds,
    encrypted_webhooks: encrypted,
    catalog: storedCatalogText,
  };
  return publicCatalog(
    document,
    await configurationRevision(row),
    currentPermissions,
  );
}
