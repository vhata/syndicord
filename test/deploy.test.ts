import assert from 'node:assert/strict';
import test from 'node:test';
import { currentMain, deploy } from '../scripts/deploy.ts';

const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const database = '12345678-1234-1234-1234-123456789abc';
const version = '87654321-4321-4321-4321-cba987654321';
const previousVersion = '11111111-4321-4321-4321-cba987654321';
const env: Record<string, string | undefined> = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: 'example/syndicord',
  GITHUB_TOKEN: 'github-test-token',
  CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'cloudflare-test-token',
  SYNDICORD_DATABASE_ID: database,
};

function harness(
  options: {
    environment?: Record<string, string | undefined>;
    heads?: string[];
    checkout?: string;
    reply?: (args: string[]) => string | undefined;
  } = {},
) {
  const calls: string[][] = [];
  const reports: string[] = [];
  const waits: number[] = [];
  const heads = [...(options.heads ?? [sha])];
  const run = () =>
    deploy({
      env: { ...env, ...options.environment },
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === 'git') return options.checkout ?? sha;
        const reply = options.reply?.(args);
        if (reply !== undefined) return reply;
        if (args[1] === 'secrets')
          return '[{"name":"WEBHOOKS","type":"secret_text"}]';
        if (args[0] === 'd1' && args[2] === 'list') return '[]';
        if (args[0] === 'd1' && args[1] === 'raw')
          return JSON.stringify([
            { success: true, results: { columns: ['feeds'], rows: [['[]']] } },
          ]);
        if (args[1] === 'deployments') {
          return JSON.stringify({
            deployments: [
              { versions: [{ version_id: version, percentage: 100 }] },
            ],
          });
        }
        if (args[1] === 'versions') {
          return JSON.stringify({
            annotations: { 'workers/message': `syndicord commit ${sha}` },
          });
        }
        return '';
      },
      main: async () => (heads.length > 1 ? heads.shift()! : heads[0]!),
      report: (message) => reports.push(message),
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
  const mutations = () =>
    calls.filter(
      (call) =>
        call[1] === 'deploy' || (call[1] === 'd1' && call[3] === 'apply'),
    );
  return { run, calls, reports, waits, mutations };
}

test('production deployment applies migrations first, preserves hosted secrets, and verifies the serving commit', async () => {
  const h = harness();
  assert.equal(await h.run(), 'deployed');
  assert.deepEqual(
    h.mutations().map((call) => call.slice(1)),
    [
      ['d1', 'migrations', 'apply', database, '--dir', 'migrations'],
      [
        'deploy',
        '--prebuilt',
        '--no-provision',
        '--message',
        `syndicord commit ${sha}`,
      ],
    ],
  );
  assert.equal(
    h.calls.some(
      (call) => call.includes('--secrets-file') || call.includes('--force'),
    ),
    false,
  );
  assert.match(h.reports[0]!, new RegExp(sha));
  assert.match(h.reports[0]!, new RegExp(version));
});

test('production verification rereads stale history without repeating upload or migrations', async () => {
  let reads = 0;
  const h = harness({
    reply: (args) => {
      if (args[1] === 'deployments' && reads++ === 0)
        return JSON.stringify({
          deployments: [
            { versions: [{ version_id: previousVersion, percentage: 100 }] },
          ],
        });
      if (args[1] === 'versions' && args[3] === previousVersion)
        return JSON.stringify({
          annotations: { 'workers/message': 'previous deployment' },
        });
    },
  });
  assert.equal(await h.run(), 'deployed');
  assert.equal(reads, 2);
  assert.deepEqual(h.waits, [2_000]);
  assert.equal(h.mutations().length, 2);
  assert.match(h.reports[0]!, new RegExp(version));
});

test('production deployment refuses PRs, other branches, missing credentials, and invalid resource identities', async () => {
  for (const environment of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_ACTIONS: undefined },
    { GITHUB_SHA: 'bad' },
    { GITHUB_REPOSITORY: 'owner/repo/extra' },
    { CLOUDFLARE_API_TOKEN: '' },
    { CLOUDFLARE_ACCOUNT_ID: 'bad' },
    { GITHUB_TOKEN: undefined },
    { SYNDICORD_DATABASE_ID: '' },
    { SYNDICORD_DATABASE_ID: '00000000-0000-4000-8000-000000000001' },
    { SYNDICORD_WORKER_NAME: '../wrong-worker' },
  ]) {
    const h = harness({ environment });
    await assert.rejects(h.run());
    assert.equal(h.calls.length, 0);
  }
  const h = harness({ checkout: newer });
  await assert.rejects(h.run(), /checkout/);
  assert.equal(h.mutations().length, 0);
});

test('deployment selects the configured Worker and database without replacing live routing', async () => {
  const target = 'another-installation';
  const otherDatabase = '99999999-1234-1234-1234-123456789abc';
  const h = harness({
    environment: {
      SYNDICORD_WORKER_NAME: target,
      SYNDICORD_DATABASE_ID: otherDatabase,
    },
  });
  assert.equal(await h.run(), 'deployed');
  for (const call of h.calls.filter((call) => call.includes('--worker'))) {
    assert.equal(call[call.indexOf('--worker') + 1], target);
  }
  for (const call of h.calls.filter((call) => call[1] === 'd1')) {
    assert.ok(call.includes(otherDatabase));
  }
  const query = h.calls.find((call) => call[1] === 'd1' && call[2] === 'raw');
  assert.match(query!.at(-1)!, /^SELECT feeds FROM relay_configuration/);
});

test('missing or invalid hosted routing stops upload after additive migrations', async () => {
  for (const rows of [
    [],
    [['not json']],
    [['{}']],
    [
      [
        JSON.stringify([
          { url: 'https://EXAMPLE.com', destinations: ['updates'] },
        ]),
      ],
    ],
    [[JSON.stringify([{ url: 'https://example.com/feed', destinations: [] }])]],
  ]) {
    const h = harness({
      reply: (args) =>
        args[0] === 'd1' && args[1] === 'raw'
          ? JSON.stringify([
              { success: true, results: { columns: ['feeds'], rows } },
            ])
          : undefined,
    });
    await assert.rejects(
      h.run(),
      /Configure feeds in the selected D1 database/,
    );
    assert.equal(h.mutations().length, 1);
    assert.equal(
      h.calls.some((call) => call[1] === 'deploy'),
      false,
    );
  }
});

test('a stale queued run never migrates or deploys and a newly superseded run stops before upload', async () => {
  for (const heads of [[newer], [sha, newer]]) {
    const h = harness({ heads });
    assert.equal(await h.run(), 'superseded');
    assert.equal(h.mutations().length, 0);
  }
  const h = harness({ heads: [sha, sha, newer] });
  assert.equal(await h.run(), 'superseded');
  assert.equal(h.mutations().length, 1);
  assert.match(h.reports[0]!, /migrations remain/);
});

test('missing hosted secrets and failed or incomplete migrations stop deployment', async () => {
  const missing = harness({
    reply: (args) => (args[1] === 'secrets' ? '[]' : undefined),
  });
  await assert.rejects(missing.run(), /WEBHOOKS/);
  assert.equal(missing.mutations().length, 0);

  for (const incomplete of [false, true]) {
    const h = harness({
      reply: (args) => {
        if (args[0] !== 'd1') return;
        if (args[2] === 'apply' && !incomplete)
          throw new Error('Migration failed');
        if (args[2] === 'list') return '[{"Name":"0002_pending.sql"}]';
      },
    });
    await assert.rejects(h.run(), /[Mm]igration/);
    assert.equal(h.mutations().length, 1);
  }
});

test('an upload error does not retry or roll back migrations automatically', async () => {
  const h = harness({
    reply: (args) => {
      if (args[0] === 'deploy') throw new Error('Upload failed');
    },
  });
  await assert.rejects(h.run(), /Upload failed/);
  assert.equal(h.mutations().length, 2);
  assert.deepEqual(h.reports, []);
});

test('successful CLI exit is not accepted without a single serving version annotated with this commit', async () => {
  for (const reply of [
    (args: string[]) =>
      args[1] === 'deployments' ? '{"deployments":[]}' : undefined,
    (args: string[]) =>
      args[1] === 'deployments'
        ? JSON.stringify({
            deployments: [
              { versions: [{ version_id: version, percentage: 50 }] },
            ],
          })
        : undefined,
    (args: string[]) =>
      args[1] === 'versions' ? '{"annotations":{}}' : undefined,
    (args: string[]) =>
      args[1] === 'versions' ? 'PRIVATE_REMOTE_DIAGNOSTIC' : undefined,
  ]) {
    const h = harness({ reply });
    await assert.rejects(
      h.run(),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('PRIVATE_REMOTE_DIAGNOSTIC'),
    );
    assert.equal(h.mutations().length, 2);
    assert.deepEqual(h.waits, Array(5).fill(2_000));
    assert.deepEqual(h.reports, []);
  }
});

test('manual main runs follow the same deployment path', async () => {
  assert.equal(
    await harness({
      environment: { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    }).run(),
    'deployed',
  );
});

test('main reference lookup fails closed on HTTP, network, and malformed responses without exposing credentials', async () => {
  const responses = [
    new Response('PRIVATE_REMOTE_DIAGNOSTIC', { status: 403 }),
    new Response('not JSON'),
    Response.json({ ref: 'refs/heads/other', object: { sha } }),
    Response.json({ ref: 'refs/heads/main', object: { sha: 'bad' } }),
  ];
  for (const response of responses) {
    await assert.rejects(
      currentMain('example/syndicord', 'secret-token', async () => response),
      /Could not verify current main/,
    );
  }
  await assert.rejects(
    currentMain('example/syndicord', 'secret-token', async () => {
      throw new Error('secret-token');
    }),
    /Could not verify current main/,
  );
  assert.equal(
    await currentMain(
      'example/syndicord',
      'secret-token',
      async (url, init) => {
        assert.equal(
          url,
          'https://api.github.com/repos/example/syndicord/git/ref/heads/main',
        );
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal);
        return Response.json({ ref: 'refs/heads/main', object: { sha } });
      },
    ),
    sha,
  );
});
