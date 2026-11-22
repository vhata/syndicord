import type {
  CatalogOperation,
  CatalogSnapshot,
  ChannelScope,
} from '../src/catalog-types.ts';
import { adminTransport, type AdminFetch } from './admin.ts';
import type { Environment } from './cloudflare.ts';

const INVALID_RESPONSE = 'The catalog API returned an invalid response.';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SNOWFLAKE = /^\d{1,20}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scope(value: unknown): ChannelScope {
  if (
    !record(value) ||
    typeof value.guildId !== 'string' ||
    !SNOWFLAKE.test(value.guildId) ||
    typeof value.channelId !== 'string' ||
    !SNOWFLAKE.test(value.channelId)
  )
    throw new Error(INVALID_RESPONSE);
  return { guildId: value.guildId, channelId: value.channelId };
}

function entity(value: unknown): { id: string; label: string } {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !ID.test(value.id) ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label.length > 100
  )
    throw new Error(INVALID_RESPONSE);
  return { id: value.id, label: value.label };
}

export function catalogSnapshot(value: unknown): CatalogSnapshot {
  if (
    !record(value) ||
    value.mode !== 'scoped' ||
    typeof value.initialized !== 'boolean' ||
    typeof value.revision !== 'string' ||
    !value.revision ||
    value.revision.length > 256 ||
    !record(value.permissions) ||
    typeof value.permissions.addFeeds !== 'boolean' ||
    !Array.isArray(value.permissions.channels) ||
    !Array.isArray(value.feeds) ||
    !Array.isArray(value.destinations) ||
    !Array.isArray(value.subscriptions) ||
    !Number.isSafeInteger(value.maxBytes) ||
    Number(value.maxBytes) <= 0
  )
    throw new Error(INVALID_RESPONSE);
  const feeds = value.feeds.map(entity);
  const destinations = value.destinations.map((entry) => ({
    ...entity(entry),
    ...scope(entry),
  }));
  const feedIds = new Set(feeds.map((entry) => entry.id));
  const destinationIds = new Set(destinations.map((entry) => entry.id));
  if (
    feedIds.size !== feeds.length ||
    destinationIds.size !== destinations.length
  )
    throw new Error(INVALID_RESPONSE);
  const subscriptions = value.subscriptions.map((entry) => {
    if (
      !record(entry) ||
      typeof entry.feedId !== 'string' ||
      typeof entry.destinationId !== 'string' ||
      !feedIds.has(entry.feedId) ||
      !destinationIds.has(entry.destinationId)
    )
      throw new Error(INVALID_RESPONSE);
    return { feedId: entry.feedId, destinationId: entry.destinationId };
  });
  if (
    new Set(
      subscriptions.map((entry) => `${entry.feedId}:${entry.destinationId}`),
    ).size !== subscriptions.length
  )
    throw new Error(INVALID_RESPONSE);
  return {
    mode: 'scoped',
    initialized: value.initialized,
    revision: value.revision,
    permissions: {
      addFeeds: value.permissions.addFeeds,
      channels: value.permissions.channels.map(scope),
    },
    feeds,
    destinations,
    subscriptions,
    maxBytes: Number(value.maxBytes),
  };
}

export function catalogClient(env: Environment, fetcher: AdminFetch = fetch) {
  const request = adminTransport(
    env,
    fetcher,
    '/admin/api/catalog',
    catalogSnapshot,
    256 * 1024,
  );
  return {
    read: () => request('GET'),
    mutate: (current: CatalogSnapshot, operation: CatalogOperation) =>
      request('POST', { revision: current.revision, operation }),
  };
}

export const CATALOG_USAGE = `Scoped configuration commands:
  catalog list                         List shared feeds without source URLs
  catalog initialize                   Verify and import existing configuration
  catalog add --file FILE|-             Add a feed from {"label":"…","url":"…"}
  catalog rename ID LABEL               Rename a feed without changing its source
  catalog remove ID                     Delete a feed with no subscriptions
  destinations list                    List your authorized destinations
  destinations register --file FILE|-   Register {"label":"…","webhookUrl":"…"}
  destinations rename ID LABEL          Rename a destination
  destinations rotate ID --file FILE|-  Replace credentials from {"webhookUrl":"…"}
  destinations remove ID                Delete an unused destination
  subscriptions list                   List your destination subscriptions
  subscriptions add FEED_ID DEST_ID     Subscribe a destination to a catalog feed
  subscriptions remove FEED_ID DEST_ID  Remove one destination subscription

Initialize verifies saved webhooks and imports the existing catalog and routes.
The import leaves routes unchanged and does not grant additional permissions. Failed verification leaves the configuration
unchanged. Source URLs are immutable: add a new feed and explicitly change each
authorized destination's subscription. Keep URL files private; URLs are not shown
by list commands.`;

function id(value: string | undefined): string {
  if (!value || !ID.test(value))
    throw new Error('Provide a feed or destination ID from its list command.');
  return value;
}

function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100)
    throw new Error('Provide a label of 1 to 100 characters.');
  return value.trim();
}

async function file(
  args: string[],
  input: (path: string) => Promise<unknown>,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (
    args.length !== 2 ||
    args[0] !== '--file' ||
    !args[1] ||
    args[1].startsWith('--')
  )
    throw new Error('Expected --file FILE (or --file - for stdin).');
  const value = await input(args[1]);
  if (
    !record(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => typeof value[key] !== 'string')
  )
    throw new Error(
      `Provide a JSON object containing only ${keys.join(' and ')}.`,
    );
  return value;
}

export async function runCatalogCommand(
  command: string,
  args: string[],
  env: Environment,
  fetcher: AdminFetch | undefined,
  input: (path: string) => Promise<unknown>,
): Promise<string> {
  if (args.includes('--local'))
    throw new Error(
      'Configuration commands do not use --local. Set SYNDICORD_ADMIN_URL to a loopback URL to edit a local Worker.',
    );
  const client = catalogClient(env, fetcher);
  if (args.length === 1 && args[0] === 'list') {
    const current = await client.read();
    if (!current.initialized)
      throw new Error(
        'The scoped catalog is not initialized. An administrator must run syndicord catalog initialize first.',
      );
    return JSON.stringify(
      command === 'catalog'
        ? current.feeds
        : command === 'destinations'
          ? current.destinations
          : current.subscriptions,
      null,
      2,
    );
  }
  let operation: CatalogOperation;
  const [action, ...rest] = args;
  if (command === 'catalog' && action === 'initialize' && rest.length === 0)
    operation = { type: 'initialize' };
  else if (command === 'catalog' && action === 'add') {
    const value = await file(rest, input, ['label', 'url']);
    operation = {
      type: 'feed.create',
      label: label(value.label),
      url: value.url as string,
    };
  } else if (command === 'destinations' && action === 'register') {
    const value = await file(rest, input, ['label', 'webhookUrl']);
    operation = {
      type: 'destination.create',
      label: label(value.label),
      webhookUrl: value.webhookUrl as string,
    };
  } else if (command === 'destinations' && action === 'rotate') {
    const value = await file(rest.slice(1), input, ['webhookUrl']);
    operation = {
      type: 'destination.rotate',
      id: id(rest[0]),
      webhookUrl: value.webhookUrl as string,
    };
  } else if (
    ['catalog', 'destinations'].includes(command) &&
    action === 'rename' &&
    rest.length === 2
  )
    operation = {
      type: command === 'catalog' ? 'feed.rename' : 'destination.rename',
      id: id(rest[0]),
      label: label(rest[1]),
    };
  else if (
    ['catalog', 'destinations'].includes(command) &&
    action === 'remove' &&
    rest.length === 1
  )
    operation = {
      type: command === 'catalog' ? 'feed.delete' : 'destination.delete',
      id: id(rest[0]),
    };
  else if (
    command === 'subscriptions' &&
    ['add', 'remove'].includes(action ?? '') &&
    rest.length === 2
  )
    operation = {
      type: action === 'add' ? 'subscription.add' : 'subscription.remove',
      feedId: id(rest[0]),
      destinationId: id(rest[1]),
    };
  else throw new Error(CATALOG_USAGE);
  const current = await client.read();
  if (!current.initialized && operation.type !== 'initialize')
    throw new Error(
      'The scoped catalog is not initialized. An administrator must run syndicord catalog initialize first.',
    );
  if (current.initialized && operation.type === 'initialize')
    return 'The scoped catalog is already initialized.';
  await client.mutate(current, operation);
  return operation.type === 'initialize'
    ? 'Initialized the scoped catalog. Existing subscriptions are unchanged.'
    : 'Saved the catalog change. Delivery uses the updated configuration on its next scheduled run.';
}
