import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { login } from '../cli/auth.ts';
import { catalogSnapshot } from '../cli/catalog.ts';
import { runCli } from '../cli/index.ts';
import type { AdminFetch } from '../cli/admin.ts';
import type { CatalogMutation, CatalogSnapshot } from '../src/catalog-types.ts';

const snapshot: CatalogSnapshot = {
  mode: 'scoped',
  initialized: true,
  revision: 'first',
  maxBytes: 96 * 1024,
  permissions: {
    addFeeds: true,
    channels: [
      { guildId: '100000000000000001', channelId: '100000000000000002' },
    ],
  },
  feeds: [{ id: 'f_original', label: 'Original' }],
  destinations: [
    {
      id: 'd_updates',
      label: 'Updates',
      guildId: '100000000000000001',
      channelId: '100000000000000002',
    },
  ],
  subscriptions: [{ feedId: 'f_original', destinationId: 'd_updates' }],
};
const env = {
  SYNDICORD_ADMIN_URL: 'https://relay.example',
  XDG_CONFIG_HOME: '',
};
const token = 't'.repeat(43);
beforeEach(async () => {
  env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'scoped-client-'));
  await login(env, {
    openBrowser: async () => {},
    progress: () => {},
    wait: async () => {},
    fetcher: async (url) =>
      Response.json(
        url.endsWith('/start')
          ? {
              requestId: 'r'.repeat(43),
              secret: 's'.repeat(43),
              userCode: 'ABCD-1234',
              verificationUri: `${env.SYNDICORD_ADMIN_URL}/admin/auth/cli?request=${'r'.repeat(43)}`,
              expiresIn: 600,
              interval: 2,
            }
          : {
              token,
              expiresAt: Date.now() + 60_000,
              user: { id: '100000000000000003', name: 'Member' },
            },
      ),
  });
});
afterEach(async () => {
  await rm(env.XDG_CONFIG_HOME, { recursive: true, force: true });
});

function fixture(
  options: {
    initial?: CatalogSnapshot;
    write?: (body: CatalogMutation) => Response | Promise<Response>;
  } = {},
) {
  const calls: { method: string; body?: CatalogMutation }[] = [];
  const fetcher: AdminFetch = async (url, init) => {
    assert.equal(url, `${env.SYNDICORD_ADMIN_URL}/admin/api/catalog`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    if (init.method === 'POST') {
      assert.equal(headers.get('origin'), env.SYNDICORD_ADMIN_URL);
      assert.equal(headers.get('content-type'), 'application/json');
      const body = JSON.parse(String(init.body)) as CatalogMutation;
      calls.push({ method: init.method, body });
      if (options.write) return options.write(body);
    } else calls.push({ method: init.method! });
    return Response.json(options.initial ?? snapshot);
  };
  return { calls, fetcher };
}

const noCloudflare = async () => {
  throw new Error('Configuration commands must not use Cloudflare');
};

test('scoped CLI lists public catalog, destinations and subscriptions using one shared API', async () => {
  const { calls, fetcher } = fixture();
  for (const [command, expected] of [
    ['catalog', snapshot.feeds],
    ['destinations', snapshot.destinations],
    ['subscriptions', snapshot.subscriptions],
  ] as const) {
    const result = await runCli([command, 'list'], env, {
      adminFetch: fetcher,
      cf: noCloudflare,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  assert.deepEqual(calls, [
    { method: 'GET' },
    { method: 'GET' },
    { method: 'GET' },
  ]);
});

test('feed creation sends one scoped operation without creating or replacing subscriptions', async () => {
  const { calls, fetcher } = fixture();
  const result = await runCli(['catalog', 'add', '--file', '-'], env, {
    adminFetch: fetcher,
    cf: noCloudflare,
    readInput: async () => ({
      label: 'Private source',
      url: 'https://example.com/feed?secret=private-feed-token',
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls[1], {
    method: 'POST',
    body: {
      revision: 'first',
      operation: {
        type: 'feed.create',
        label: 'Private source',
        url: 'https://example.com/feed?secret=private-feed-token',
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private-feed-token|https:/);
});

test('all scoped commands retain their exact target identity and do not use bulk saves', async () => {
  const cases = [
    {
      args: ['catalog', 'rename', 'f_original', 'New name'],
      operation: { type: 'feed.rename', id: 'f_original', label: 'New name' },
    },
    {
      args: ['catalog', 'remove', 'f_original'],
      operation: { type: 'feed.delete', id: 'f_original' },
    },
    {
      args: ['destinations', 'register', '--file', '-'],
      input: {
        label: 'Updates',
        webhookUrl: 'https://discord.com/api/webhooks/123/private-token',
      },
      operation: {
        type: 'destination.create',
        label: 'Updates',
        webhookUrl: 'https://discord.com/api/webhooks/123/private-token',
      },
    },
    {
      args: ['destinations', 'rename', 'd_updates', 'News'],
      operation: { type: 'destination.rename', id: 'd_updates', label: 'News' },
    },
    {
      args: ['destinations', 'rotate', 'd_updates', '--file', '-'],
      input: {
        webhookUrl: 'https://discord.com/api/webhooks/123/private-token',
      },
      operation: {
        type: 'destination.rotate',
        id: 'd_updates',
        webhookUrl: 'https://discord.com/api/webhooks/123/private-token',
      },
    },
    {
      args: ['destinations', 'remove', 'd_updates'],
      operation: { type: 'destination.delete', id: 'd_updates' },
    },
    {
      args: ['subscriptions', 'add', 'f_original', 'd_updates'],
      operation: {
        type: 'subscription.add',
        feedId: 'f_original',
        destinationId: 'd_updates',
      },
    },
    {
      args: ['subscriptions', 'remove', 'f_original', 'd_updates'],
      operation: {
        type: 'subscription.remove',
        feedId: 'f_original',
        destinationId: 'd_updates',
      },
    },
  ];
  for (const { args, input, operation } of cases) {
    const { calls, fetcher } = fixture();
    const result = await runCli(args, env, {
      adminFetch: fetcher,
      readInput: async () => input,
      cf: noCloudflare,
    });
    assert.equal(result.code, 0, `${args}: ${result.stderr}`);
    assert.deepEqual(calls, [
      { method: 'GET' },
      { method: 'POST', body: { revision: 'first', operation } },
    ]);
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
  }
});

test('initialization is explicit and other scoped commands cannot initialize implicitly', async () => {
  const { calls, fetcher } = fixture({
    initial: { ...snapshot, initialized: false },
  });
  const blocked = await runCli(['catalog', 'list'], env, {
    adminFetch: fetcher,
  });
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /catalog initialize/);
  assert.equal(calls.length, 1);
  const result = await runCli(['catalog', 'initialize'], env, {
    adminFetch: fetcher,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(calls[2]!.body, {
    revision: 'first',
    operation: { type: 'initialize' },
  });
  assert.match(result.stdout, /subscriptions are unchanged/);
  const existing = fixture();
  const again = await runCli(['catalog', 'initialize'], env, {
    adminFetch: existing.fetcher,
  });
  assert.equal(again.code, 0);
  assert.equal(existing.calls.length, 1);
});

test('mode-specific errors explain the correct command family without reflecting diagnostics', async () => {
  for (const [args, code, expected] of [
    [
      ['feeds', 'get'],
      'scoped_catalog_required',
      /catalog, destinations, and subscriptions/,
    ],
    [['catalog', 'list'], 'scoped_policy_required', /feeds and webhooks/],
  ] as const) {
    const result = await runCli([...args], env, {
      adminFetch: async () =>
        Response.json({ error: 'private-secret', code }, { status: 400 }),
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /private-secret/);
  }
});

test('conflicts, forbidden operations, and ambiguous writes are never retried', async () => {
  for (const scenario of [409, 403, 'lost', 'malformed'] as const) {
    const { calls, fetcher } = fixture({
      write: async () => {
        if (scenario === 'lost')
          throw new Error('secret-bearing response lost');
        if (scenario === 'malformed')
          return Response.json({ private: 'secret' });
        return Response.json({ error: 'secret' }, { status: scenario });
      },
    });
    const result = await runCli(
      ['subscriptions', 'add', 'f_original', 'd_updates'],
      env,
      { adminFetch: fetcher },
    );
    assert.equal(result.code, 2);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.match(
      result.stderr,
      scenario === 409
        ? /changed while/
        : scenario === 403
          ? /permission/
          : /not retried/,
    );
  }
});

test('invalid command input fails before requests and cannot smuggle additional operations', async () => {
  const { calls, fetcher } = fixture();
  for (const args of [
    ['catalog', 'rename', 'f_original'],
    ['destinations', 'rotate', 'd_updates'],
    ['subscriptions', 'add', 'f_original', 'https://secret.example/'],
    ['catalog', 'list', '--local'],
  ]) {
    assert.equal((await runCli(args, env, { adminFetch: fetcher })).code, 2);
  }
  const result = await runCli(['catalog', 'add', '--file', '-'], env, {
    adminFetch: fetcher,
    readInput: async () => ({
      label: 'Feed',
      url: 'https://example.com',
      subscriptions: [{ feedId: 'other', destinationId: 'unauthorized' }],
    }),
  });
  assert.equal(result.code, 2);
  assert.equal(calls.length, 0);
});

test('catalog parsing strips nonpublic fields and rejects invalid references', () => {
  const parsed = catalogSnapshot({
    ...snapshot,
    feeds: [{ ...snapshot.feeds[0], url: 'private-feed-secret' }],
    destinations: [
      { ...snapshot.destinations[0], webhookUrl: 'private-webhook-secret' },
    ],
    policy: 'operator-secret',
  });
  assert.deepEqual(parsed, snapshot);
  assert.doesNotMatch(JSON.stringify(parsed), /secret/);
  for (const value of [
    {
      ...snapshot,
      subscriptions: [{ feedId: 'missing', destinationId: 'd_updates' }],
    },
    { ...snapshot, feeds: [...snapshot.feeds, ...snapshot.feeds] },
    {
      ...snapshot,
      permissions: {
        addFeeds: true,
        channels: [{ guildId: 'not-an-id', channelId: '123' }],
      },
    },
  ])
    assert.throws(() => catalogSnapshot(value), /invalid response/);
});

test('scoped CLI reads and acknowledges a valid catalog with expanded multi-role permissions above 128 KiB', async () => {
  const grants = Array.from({ length: 11 }, (_, role) => ({
    guildId: '100000000000000001',
    roleId: String(200000000000000000n + BigInt(role)),
    addFeeds: true,
    channelIds: Array.from({ length: 64 }, (_, channel) =>
      String(300000000000000000n + BigInt(role * 64 + channel)),
    ),
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify({ version: 1, grants })) < 16 * 1024,
  );
  const document = {
    version: 1,
    feeds: Array.from({ length: 546 }, (_, index) => ({
      id: `f_${String(index).padStart(36, '0')}`,
      label: 'L'.repeat(100),
      url: `http://x/${index}`,
    })),
    destinations: [],
    subscriptions: [],
  };
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ catalog: document, feeds: [], webhooks: {} }),
    ) <
      96 * 1024,
  );
  const large: CatalogSnapshot = {
    ...snapshot,
    permissions: {
      addFeeds: true,
      channels: grants.flatMap((grant) =>
        grant.channelIds.map((channelId) => ({
          guildId: grant.guildId,
          channelId,
        })),
      ),
    },
    feeds: document.feeds.map(({ id, label }) => ({ id, label })),
    destinations: [],
    subscriptions: [],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024);
  const { calls, fetcher } = fixture({ initial: large });
  const listed = await runCli(['catalog', 'list'], env, {
    adminFetch: fetcher,
  });
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 546);
  const renamed = await runCli(
    ['catalog', 'rename', large.feeds[0]!.id, 'Renamed'],
    env,
    { adminFetch: fetcher },
  );
  assert.equal(renamed.code, 0, renamed.stderr);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.method, 'POST');
});

test('scoped response allowance remains bounded at 256 KiB without changing request or legacy limits', async () => {
  const oversized = { ...snapshot, padding: 'x'.repeat(256 * 1024) };
  let calls = 0;
  const read = await runCli(['catalog', 'list'], env, {
    adminFetch: async () => {
      calls++;
      return Response.json(oversized);
    },
  });
  assert.equal(read.code, 2);
  assert.equal(calls, 1);
  const write = fixture({ write: () => Response.json(oversized) });
  const rejected = await runCli(
    ['catalog', 'rename', 'f_original', 'Renamed'],
    env,
    { adminFetch: write.fetcher },
  );
  assert.equal(rejected.code, 2);
  assert.match(rejected.stderr, /not retried/);
  assert.equal(write.calls.length, 2);
  const legacy = await runCli(['feeds', 'get'], env, {
    adminFetch: async () =>
      Response.json({
        feeds: [],
        destinations: [],
        revision: 'r',
        padding: 'x'.repeat(129 * 1024),
      }),
  });
  assert.equal(legacy.code, 2);
  const request = fixture();
  const tooLarge = await runCli(['catalog', 'add', '--file', '-'], env, {
    adminFetch: request.fetcher,
    readInput: async () => ({
      label: 'Feed',
      url: `https://example.com/?secret=${'x'.repeat(129 * 1024)}`,
    }),
  });
  assert.equal(tooLarge.code, 2);
  assert.match(tooLarge.stderr, /128 KiB/);
  assert.deepEqual(request.calls, [{ method: 'GET' }]);
});
