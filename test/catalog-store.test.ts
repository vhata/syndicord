import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminError,
  configurationKey,
  hasCatalog,
  readAdminConfiguration,
  readRelayConfiguration,
  saveAdminConfiguration,
} from '../src/admin-store.ts';
import type { AdminPermissions } from '../src/admin-policy.ts';
import { readCatalog, saveCatalog } from '../src/catalog-store.ts';
import type { CatalogOperation } from '../src/catalog-types.ts';
import { createTestDatabase } from './helpers/d1.ts';
import type { Fetcher } from '../src/types.ts';

const guildA = '100000000000000001';
const guildB = '100000000000000002';
const channelA = '200000000000000001';
const channelB = '200000000000000002';
const keyText = Buffer.alloc(32, 9).toString('base64');
const webhook = (id: string) =>
  `https://discord.com/api/webhooks/${id}/private-token-${id}`;
const all: AdminPermissions = {
  mode: 'scoped',
  addFeeds: true,
  channels: [
    { guildId: guildA, channelId: channelA },
    { guildId: guildB, channelId: channelB },
  ],
};
const routeA: AdminPermissions = {
  mode: 'scoped',
  addFeeds: false,
  channels: [all.channels[0]!],
};
const routeB: AdminPermissions = {
  mode: 'scoped',
  addFeeds: false,
  channels: [all.channels[1]!],
};
const feedOnly: AdminPermissions = {
  mode: 'scoped',
  addFeeds: true,
  channels: [],
};
const status = (expected: number) => (error: unknown) =>
  error instanceof AdminError && error.status === expected;

async function fixture() {
  const database = await createTestDatabase();
  const key = await configurationKey(keyText);
  const env = { DB: database.db, CONFIG_ENCRYPTION_KEY: keyText };
  const targets = new Map([
    ['11', { guildId: guildA, channelId: channelA }],
    ['12', { guildId: guildA, channelId: channelA }],
    ['21', { guildId: guildB, channelId: channelB }],
  ]);
  const requests: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    requests.push(url);
    const id = new URL(url).pathname.split('/').at(-2)!;
    const target = targets.get(id);
    return target
      ? Response.json({
          id,
          type: 1,
          guild_id: target.guildId,
          channel_id: target.channelId,
        })
      : Response.json({ error: 'private-provider-error' }, { status: 404 });
  };
  const read = (permissions = all) => readCatalog(env, key, permissions);
  const mutate = async (
    operation: CatalogOperation,
    permissions = all,
    recheck = async () => permissions,
  ) =>
    saveCatalog(
      env,
      key,
      { revision: (await read(permissions)).revision, operation },
      permissions,
      fetcher,
      recheck,
    );
  const stored = () =>
    database.db
      .prepare('SELECT * FROM relay_configuration WHERE id = 1')
      .first();
  const seed = async () => {
    const before = await readAdminConfiguration(env, key);
    return saveAdminConfiguration(env, key, {
      revision: before.revision,
      feeds: [
        {
          url: 'https://feeds.example/source?secret=private-source',
          destinations: ['updates', 'other'],
        },
      ],
      webhooks: { updates: webhook('11'), other: webhook('21') },
    });
  };
  return {
    ...database,
    env,
    key,
    read,
    mutate,
    stored,
    seed,
    fetcher,
    targets,
    requests,
  };
}

test('initialization verifies existing credentials and preserves delivery identities and ledger state', async () => {
  const f = await fixture();
  try {
    await f.seed();
    const old = await readRelayConfiguration(f.env);
    await f.db
      .prepare("INSERT INTO relay_routes VALUES (?, 'updates', 'baseline', 1)")
      .bind(old.feeds[0]!.url)
      .run();
    await f.db
      .prepare(
        "INSERT INTO relay_deliveries VALUES (?, 'updates', 'item', 'pending', '{}', 2, 1, 2, 'network_error')",
      )
      .bind(old.feeds[0]!.url)
      .run();
    const ledgerBefore = await f.db
      .prepare('SELECT * FROM relay_deliveries')
      .all();
    assert.equal((await f.read()).initialized, false);
    const publicBefore = JSON.stringify(await f.read(routeA));
    assert.doesNotMatch(publicBefore, /private-source|private-token|updates/);
    const initialized = await f.mutate({ type: 'initialize' }, routeA);
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.feeds.length, 1);
    assert.match(
      initialized.feeds[0]!.id,
      /^f_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(initialized.destinations.length, 1);
    assert.equal(initialized.destinations[0]!.label, 'updates');
    assert.equal(initialized.subscriptions.length, 1);
    assert.equal(f.requests.length, 2);
    assert.doesNotMatch(
      JSON.stringify(initialized),
      /private-source|private-token|https:/,
    );
    const current = await readRelayConfiguration(f.env);
    assert.deepEqual(current.feeds, old.feeds);
    assert.deepEqual(current.webhooks, old.webhooks);
    assert.deepEqual(current.destinationBindings?.updates, all.channels[0]);
    assert.deepEqual(
      (await f.db.prepare('SELECT * FROM relay_deliveries').all()).results,
      ledgerBefore.results,
    );
    assert.equal(await hasCatalog(f.env), true);
    await assert.rejects(readAdminConfiguration(f.env, f.key), status(403));
    await assert.rejects(
      saveAdminConfiguration(f.env, f.key, {
        revision: initialized.revision,
        feeds: [],
        webhooks: {},
      }),
      status(403),
    );
  } finally {
    await f.dispose();
  }
});

test('initialization rejects failed verification, threads and missing credentials without changing legacy configuration', async () => {
  for (const mode of ['failed', 'thread', 'missing']) {
    const f = await fixture();
    try {
      await f.seed();
      if (mode === 'failed') f.targets.delete('21');
      if (mode === 'thread') {
        const before = await readAdminConfiguration(f.env, f.key);
        await saveAdminConfiguration(f.env, f.key, {
          revision: before.revision,
          feeds: before.feeds,
          webhooks: { updates: webhook('11') + '?thread_id=123' },
        });
      }
      if (mode === 'missing')
        await f.db
          .prepare('UPDATE relay_configuration SET encrypted_webhooks = NULL')
          .run();
      const before = await f.stored();
      await assert.rejects(f.mutate({ type: 'initialize' }), status(400));
      assert.deepEqual(await f.stored(), before);
      assert.equal(await hasCatalog(f.env), false);
    } finally {
      await f.dispose();
    }
  }
});

test('feed creation is separate from routing and URL replacements never transfer subscriptions', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.mutate({ type: 'initialize' });
    const original = (await f.read()).feeds[0]!;
    const before = await f.stored();
    await assert.rejects(
      f.mutate(
        {
          type: 'feed.create',
          label: 'Unauthorized',
          url: 'https://feeds.example/new',
        },
        routeA,
      ),
      status(403),
    );
    assert.deepEqual(await f.stored(), before);
    const created = await f.mutate(
      {
        type: 'feed.create',
        label: 'Replacement',
        url: 'https://feeds.example/replacement?private=secret',
      },
      feedOnly,
    );
    const replacement = created.feeds.find(
      (feed) => feed.label === 'Replacement',
    )!;
    assert.notEqual(replacement.id, original.id);
    const allBefore = await f.read();
    assert.equal(allBefore.subscriptions.length, 2);
    assert(
      allBefore.subscriptions.every(
        (subscription) => subscription.feedId === original.id,
      ),
    );
    assert.equal((await readRelayConfiguration(f.env)).feeds.length, 1);
    await f.mutate(
      { type: 'feed.rename', id: original.id, label: 'Original renamed' },
      feedOnly,
    );
    assert.equal(
      (await f.read()).feeds.find((feed) => feed.id === original.id)!.label,
      'Original renamed',
    );
    await assert.rejects(
      f.mutate({ type: 'feed.delete', id: original.id }, feedOnly),
      /every subscription/,
    );
    const destination = (await f.read(routeA)).destinations[0]!;
    await f.mutate(
      {
        type: 'subscription.add',
        feedId: replacement.id,
        destinationId: destination.id,
      },
      routeA,
    );
    await f.mutate(
      {
        type: 'subscription.remove',
        feedId: original.id,
        destinationId: destination.id,
      },
      routeA,
    );
    assert.deepEqual(
      (await f.read(routeB)).subscriptions.map(
        (subscription) => subscription.feedId,
      ),
      [original.id],
    );
    assert.deepEqual(
      (await f.read(routeA)).subscriptions.map(
        (subscription) => subscription.feedId,
      ),
      [replacement.id],
    );
    await assert.rejects(
      f.mutate({ type: 'feed.delete', id: original.id }, feedOnly),
      /every subscription/,
    );
  } finally {
    await f.dispose();
  }
});

test('scoped writes reject bulk omissions, source edits, client grants and unknown fields', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.mutate({ type: 'initialize' });
    const current = await f.read();
    const before = await f.stored();
    const bodies = [
      { revision: current.revision, feeds: [], webhooks: {} },
      { revision: current.revision, operations: [] },
      {
        revision: current.revision,
        operation: {
          type: 'feed.rename',
          id: current.feeds[0]!.id,
          label: 'Changed',
          url: 'https://evil.example/',
        },
      },
      {
        revision: current.revision,
        operation: {
          type: 'feed.create',
          label: 'New',
          url: 'https://feeds.example/',
          id: current.feeds[0]!.id,
        },
      },
      {
        revision: current.revision,
        operation: { type: 'initialize', feeds: [] },
      },
      {
        revision: current.revision,
        operation: { type: 'feed.delete', id: current.feeds[0]!.id },
        permissions: all,
      },
      {
        revision: current.revision,
        operation: { type: 'policy.set', grants: [] },
      },
    ];
    for (const body of bodies) {
      await assert.rejects(
        saveCatalog(f.env, f.key, body, all, f.fetcher, async () => all),
        status(400),
      );
      assert.deepEqual(await f.stored(), before);
    }
    await assert.rejects(
      f.mutate({
        type: 'feed.create',
        label: 'Duplicate',
        url: 'https://feeds.example/source?secret=private-source',
      }),
      /already in the catalog/,
    );
  } finally {
    await f.dispose();
  }
});

test('destination registration, rename, rotation, subscriptions and deletion enforce the verified channel scope', async () => {
  const f = await fixture();
  try {
    await f.mutate({ type: 'initialize' });
    await f.mutate(
      { type: 'feed.create', label: 'Unrouted', url: 'https://feeds.example/' },
      feedOnly,
    );
    const feed = (await f.read()).feeds[0]!;
    await assert.rejects(
      f.mutate(
        {
          type: 'destination.create',
          label: 'Outside',
          webhookUrl: webhook('21'),
        },
        routeA,
      ),
      status(403),
    );
    await assert.rejects(
      f.mutate(
        {
          type: 'destination.create',
          label: 'Outside',
          webhookUrl: webhook('11'),
        },
        feedOnly,
      ),
      status(403),
    );
    const created = await f.mutate(
      {
        type: 'destination.create',
        label: 'Updates',
        webhookUrl: webhook('11'),
      },
      routeA,
    );
    const destination = created.destinations[0]!;
    assert.equal(created.subscriptions.length, 0);
    assert.equal((await f.read(routeB)).destinations.length, 0);
    const prohibited: CatalogOperation[] = [
      { type: 'destination.rename', id: destination.id, label: 'Takeover' },
      {
        type: 'destination.rotate',
        id: destination.id,
        webhookUrl: webhook('21'),
      },
      { type: 'destination.delete', id: destination.id },
      {
        type: 'subscription.add',
        feedId: feed.id,
        destinationId: destination.id,
      },
      {
        type: 'subscription.remove',
        feedId: feed.id,
        destinationId: destination.id,
      },
    ];
    for (const action of prohibited)
      await assert.rejects(f.mutate(action, routeB), status(403));
    await f.mutate(
      {
        type: 'subscription.add',
        feedId: feed.id,
        destinationId: destination.id,
      },
      routeA,
    );
    await assert.rejects(
      f.mutate({ type: 'destination.delete', id: destination.id }, routeA),
      /Remove all subscriptions/,
    );
    await assert.rejects(
      f.mutate({
        type: 'destination.rotate',
        id: destination.id,
        webhookUrl: webhook('21'),
      }),
      /same server and channel/,
    );
    await f.mutate(
      {
        type: 'destination.rotate',
        id: destination.id,
        webhookUrl: webhook('12'),
      },
      routeA,
    );
    await f.mutate(
      { type: 'destination.rename', id: destination.id, label: 'Renamed' },
      routeA,
    );
    let relay = await readRelayConfiguration(f.env);
    assert.equal(relay.feeds[0]!.destinations[0], destination.id);
    assert.equal(relay.webhooks[destination.id], webhook('12'));
    await f.mutate(
      {
        type: 'subscription.remove',
        feedId: feed.id,
        destinationId: destination.id,
      },
      routeA,
    );
    await f.mutate({ type: 'destination.delete', id: destination.id }, routeA);
    const recreated = await f.mutate(
      {
        type: 'destination.create',
        label: 'Renamed',
        webhookUrl: webhook('11'),
      },
      routeA,
    );
    assert.notEqual(recreated.destinations[0]!.id, destination.id);
    assert.deepEqual(recreated.subscriptions, []);
    relay = await readRelayConfiguration(f.env);
    assert.deepEqual(relay.feeds, []);
    await f.mutate({ type: 'feed.delete', id: feed.id }, feedOnly);
    assert.deepEqual((await f.read()).feeds, []);
  } finally {
    await f.dispose();
  }
});

test('permissions are rechecked after webhook lookup and immediately before storage', async () => {
  const f = await fixture();
  try {
    await f.mutate({ type: 'initialize' });
    const before = await f.stored();
    await assert.rejects(
      f.mutate(
        {
          type: 'feed.create',
          label: 'Revoked',
          url: 'https://feeds.example/revoked',
        },
        all,
        async () => routeA,
      ),
      status(403),
    );
    await assert.rejects(
      f.mutate(
        {
          type: 'destination.create',
          label: 'Revoked',
          webhookUrl: webhook('11'),
        },
        all,
        async () => feedOnly,
      ),
      status(403),
    );
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await f.stored(), before);
    await assert.rejects(
      f.mutate(
        {
          type: 'feed.create',
          label: 'Legacy',
          url: 'https://feeds.example/legacy',
        },
        all,
        async () => ({ mode: 'legacy', addFeeds: true, channels: [] }),
      ),
      status(403),
    );
    assert.deepEqual(await f.stored(), before);
  } finally {
    await f.dispose();
  }
});

test('stale revisions, concurrent initialization and database writes during recheck cannot overwrite configuration', async () => {
  const f = await fixture();
  try {
    const revision = (await f.read()).revision;
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        saveCatalog(
          f.env,
          f.key,
          { revision, operation: { type: 'initialize' } },
          all,
          f.fetcher,
          async () => all,
        ),
      ),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    assert(rejected?.status === 'rejected' && status(409)(rejected.reason));
    const before = await f.stored();
    await assert.rejects(
      saveCatalog(
        f.env,
        f.key,
        {
          revision,
          operation: {
            type: 'feed.create',
            label: 'Stale',
            url: 'https://feeds.example/',
          },
        },
        all,
        f.fetcher,
        async () => all,
      ),
      status(409),
    );
    assert.deepEqual(await f.stored(), before);
    await assert.rejects(
      f.mutate(
        {
          type: 'feed.create',
          label: 'Racing',
          url: 'https://feeds.example/racing',
        },
        all,
        async () => {
          await f.db
            .prepare("UPDATE relay_configuration SET feeds = '[ ]'")
            .run();
          return all;
        },
      ),
      status(409),
    );
    assert.equal((await f.stored())!.feeds, '[ ]');
  } finally {
    await f.dispose();
  }
});

test('unrouted feeds count toward the total configuration bound and failure preserves the prior save', async () => {
  const f = await fixture();
  try {
    await f.mutate({ type: 'initialize' });
    let rejected = false;
    let accepted = 0;
    for (let index = 0; index < 60; index++) {
      const before = await f.stored();
      try {
        await f.mutate(
          {
            type: 'feed.create',
            label: `Feed ${index}`,
            url: `https://feeds.example/${index}?secret=${'x'.repeat(1900)}`,
          },
          feedOnly,
        );
        accepted++;
      } catch (error) {
        assert(status(413)(error));
        assert.deepEqual(await f.stored(), before);
        rejected = true;
        break;
      }
    }
    assert(accepted > 20);
    assert(rejected);
    assert.equal((await f.read()).feeds.length, accepted);
    assert.deepEqual((await readRelayConfiguration(f.env)).feeds, []);
  } finally {
    await f.dispose();
  }
});

test('catalog reads and relay polling reject a projection changed outside the atomic catalog save', async () => {
  const f = await fixture();
  try {
    await f.seed();
    await f.mutate({ type: 'initialize' });
    await f.db.prepare("UPDATE relay_configuration SET feeds = '[]'").run();
    await assert.rejects(f.read(), /disagree/);
    await assert.rejects(readRelayConfiguration(f.env), /disagree/);
  } finally {
    await f.dispose();
  }
});
