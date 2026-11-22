import {
  loadConfig,
  loadFeeds,
  validateConfigurationSize,
  validateWebhooks,
} from './config.ts';
import type { RelayConfig } from './config.ts';
import { ConfigurationError, parseStoredFeeds } from './config-store.ts';
import type { FeedRoute } from './types.ts';
import { catalogRoutes, parseCatalog } from './catalog-document.ts';

export interface ConfigurationEnv {
  DB: D1Database;
  CONFIG_ENCRYPTION_KEY?: string;
}

export interface ConfigurationRow {
  feeds: string;
  encrypted_webhooks: string | null;
  catalog: string | null;
}

export interface ConfigurationSnapshot {
  row: ConfigurationRow | null;
  feeds: FeedRoute[];
  webhooks: Record<string, string>;
  revision: string;
}

export class AdminError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const READ_CONFIGURATION =
  'SELECT feeds, encrypted_webhooks, catalog FROM relay_configuration WHERE id = 1';
const encoder = new TextEncoder();
const ENCRYPTION_CONTEXT = encoder.encode('syndicord-webhooks-v1');

function base64(bytes: Uint8Array): string {
  // Ciphertexts can exceed the argument limit of String.fromCharCode(...bytes).
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function configurationKey(value: unknown): Promise<CryptoKey> {
  try {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))
      throw new Error();
    const bytes = unbase64(value);
    if (bytes.length !== 32 || base64(bytes) !== value) throw new Error();
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  } catch {
    throw new ConfigurationError(
      'Configure CONFIG_ENCRYPTION_KEY with a base64-encoded 32-byte key before using the web interface.',
    );
  }
}

export async function sealWebhooks(
  webhooks: Record<string, string>,
  key: CryptoKey,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ENCRYPTION_CONTEXT },
    key,
    encoder.encode(JSON.stringify(webhooks)),
  );
  return `v1.${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}

async function open(value: string, key: CryptoKey) {
  try {
    const [version, rawIv, rawCiphertext, extra] = value.split('.');
    if (version !== 'v1' || !rawIv || !rawCiphertext || extra !== undefined)
      throw new Error();
    const iv = unbase64(rawIv);
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: ENCRYPTION_CONTEXT },
      key,
      unbase64(rawCiphertext),
    );
    return validateWebhooks(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          plaintext,
        ),
      ),
    );
  } catch {
    throw new ConfigurationError(
      'Cannot read saved webhooks. Check CONFIG_ENCRYPTION_KEY and the stored configuration.',
    );
  }
}

export async function configurationRevision(row: ConfigurationRow | null) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(
      JSON.stringify([
        row?.feeds ?? null,
        row?.encrypted_webhooks ?? null,
        row?.catalog ?? null,
      ]),
    ),
  );
  return base64(new Uint8Array(digest));
}

export async function readConfigurationSnapshot(
  env: ConfigurationEnv,
  key: CryptoKey,
): Promise<ConfigurationSnapshot> {
  const row =
    await env.DB.prepare(READ_CONFIGURATION).first<ConfigurationRow>();
  const feeds =
    row === null
      ? []
      : row.catalog === null
        ? parseStoredFeeds(row.feeds)
        : catalogRoutes(parseCatalog(row.catalog));
  const webhooks =
    row?.encrypted_webhooks !== null && row?.encrypted_webhooks !== undefined
      ? await open(row.encrypted_webhooks, key)
      : Object.create(null);
  return {
    row,
    feeds,
    webhooks,
    revision: await configurationRevision(row),
  };
}

export async function hasCatalog(env: ConfigurationEnv): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT catalog FROM relay_configuration WHERE id = 1',
  ).first<{ catalog: string | null }>();
  return row?.catalog !== null && row?.catalog !== undefined;
}

function requireLegacy(value: ConfigurationSnapshot) {
  if (value.row?.catalog !== null && value.row?.catalog !== undefined)
    throw new AdminError(
      'This installation uses scoped permissions. Ask the operator to configure DISCORD_AUTH_POLICY and use the feed catalog.',
      403,
    );
}

function publicSnapshot(value: ConfigurationSnapshot) {
  return {
    feeds: value.feeds,
    destinations: Object.keys(value.webhooks).sort(),
    revision: value.revision,
    maxRoutes: null,
  };
}

export async function readAdminConfiguration(
  env: ConfigurationEnv,
  key: CryptoKey,
) {
  const value = await readConfigurationSnapshot(env, key);
  requireLegacy(value);
  return publicSnapshot(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function saveAdminConfiguration(
  env: ConfigurationEnv,
  key: CryptoKey,
  input: unknown,
) {
  if (
    !record(input) ||
    typeof input.revision !== 'string' ||
    !record(input.webhooks) ||
    Object.keys(input).some(
      (name) => !['revision', 'feeds', 'webhooks'].includes(name),
    )
  )
    throw new AdminError('Provide a revision, feed list, and webhook changes.');
  const before = await readConfigurationSnapshot(env, key);
  requireLegacy(before);
  if (input.revision !== before.revision)
    throw new AdminError(
      'Configuration changed. Reload it before saving your changes.',
      409,
    );
  let feeds: FeedRoute[];
  let webhooks: Record<string, string>;
  try {
    feeds = loadFeeds(input.feeds);
    const merged = Object.assign(Object.create(null), before.webhooks);
    for (const [name, value] of Object.entries(input.webhooks)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
        throw new Error(
          'Destination names must start with a letter and contain at most 64 letters, digits, underscores or hyphens.',
        );
      if (value === null) delete merged[name];
      else if (typeof value === 'string') merged[name] = value;
      else
        throw new Error(
          'Webhook changes must be URLs or null to remove a destination.',
        );
    }
    webhooks = validateWebhooks(merged);
    loadConfig(feeds, webhooks);
    validateConfigurationSize(feeds, webhooks);
  } catch (error) {
    // These validators return fixed messages or already validated destination names.
    throw new AdminError(
      error instanceof Error ? error.message : 'Invalid configuration.',
    );
  }
  const encrypted = await sealWebhooks(webhooks, key);
  const storedFeeds = JSON.stringify(feeds);
  const result =
    before.row === null
      ? await env.DB.prepare(
          `
        INSERT INTO relay_configuration (id, feeds, encrypted_webhooks, updated_at_ms)
        SELECT 1, ?, ?, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        WHERE NOT EXISTS (SELECT 1 FROM relay_configuration WHERE id = 1)
      `,
        )
          .bind(storedFeeds, encrypted)
          .run()
      : await env.DB.prepare(
          `
        UPDATE relay_configuration SET feeds = ?, encrypted_webhooks = ?,
          updated_at_ms = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        WHERE id = 1 AND feeds = ? AND encrypted_webhooks IS ? AND catalog IS NULL
      `,
        )
          .bind(
            storedFeeds,
            encrypted,
            before.row.feeds,
            before.row.encrypted_webhooks,
          )
          .run();
  if (result.meta.changes !== 1)
    throw new AdminError(
      'Configuration changed. Reload it before saving your changes.',
      409,
    );
  const row = {
    feeds: storedFeeds,
    encrypted_webhooks: encrypted,
    catalog: null,
  };
  return publicSnapshot({
    row,
    feeds,
    webhooks,
    revision: await configurationRevision(row),
  });
}

export async function readRelayConfiguration(
  env: ConfigurationEnv,
): Promise<RelayConfig> {
  // One row read keeps routes and encrypted destinations from the same save.
  const row =
    await env.DB.prepare(READ_CONFIGURATION).first<ConfigurationRow>();
  if (row === null) return { feeds: [], webhooks: Object.create(null) };
  if (row.catalog !== null) {
    const catalog = parseCatalog(row.catalog);
    const feeds = catalogRoutes(catalog);
    if (JSON.stringify(feeds) !== row.feeds || row.encrypted_webhooks === null)
      throw new ConfigurationError(
        'The saved catalog and relay configuration disagree. Ask the operator to restore their last consistent version.',
      );
    const webhooks = await open(
      row.encrypted_webhooks,
      await configurationKey(env.CONFIG_ENCRYPTION_KEY),
    );
    const destinationBindings: Record<
      string,
      { guildId: string; channelId: string }
    > = Object.create(null);
    for (const destination of catalog.destinations) {
      if (!Object.hasOwn(webhooks, destination.deliveryKey))
        throw new ConfigurationError(
          'A saved catalog destination has no webhook.',
        );
      destinationBindings[destination.deliveryKey] = {
        guildId: destination.guildId,
        channelId: destination.channelId,
      };
    }
    if (Object.keys(webhooks).length !== catalog.destinations.length)
      throw new ConfigurationError(
        'The saved catalog and webhook destinations disagree.',
      );
    return { feeds, webhooks, destinationBindings };
  }
  const feeds = parseStoredFeeds(row.feeds);
  if (row.encrypted_webhooks === null) return loadConfig(feeds, {});
  const webhooks = await open(
    row.encrypted_webhooks,
    await configurationKey(env.CONFIG_ENCRYPTION_KEY),
  );
  return loadConfig(feeds, webhooks);
}
