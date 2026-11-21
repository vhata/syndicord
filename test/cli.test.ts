import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
test('CLI usage needs no target; infrastructure operations require explicit valid account and database', async () => {
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
    for (const command of ['status', 'migrate', 'deploy']) {
      const result = await runCli([command], env, {
        cf: async () => {
          throw new Error('must not call');
        },
      });
      assert.equal(result.code, 2);
      assert.doesNotMatch(result.stderr, /must not call/);
    }
  }
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
      },
    }),
  );
  await mkdir(join(worker, 'bundle'));
  await writeFile(join(worker, 'bundle/index.js'), 'export default {};');
  const configPath = join(worker, 'worker.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.manifest = {
    type: 'complete',
    mainModule: 'index.js',
    modules: { 'index.js': { type: 'esm' } },
  };
  await writeFile(configPath, JSON.stringify(config));
  return directory;
}

test('deployment rejects configuration flags before building or changing resources', async () => {
  for (const args of [
    ['deploy', '--webhooks-file', '-'],
    ['deploy', '--dry-run', '--webhooks-file', '-'],
    ['deploy', '--dry-run', '--dry-run'],
  ]) {
    let called = false;
    const result = await runCli(args, environment, {
      cf: async () => {
        called = true;
        throw new Error('must not call');
      },
      readInput: async () => {
        called = true;
        throw new Error('must not read');
      },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Expected deploy/);
    assert.equal(called, false);
  }
});

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
        assert.deepEqual(Object.keys(worker.env), ['DB']);
        return '';
      };
      assert.equal(
        (
          await runCli(['deploy', '--dry-run'], env, {
            cf,
            packageRoot,
            sourceCheckout: false,
          })
        ).code,
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

test('deployment needs no feed configuration or secrets, migrates, and verifies the new serving version', async () => {
  const packageRoot = await artifact();
  const calls: string[][] = [];
  let message = '';
  let historyReads = 0;
  const waits: number[] = [];
  const previousVersion = '11111111-4321-4321-4321-cba987654321';
  const cf: Cf = async (args) => {
    calls.push(args);
    if (args[0] === 'd1' && args[1] === 'migrations')
      return args[2] === 'list' ? '[]' : '';
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
                version_id:
                  historyReads++ === 0
                    ? previousVersion
                    : '87654321-4321-4321-4321-cba987654321',
                percentage: 100,
              },
            ],
          },
        ],
      });
    if (args[1] === 'versions')
      return JSON.stringify({
        annotations: {
          'workers/message':
            args[3] === previousVersion ? 'previous deployment' : message,
        },
      });
    throw new Error('unexpected command');
  };
  try {
    const result = await runCli(['deploy'], environment, {
      cf,
      packageRoot,
      sourceCheckout: false,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(waits, [2_000]);
    assert.equal(calls.filter((args) => args[0] === 'deploy').length, 1);
    assert.equal(
      calls.filter((args) => args[1] === 'migrations' && args[2] === 'apply')
        .length,
      1,
    );
    assert.match(result.stdout, /Worker version:/);
    assert.deepEqual(
      calls.slice(0, 3).map((args) => args.slice(0, 3)),
      [
        ['d1', 'migrations', 'apply'],
        ['d1', 'migrations', 'list'],
        ['deploy', '--prebuilt', '--no-provision'],
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

test('deployment stops before upload for incomplete or unverifiable migrations', async () => {
  const packageRoot = await artifact();
  try {
    for (const pending of ['[{"Name":"pending.sql"}]', 'invalid-json']) {
      let uploaded = false;
      const cf: Cf = async (args) => {
        if (args[0] === 'deploy') uploaded = true;
        if (args[1] === 'migrations') return args[2] === 'list' ? pending : '';
        throw new Error('unexpected command');
      };
      const result = await runCli(['deploy'], environment, {
        cf,
        packageRoot,
        sourceCheckout: false,
      });
      assert.equal(result.code, 2);
      assert.equal(uploaded, false);
      assert.match(result.stderr, /migrations/);
    }
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('an ambiguous upload result is not retried or reported as a verified deployment', async () => {
  const packageRoot = await artifact();
  let uploads = 0;
  const waits: number[] = [];
  const cf: Cf = async (args) => {
    if (args[1] === 'migrations') return args[2] === 'list' ? '[]' : '';
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
    const result = await runCli(['deploy'], environment, {
      cf,
      packageRoot,
      sourceCheckout: false,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.equal(result.code, 2);
    assert.equal(uploads, 1);
    assert.deepEqual(waits, Array(5).fill(2_000));
    assert.match(result.stderr, /active Worker version could not be verified/);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('source deployment builds the current source without dist and never reuses an old bundle', async () => {
  const packageRoot = await artifact();
  const template = join(packageRoot, 'build-template');
  await cp(join(packageRoot, 'dist/worker/v1'), template, { recursive: true });
  await rm(join(packageRoot, 'dist'), { recursive: true });
  const source = join(packageRoot, 'source.js');
  const output = join(packageRoot, '.cloudflare/output/v1');
  const observed: string[] = [];
  let builds = 0;
  const cf: Cf = async (args, { cwd }) => {
    if (args[0] === 'build') {
      builds++;
      assert.equal(cwd, packageRoot);
      await assert.rejects(
        readFile(join(output, 'workers/default/bundle/index.js')),
      );
      await mkdir(join(packageRoot, '.cloudflare/output'), { recursive: true });
      await cp(template, output, { recursive: true });
      await writeFile(
        join(output, 'workers/default/bundle/index.js'),
        await readFile(source),
      );
      return '';
    }
    assert.equal(args[0], 'deploy');
    assert.ok(args.includes('--dry-run'));
    observed.push(
      await readFile(
        join(cwd, '.cloudflare/output/v1/workers/default/bundle/index.js'),
        'utf8',
      ),
    );
    return '';
  };
  try {
    for (const revision of [
      'first source revision',
      'second source revision',
    ]) {
      await writeFile(source, revision);
      const result = await runCli(['deploy', '--dry-run'], environment, {
        cf,
        packageRoot,
        sourceCheckout: true,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Validated source/);
    }
    assert.equal(builds, 2);
    assert.deepEqual(observed, [
      'first source revision',
      'second source revision',
    ]);
    await assert.rejects(
      readFile(join(packageRoot, 'dist/worker/v1/config.json')),
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('a failed or incomplete source build stops before any Cloudflare mutation', async () => {
  for (const partial of [false, true]) {
    const packageRoot = await artifact();
    const output = join(packageRoot, '.cloudflare/output/v1');
    await cp(join(packageRoot, 'dist/worker/v1'), output, { recursive: true });
    const calls: string[][] = [];
    const cf: Cf = async (args) => {
      calls.push(args);
      if (!partial) throw new Error('compiler failure');
      return '';
    };
    try {
      const result = await runCli(['deploy'], environment, {
        cf,
        packageRoot,
        sourceCheckout: true,
      });
      assert.equal(result.code, 2);
      assert.deepEqual(calls, [['build']]);
      await assert.rejects(readFile(join(output, 'config.json')));
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
    }
  }
});

test('incomplete module manifests fail before migrations', async () => {
  const packageRoot = await artifact();
  const configPath = join(
    packageRoot,
    'dist/worker/v1/workers/default/worker.config.json',
  );
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.manifest.modules['missing.js.map'] = { type: 'sourcemap' };
  await writeFile(configPath, JSON.stringify(config));
  try {
    const calls: string[][] = [];
    const result = await runCli(['deploy'], environment, {
      packageRoot,
      sourceCheckout: false,
      cf: async (args) => {
        calls.push(args);
        return '';
      },
    });
    assert.equal(result.code, 2);
    assert.deepEqual(calls, []);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
