import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach, afterEach } from 'node:test';
import { adminClient, type AdminFetch } from '../cli/admin.ts';
import { runCli } from '../cli/index.ts';
import { login } from '../cli/auth.ts';
import {
  authEnv,
  browserLogin,
  cliLogin,
  discordFixture,
  TEST_ROLE_ID,
  type DiscordFixtureOptions,
} from './helpers/auth.ts';
import { handleAdmin } from '../src/admin.ts';
import { readRelayConfiguration } from '../src/admin-store.ts';
import { createTestDatabase } from './helpers/d1.ts';

const environment = {
  SYNDICORD_ADMIN_URL: 'https://relay.example/',
  XDG_CONFIG_HOME: '',
};
const feeds = [
  {
    url: 'https://example.com/feed?secret=private-feed-token',
    destinations: ['updates'],
  },
];
const webhook = 'https://discord.com/api/webhooks/123/private-webhook-token';
const other = 'https://discord.com/api/webhooks/456/other-webhook-token';
const initial = {
  feeds,
  destinations: ['updates'],
  revision: 'initial-revision',
  maxRoutes: 20,
};
const noCloudflare = async () => {
  throw new Error('must not invoke Cloudflare');
};

const testToken = 'private-session-token-'.padEnd(43, 't');
async function saveProfile(
  env = environment,
  token = testToken,
  expiresAt = Date.now() + 60_000,
) {
  const origin = new URL(env.SYNDICORD_ADMIN_URL).origin;
  const requestId = 'r'.repeat(43);
  await login(env, {
    openBrowser: async () => {},
    progress: () => {},
    wait: async () => {},
    fetcher: async (url) =>
      Response.json(
        url.endsWith('/start')
          ? {
              requestId,
              secret: 's'.repeat(43),
              userCode: 'ABCD-1234',
              verificationUri: `${origin}/admin/auth/cli?request=${requestId}`,
              expiresIn: 600,
              interval: 2,
            }
          : {
              token,
              expiresAt,
              user: { id: '123456789012345678', name: 'Administrator' },
            },
      ),
  });
}
beforeEach(async () => {
  environment.XDG_CONFIG_HOME = await mkdtemp(
    join(tmpdir(), 'syndicord-admin-cli-'),
  );
  await saveProfile();
});
afterEach(async () => {
  await rm(environment.XDG_CONFIG_HOME, { recursive: true, force: true });
});

function expectedAuth() {
  return `Bearer ${testToken}`;
}

async function fixture(options: DiscordFixtureOptions = {}) {
  const database = await createTestDatabase();
  const workerEnv = authEnv(
    database.db,
    new URL(environment.SYNDICORD_ADMIN_URL).origin,
  );
  const discord = discordFixture(options);
  const browserSession = await browserLogin(workerEnv, discord);
  const cliSession = await cliLogin(workerEnv, discord);
  await saveProfile(environment, cliSession.token, cliSession.expiresAt);
  const fetcher: AdminFetch = async (url, init) => {
    const response = await handleAdmin(
      new Request(url, init),
      workerEnv,
      discord,
    );
    assert.ok(response);
    return response;
  };
  const browser = {
    async read() {
      const response = await fetcher(
        new URL('/admin/api/config', environment.SYNDICORD_ADMIN_URL).href,
        {
          headers: { Cookie: browserSession.cookie },
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as {
        feeds: typeof feeds;
        destinations: string[];
        revision: string;
      };
    },
    async write(
      current: { revision: string },
      routes: typeof feeds,
      webhooks: Record<string, string | null>,
    ) {
      const response = await fetcher(
        new URL('/admin/api/config', environment.SYNDICORD_ADMIN_URL).href,
        {
          method: 'PUT',
          headers: {
            Cookie: browserSession.cookie,
            Origin: new URL(environment.SYNDICORD_ADMIN_URL).origin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            revision: current.revision,
            feeds: routes,
            webhooks,
          }),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
    },
  };
  return { ...database, workerEnv, fetcher, browser };
}

test('administration mode needs no Cloudflare target and sends credentials only in headers', async () => {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetcher: AdminFetch = async (url, init) => {
    assert.equal(url, 'https://relay.example/admin/api/config');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), expectedAuth());
    assert.doesNotMatch(url, /private-session-token|private-webhook-token/);
    if (init.method === 'PUT') {
      assert.equal(headers.get('origin'), 'https://relay.example');
      assert.equal(headers.get('content-type'), 'application/json');
    }
    calls.push({
      url,
      method: init.method!,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return Response.json(initial);
  };
  const dependencies = {
    cf: noCloudflare,
    adminFetch: fetcher,
    readInput: async () => feeds,
  };
  const get = await runCli(['feeds', 'get'], environment, dependencies);
  assert.equal(get.code, 0, get.stderr);
  assert.deepEqual(JSON.parse(get.stdout), feeds);
  const set = await runCli(
    ['feeds', 'set', '--file', '-'],
    environment,
    dependencies,
  );
  assert.equal(set.code, 0, set.stderr);
  assert.doesNotMatch(
    JSON.stringify(set),
    /private-session-token|private-feed-token|private-webhook-token/,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET', 'GET', 'PUT'],
  );
  assert.deepEqual(calls[2]!.body, {
    revision: initial.revision,
    feeds,
    webhooks: {},
  });
});

test('the web client and CLI edit the same encrypted configuration without losing unrelated changes', async () => {
  const { browser, fetcher, workerEnv, db, dispose } = await fixture();
  try {
    await browser.write(await browser.read(), feeds, {
      updates: webhook,
      unused: other,
    });
    const dependencies = { cf: noCloudflare, adminFetch: fetcher };
    const get = await runCli(['feeds', 'get'], environment, dependencies);
    assert.deepEqual(JSON.parse(get.stdout), feeds);
    const expanded = [
      ...feeds,
      { url: 'https://second.example/feed', destinations: ['updates'] },
    ];
    const set = await runCli(['feeds', 'set', '--file', '-'], environment, {
      ...dependencies,
      readInput: async () => expanded,
    });
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual((await browser.read()).feeds, expanded);
    assert.deepEqual((await browser.read()).destinations, [
      'unused',
      'updates',
    ]);
    const rotated = 'https://discord.com/api/webhooks/789/rotated-token';
    await browser.write(await browser.read(), expanded, { updates: rotated });
    const changedFeed = [
      { url: 'https://third.example/feed', destinations: ['updates'] },
    ];
    const change = await runCli(['feeds', 'set', '--file', '-'], environment, {
      ...dependencies,
      readInput: async () => changedFeed,
    });
    assert.equal(change.code, 0, change.stderr);
    assert.equal(
      (await readRelayConfiguration(workerEnv)).webhooks.updates,
      rotated,
      'CLI feed edits preserve a webhook rotated in the browser',
    );
    const replacement = {
      updates: rotated,
      added: 'https://discord.com/api/webhooks/999/new-token',
    };
    const replace = await runCli(
      ['webhooks', 'set', '--file', '-'],
      environment,
      { ...dependencies, readInput: async () => replacement },
    );
    assert.equal(replace.code, 0, replace.stderr);
    const final = await browser.read();
    assert.deepEqual(
      final.destinations,
      ['added', 'unused', 'updates'],
      'upserting webhook URLs preserves omitted destinations',
    );
    const listed = await runCli(
      ['webhooks', 'list'],
      environment,
      dependencies,
    );
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), final.destinations);
    assert.doesNotMatch(listed.stdout, /discord.com|token/);
    const removed = await runCli(
      ['webhooks', 'remove', 'unused'],
      environment,
      dependencies,
    );
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual((await browser.read()).destinations, ['added', 'updates']);
    assert.deepEqual(
      final.feeds,
      changedFeed,
      'CLI webhook updates preserve browser-visible routes',
    );
    assert.equal(
      (await readRelayConfiguration(workerEnv)).webhooks.updates,
      rotated,
    );
    const stored = await db
      .prepare('SELECT encrypted_webhooks FROM relay_configuration')
      .first<{ encrypted_webhooks: string }>();
    assert.match(stored!.encrypted_webhooks, /^v1\./);
    assert.doesNotMatch(
      stored!.encrypted_webhooks,
      /private-webhook-token|rotated-token|new-token/,
    );
  } finally {
    await dispose();
  }
});

test('webhook updates preserve omitted names and removal refuses referenced or missing destinations', async () => {
  const puts: unknown[] = [];
  const fetcher: AdminFetch = async (_url, init) => {
    if (init.method === 'PUT') puts.push(JSON.parse(String(init.body)));
    return Response.json({
      ...initial,
      destinations: ['updates', 'old', 'other'],
    });
  };
  const dependencies = { cf: noCloudflare, adminFetch: fetcher };
  const result = await runCli(['webhooks', 'set', '--file', '-'], environment, {
    ...dependencies,
    readInput: async () => ({ updates: webhook }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(puts, [
    { revision: initial.revision, feeds, webhooks: { updates: webhook } },
  ]);
  const removed = await runCli(
    ['webhooks', 'remove', 'old'],
    environment,
    dependencies,
  );
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(puts[1], {
    revision: initial.revision,
    feeds,
    webhooks: { old: null },
  });
  const referenced = await runCli(
    ['webhooks', 'remove', 'updates'],
    environment,
    dependencies,
  );
  assert.equal(referenced.code, 2);
  assert.match(referenced.stderr, /Remove routes to destination updates/);
  const missing = await runCli(
    ['webhooks', 'remove', 'missing'],
    environment,
    dependencies,
  );
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /not configured/);
  const missingFeedDestination = await runCli(
    ['feeds', 'set', '--file', '-'],
    environment,
    {
      ...dependencies,
      readInput: async () => [
        { url: 'https://example.com', destinations: ['missing'] },
      ],
    },
  );
  assert.equal(missingFeedDestination.code, 2);
  assert.match(
    missingFeedDestination.stderr,
    /Missing webhook for destination missing/,
  );
  assert.equal(puts.length, 2);
});

test('invalid configuration is rejected before network traffic', async () => {
  let calls = 0;
  const dependencies = {
    cf: noCloudflare,
    adminFetch: async () => {
      calls++;
      return Response.json(initial);
    },
  };
  for (const value of [
    {},
    { invalid: '' },
    { invalid: 'private-invalid-url' },
    { 'invalid name': webhook },
    { first: webhook, second: webhook },
  ]) {
    const result = await runCli(
      ['webhooks', 'set', '--file', '-'],
      environment,
      { ...dependencies, readInput: async () => value },
    );
    assert.equal(result.code, 2);
    assert.doesNotMatch(
      result.stderr,
      /private-invalid-url|private-webhook-token/,
    );
  }
  const invalidFeed = await runCli(
    ['feeds', 'set', '--file', '-'],
    environment,
    {
      ...dependencies,
      readInput: async () => [{ url: 'private-invalid-url', destinations: [] }],
    },
  );
  assert.equal(invalidFeed.code, 2);
  const invalidRemoval = await runCli(
    ['webhooks', 'remove', 'private-invalid-name!'],
    environment,
    dependencies,
  );
  assert.equal(invalidRemoval.code, 2);
  assert.doesNotMatch(invalidRemoval.stderr, /private-invalid-name/);
  assert.equal(calls, 0);
});

test('combined validation reports duplicate stored webhook URLs without revealing them', async () => {
  const { browser, fetcher, dispose } = await fixture();
  try {
    await browser.write(await browser.read(), feeds, { updates: webhook });
    const result = await runCli(
      ['webhooks', 'set', '--file', '-'],
      environment,
      {
        cf: noCloudflare,
        adminFetch: fetcher,
        readInput: async () => ({ duplicate: webhook }),
      },
    );
    assert.equal(result.code, 2);
    assert.match(
      result.stderr,
      /Each destination must have a distinct webhook URL/,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-webhook-token|discord.com/,
    );
    assert.deepEqual((await browser.read()).destinations, ['updates']);
  } finally {
    await dispose();
  }
});

test('a concurrent browser save causes a CLI conflict without retry or lost configuration', async () => {
  const { browser, fetcher, dispose } = await fixture();
  try {
    await browser.write(await browser.read(), feeds, { updates: webhook });
    const browserFeeds = [
      { url: 'https://browser.example/feed', destinations: ['updates'] },
    ];
    const methods: string[] = [];
    const racingFetch: AdminFetch = async (url, init) => {
      methods.push(init.method!);
      if (init.method === 'PUT')
        await browser.write(await browser.read(), browserFeeds, {});
      return fetcher(url, init);
    };
    const result = await runCli(['feeds', 'set', '--file', '-'], environment, {
      cf: noCloudflare,
      adminFetch: racingFetch,
      readInput: async () => [],
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Configuration changed.*retry manually/);
    assert.deepEqual(methods, ['GET', 'PUT']);
    assert.deepEqual((await browser.read()).feeds, browserFeeds);
  } finally {
    await dispose();
  }
});

test('a lost response after a successful CLI save is ambiguous and is never retried', async () => {
  const { browser, fetcher, dispose } = await fixture();
  try {
    await browser.write(await browser.read(), feeds, { updates: webhook });
    const methods: string[] = [];
    const lostResponse: AdminFetch = async (url, init) => {
      methods.push(init.method!);
      const response = await fetcher(url, init);
      if (init.method === 'PUT')
        throw new Error('private-webhook-token private-session-token');
      return response;
    };
    const result = await runCli(['feeds', 'set', '--file', '-'], environment, {
      cf: noCloudflare,
      adminFetch: lostResponse,
      readInput: async () => [],
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /could not be confirmed.*not retried/);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-webhook-token|private-session-token/,
    );
    assert.deepEqual(methods, ['GET', 'PUT']);
    assert.deepEqual(
      (await browser.read()).feeds,
      [],
      'the server committed even though the response was lost',
    );
  } finally {
    await dispose();
  }
});

test('invalid admin targets, missing sessions, and --local fail before any network or Cloudflare call', async () => {
  let calls = 0;
  const dependencies = {
    cf: async () => {
      calls++;
      return '';
    },
    adminFetch: async () => {
      calls++;
      return Response.json(initial);
    },
  };
  for (const url of [
    '',
    'not-a-url',
    'http://remote.example',
    'https://admin:password@relay.example',
    'https://relay.example/admin',
    'https://relay.example/?secret=private-token',
    'https://relay.example/#private-token',
    'https://relay.example/?',
    'https://relay.example/#',
    'https://relay.example/../',
    'https://relay.example\\',
    'file:///private-token',
  ]) {
    const result = await runCli(
      ['feeds', 'get'],
      { ...environment, SYNDICORD_ADMIN_URL: url },
      dependencies,
    );
    assert.equal(result.code, 2, url);
    assert.match(result.stderr, /SYNDICORD_ADMIN_URL must be/);
    assert.doesNotMatch(result.stderr, /private-token|admin:password/);
  }
  const missing = await runCli(
    ['feeds', 'get'],
    { ...environment, SYNDICORD_ADMIN_URL: 'https://signed-out.example' },
    dependencies,
  );
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Run syndicord login.*docs\/WEB.md/);
  for (const args of [
    ['feeds', 'get', '--local'],
    ['feeds', 'set', '--local', '--file', '-'],
    ['webhooks', 'set', '--local', '--file', '-'],
  ]) {
    const result = await runCli(args, environment, dependencies);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Configuration commands do not use --local/);
  }
  for (const args of [
    ['feeds', 'get'],
    ['webhooks', 'list'],
  ]) {
    const result = await runCli(
      args,
      {
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        SYNDICORD_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
      },
      dependencies,
    );
    assert.equal(result.code, 2);
    assert.match(result.stderr, /SYNDICORD_ADMIN_URL/);
  }
  assert.equal(calls, 0);
});

test('explicit loopback HTTP targets work without --local', async () => {
  for (const origin of [
    'http://localhost:8787',
    'http://127.0.0.1:8787/',
    'http://[::1]:8787',
  ]) {
    await saveProfile({ ...environment, SYNDICORD_ADMIN_URL: origin });
    let requested = '';
    const result = await runCli(
      ['feeds', 'get'],
      { ...environment, SYNDICORD_ADMIN_URL: origin },
      {
        cf: noCloudflare,
        adminFetch: async (url) => {
          requested = url;
          return Response.json(initial);
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requested, new URL('/admin/api/config', origin).href);
  }
});

test('API errors, redirects, invalid responses, and overlarge responses never expose response bodies', async () => {
  const sensitive = 'private-webhook-token private-session-token';
  for (const response of [
    new Response(sensitive, { status: 401 }),
    new Response(sensitive, { status: 403 }),
    new Response(sensitive, { status: 429 }),
    new Response(sensitive, { status: 400 }),
    new Response(sensitive, { status: 503 }),
    new Response(sensitive, {
      status: 302,
      headers: { Location: 'https://other.example/secret' },
    }),
    new Response(sensitive),
    Response.json({
      ...initial,
      revision: sensitive,
      destinations: ['invalid destination'],
    }),
    Response.json({
      ...initial,
      feeds: [{ url: sensitive, destinations: [] }],
    }),
    new Response('x'.repeat(128 * 1024 + 1)),
    new Response('{}', {
      headers: { 'Content-Length': String(128 * 1024 + 1) },
    }),
  ]) {
    let calls = 0;
    const result = await runCli(['feeds', 'get'], environment, {
      cf: noCloudflare,
      adminFetch: async (_url, init) => {
        calls++;
        assert.equal(init.redirect, 'error');
        return response;
      },
    });
    assert.equal(result.code, 2);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-webhook-token|private-session-token|other.example/,
    );
    assert.equal(calls, 1);
  }
});

test('request size is checked before PUT and malformed write acknowledgements stay ambiguous', async () => {
  const calls: string[] = [];
  const client = adminClient(environment, async (_url, init) => {
    calls.push(init.method!);
    return new Response('private-webhook-token');
  });
  await assert.rejects(
    client.write(initial, feeds, { huge: 'x'.repeat(128 * 1024) }),
    /exceeds.*No changes were sent/,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(client.write(initial, feeds, {}), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /response was invalid or incomplete.*not retried/,
    );
    assert.doesNotMatch(error.message, /private-webhook-token/);
    return true;
  });
  assert.deepEqual(calls, ['PUT']);
});

test('the request deadline aborts stalled network requests without retrying writes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let fetched!: () => void;
  const fetching = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const client = adminClient(environment, async (_url, init) => {
    calls++;
    fetched();
    return new Promise((_resolve, reject) => {
      init.signal!.addEventListener(
        'abort',
        () => reject(new Error('private-webhook-token')),
        { once: true },
      );
    });
  });
  const saving = client.write(initial, feeds, {});
  const rejected = assert.rejects(
    saving,
    /could not be confirmed.*not retried/,
  );
  await fetching;
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(calls, 1);
});

test('a stalled response body is also covered by the request deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  let fetched!: () => void;
  const fetching = new Promise<void>((resolve) => {
    fetched = resolve;
  });
  const client = adminClient(environment, async () => {
    fetched();
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const reading = client.read();
  const rejected = assert.rejects(reading, /invalid response/);
  await fetching;
  // Let the fulfilled fetch promise install the response-body abort listener.
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(cancelled, true);
});

test('status keeps Cloudflare targeting even when administration variables are configured', async () => {
  let fetched = false;
  const result = await runCli(['status'], environment, {
    cf: noCloudflare,
    adminFetch: async () => {
      fetched = true;
      return Response.json(initial);
    },
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(fetched, false);
});

test('removing the Discord role between CLI read and write blocks saving while logout remains available', async () => {
  const options = { roles: [TEST_ROLE_ID] };
  const { browser, fetcher, workerEnv, dispose } = await fixture(options);
  try {
    await browser.write(await browser.read(), feeds, { updates: webhook });
    const calls: string[] = [];
    const result = await runCli(['feeds', 'set', '--file', '-'], environment, {
      cf: noCloudflare,
      readInput: async () => [],
      adminFetch: async (url, init) => {
        calls.push(init.method!);
        const response = await fetcher(url, init);
        if (init.method === 'GET') options.roles = [];
        return response;
      },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /no longer has.*role/);
    assert.deepEqual(calls, ['GET', 'PUT']);
    assert.deepEqual((await readRelayConfiguration(workerEnv)).feeds, feeds);
    const out = await runCli(['logout'], environment, {
      cf: noCloudflare,
      adminFetch: fetcher,
    });
    assert.equal(out.code, 0, out.stderr);
    const after = await runCli(['feeds', 'get'], environment, {
      cf: noCloudflare,
      adminFetch: async () => {
        throw new Error('must not fetch');
      },
    });
    assert.equal(after.code, 2);
    assert.match(after.stderr, /Run syndicord login/);
  } finally {
    await dispose();
  }
});
