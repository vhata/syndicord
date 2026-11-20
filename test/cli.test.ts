import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/index.ts';
import type { Cf } from '../cli/cloudflare.ts';

const environment = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  SYNDICORD_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
  SYNDICORD_WORKER_NAME: 'installation-one',
};
const feeds = [
  {
    url: 'https://example.com/feed?token=feed-secret',
    destinations: ['updates'],
  },
];
const webhooks = {
  updates: 'https://discord.com/api/webhooks/123/webhook-secret',
};
const raw = (rows: unknown[][], columns = ['feeds']) =>
  JSON.stringify([{ success: true, results: { columns, rows } }]);

test('CLI usage needs no target; remote operations require explicit valid account and database', async () => {
  assert.equal((await runCli(['--help'], {})).code, 0);
  for (const env of [
    {},
    { ...environment, CLOUDFLARE_ACCOUNT_ID: '' },
    {
      ...environment,
      SYNDICORD_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
    },
    { ...environment, SYNDICORD_WORKER_NAME: '../../another-worker' },
  ]) {
    const result = await runCli(['feeds', 'get'], env, {
      cf: async () => {
        throw new Error('must not call');
      },
    });
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.stderr, /must not call/);
  }
});

test('feed commands use the selected D1 and parameterized temporary files, never a checkout', async () => {
  const files: string[] = [];
  const configurations = new Map<string, unknown>();
  const cf: Cf = async (args) => {
    assert.deepEqual(args.slice(0, 2), ['d1', 'raw']);
    const file = args[4]!.slice(1);
    files.push(file);
    assert.ok(!args.join(' ').includes('feed-secret'));
    const [statement] = JSON.parse(await readFile(file, 'utf8'));
    if (statement.sql.trim().startsWith('INSERT')) {
      assert.equal(statement.params.length, 1);
      configurations.set(args[2]!, JSON.parse(statement.params[0]));
      return raw([], []);
    }
    return raw(
      configurations.has(args[2]!)
        ? [[JSON.stringify(configurations.get(args[2]!))]]
        : [],
    );
  };
  const second = {
    ...environment,
    SYNDICORD_DATABASE_ID: '87654321-4321-4321-4321-cba987654321',
    SYNDICORD_WORKER_NAME: 'installation-two',
  };
  assert.equal(
    (
      await runCli(['feeds', 'set', '--file', '-'], environment, {
        cf,
        readInput: async () => feeds,
      })
    ).code,
    0,
  );
  assert.equal(
    (
      await runCli(['feeds', 'set', '--file', '-'], second, {
        cf,
        readInput: async () => [],
      })
    ).code,
    0,
  );
  assert.deepEqual(
    JSON.parse((await runCli(['feeds', 'get'], environment, { cf })).stdout),
    feeds,
  );
  assert.deepEqual(
    JSON.parse((await runCli(['feeds', 'get'], second, { cf })).stdout),
    [],
  );
  for (const file of files) await assert.rejects(readFile(file));
});

test('invalid routes are rejected before a write and missing config stays explicit', async () => {
  const invalid = await runCli(['feeds', 'set', '--file', '-'], environment, {
    readInput: async () => [{ url: 'secret-invalid', destinations: [] }],
    cf: async () => {
      throw new Error('must not call');
    },
  });
  assert.equal(invalid.code, 2);
  assert.doesNotMatch(invalid.stderr, /secret-invalid|must not call/);
  const missing = await runCli(['feeds', 'get'], environment, {
    cf: async () => raw([]),
  });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /configuration is missing/);
});

test('webhook replacement validates the whole map and keeps values out of arguments and output', async () => {
  const files: string[] = [];
  const cf: Cf = async (args) => {
    if (args[0] === 'd1') return raw([[JSON.stringify(feeds)]]);
    assert.deepEqual(args.slice(0, 9), [
      'workers',
      'secrets',
      'update',
      'WEBHOOKS',
      '--worker',
      'installation-one',
      '--type',
      'secret_text',
      '--text',
    ]);
    assert.ok(!args.join(' ').includes('webhook-secret'));
    const path = args[9]!.slice(1);
    files.push(path);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), webhooks);
    return '{}';
  };
  const result = await runCli(['webhooks', 'set', '--file', '-'], environment, {
    cf,
    readInput: async () => webhooks,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(JSON.stringify(result), /webhook-secret/);
  for (const path of files) await assert.rejects(readFile(path));
  const missing = await runCli(
    ['webhooks', 'set', '--file', '-'],
    environment,
    { cf, readInput: async () => ({}) },
  );
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Missing webhook/);
  const invalidUnused = await runCli(
    ['webhooks', 'set', '--file', '-'],
    environment,
    {
      cf,
      readInput: async () => ({
        ...webhooks,
        unused: 'https://example.com/not-discord',
      }),
    },
  );
  assert.equal(invalidUnused.code, 2);
});

async function artifact() {
  const directory = await mkdtemp(join(tmpdir(), 'syndicord-cli-test-'));
  const worker = join(directory, 'dist/worker/v1/workers/default');
  await mkdir(worker, { recursive: true });
  await mkdir(join(directory, 'migrations'));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ version: '1.2.3' }),
  );
  await writeFile(
    join(directory, 'dist/worker/v1/config.json'),
    JSON.stringify({
      producer: { name: 'wrangler', version: '4.165.0' },
      buildContext: { isPreview: false },
      settings: { accountId: 'build-machine-account' },
    }),
  );
  await writeFile(
    join(worker, 'worker.config.json'),
    JSON.stringify({
      name: 'build-machine-worker',
      env: {
        DB: { type: 'd1', id: 'build-machine-db' },
        WEBHOOKS: { type: 'secret' },
      },
    }),
  );
  return directory;
}

test('package dry runs stage independent target copies, make no API writes, and leave the package unchanged', async () => {
  const packageRoot = await artifact();
  const staged: string[] = [];
  const second = {
    ...environment,
    CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
    SYNDICORD_DATABASE_ID: '87654321-4321-4321-4321-cba987654321',
    SYNDICORD_WORKER_NAME: 'installation-two',
  };
  try {
    for (const env of [environment, second]) {
      const cf: Cf = async (args, { cwd }) => {
        assert.deepEqual(args.slice(0, 3), [
          'deploy',
          '--prebuilt',
          '--no-provision',
        ]);
        assert.ok(args.includes('--dry-run'));
        assert.ok(!args.includes('--force'));
        staged.push(cwd);
        const root = JSON.parse(
          await readFile(
            join(cwd, '.cloudflare/output/v1/config.json'),
            'utf8',
          ),
        );
        assert.equal(root.settings.accountId, env.CLOUDFLARE_ACCOUNT_ID);
        const worker = JSON.parse(
          await readFile(
            join(
              cwd,
              '.cloudflare/output/v1/workers/default/worker.config.json',
            ),
            'utf8',
          ),
        );
        assert.equal(worker.name, env.SYNDICORD_WORKER_NAME);
        assert.equal(worker.env.DB.id, env.SYNDICORD_DATABASE_ID);
        assert.deepEqual(worker.env.WEBHOOKS, { type: 'secret' });
        return '';
      };
      assert.equal(
        (await runCli(['deploy', '--dry-run'], env, { cf, packageRoot })).code,
        0,
      );
    }
    const unchanged = JSON.parse(
      await readFile(
        join(packageRoot, 'dist/worker/v1/workers/default/worker.config.json'),
        'utf8',
      ),
    );
    assert.equal(unchanged.name, 'build-machine-worker');
    for (const path of staged)
      await assert.rejects(
        readFile(join(path, '.cloudflare/output/v1/config.json')),
      );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('deployment migrates, checks hosted config, preserves secrets, and verifies the new serving version', async () => {
  const packageRoot = await artifact();
  const calls: string[][] = [];
  let message = '';
  const cf: Cf = async (args) => {
    calls.push(args);
    if (args[0] === 'd1' && args[1] === 'migrations')
      return args[2] === 'list' ? '[]' : '';
    if (args[0] === 'd1') return raw([[JSON.stringify(feeds)]]);
    if (args[1] === 'secrets')
      return '[{"name":"WEBHOOKS","type":"secret_text"}]';
    if (args[0] === 'deploy') {
      message = args[4]!;
      return '';
    }
    if (args[1] === 'deployments')
      return JSON.stringify({
        deployments: [
          {
            versions: [
              {
                version_id: '87654321-4321-4321-4321-cba987654321',
                percentage: 100,
              },
            ],
          },
        ],
      });
    if (args[1] === 'versions')
      return JSON.stringify({ annotations: { 'workers/message': message } });
    throw new Error('unexpected command');
  };
  try {
    const result = await runCli(['deploy'], environment, { cf, packageRoot });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Worker version:/);
    assert.deepEqual(
      calls.slice(0, 3).map((args) => args.slice(0, 3)),
      [
        ['d1', 'migrations', 'apply'],
        ['d1', 'migrations', 'list'],
        ['d1', 'raw', environment.SYNDICORD_DATABASE_ID],
      ],
    );
    assert.ok(
      !calls.some(
        (args) => args.includes('--secrets-file') || args.includes('--force'),
      ),
    );
    for (const args of calls.filter((args) => args[0] === 'workers'))
      assert.equal(args.at(-1), 'installation-one');
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('deployment stops before upload for missing configuration or incomplete migrations', async () => {
  const packageRoot = await artifact();
  try {
    for (const incomplete of [false, true]) {
      let uploaded = false;
      const cf: Cf = async (args) => {
        if (args[0] === 'deploy') uploaded = true;
        if (args[1] === 'migrations')
          return args[2] === 'list'
            ? incomplete
              ? '[{"Name":"pending.sql"}]'
              : '[]'
            : '';
        return raw([]);
      };
      const result = await runCli(['deploy'], environment, { cf, packageRoot });
      assert.equal(result.code, 2);
      assert.equal(uploaded, false);
    }
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('first deployment uploads a validated secret through a private temporary file and verifies activation', async () => {
  const packageRoot = await artifact();
  let secretsFile = '';
  let message = '';
  let uploads = 0;
  const cf: Cf = async (args) => {
    assert.ok(!args.join(' ').includes('webhook-secret'));
    if (args[1] === 'migrations') return args[2] === 'list' ? '[]' : '';
    if (args[0] === 'd1') return raw([[JSON.stringify(feeds)]]);
    if (args[1] === 'secrets')
      throw new Error('fresh Worker cannot have a secret yet');
    if (args[0] === 'deploy') {
      uploads++;
      message = args[4]!;
      secretsFile = args[args.indexOf('--secrets-file') + 1]!;
      assert.equal((await stat(secretsFile)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(secretsFile, 'utf8')), {
        WEBHOOKS: JSON.stringify(webhooks),
      });
      return '';
    }
    if (args[1] === 'deployments')
      return JSON.stringify({
        deployments: [
          {
            versions: [
              {
                version_id: '87654321-4321-4321-4321-cba987654321',
                percentage: 100,
              },
            ],
          },
        ],
      });
    if (args[1] === 'versions')
      return JSON.stringify({ annotations: { 'workers/message': message } });
    throw new Error('unexpected command');
  };
  try {
    const result = await runCli(
      ['deploy', '--webhooks-file', '-'],
      environment,
      { cf, packageRoot, readInput: async () => webhooks },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(uploads, 1);
    assert.doesNotMatch(JSON.stringify(result), /webhook-secret/);
    await assert.rejects(readFile(secretsFile));
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('an ambiguous upload result is not retried or reported as a verified deployment', async () => {
  const packageRoot = await artifact();
  let uploads = 0;
  const cf: Cf = async (args) => {
    if (args[1] === 'migrations') return args[2] === 'list' ? '[]' : '';
    if (args[0] === 'd1') return raw([[JSON.stringify(feeds)]]);
    if (args[1] === 'secrets') return '[{"name":"WEBHOOKS"}]';
    if (args[0] === 'deploy') {
      uploads++;
      return '';
    }
    return JSON.stringify({
      deployments: [
        {
          versions: [
            {
              version_id: '87654321-4321-4321-4321-cba987654321',
              percentage: 100,
            },
          ],
        },
      ],
    });
  };
  try {
    const result = await runCli(['deploy'], environment, { cf, packageRoot });
    assert.equal(result.code, 2);
    assert.equal(uploads, 1);
    assert.match(result.stderr, /active Worker version could not be verified/);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
