import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import test from 'node:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { isolatedGitEnvironment } from './helpers/git-environment.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

// A synchronous child would block Miniflare's request dispatch on this thread.
function runAdminCli(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { input?: string; status?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        try {
          assert.equal(
            error?.code ?? 0,
            options.status ?? 0,
            `${executable} ${args.join(' ')}\n${stdout}\n${stderr}`,
          );
          resolve({ stdout, stderr });
        } catch (failure) {
          reject(failure);
        }
      },
    );
    child.stdin!.end(options.input ?? '');
  });
}

test(
  'production tarball runs without a checkout, preserves installation isolation, and needs no dev dependencies',
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'syndicord package acceptance '),
    );
    const runtimes: Miniflare[] = [];
    const environment = {
      ...isolatedGitEnvironment(process.env),
      CF_SEND_TELEMETRY: 'false',
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: join(directory, 'logs'),
      CLOUDFLARE_API_TOKEN: 'not-a-real-token-package-test',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      SYNDICORD_DATABASE_ID: '12345678-1234-1234-1234-123456789abc',
      SYNDICORD_WORKER_NAME: 'package-test-one',
      CLOUDFLARE_CI_OVERRIDE_WORKER_NAME: 'must-not-be-used',
    };
    const run = (
      command: string,
      args: string[],
      cwd: string,
      options: {
        input?: string;
        env?: NodeJS.ProcessEnv;
        status?: number;
      } = {},
    ) => {
      const result = spawnSync(command, args, {
        cwd,
        env: options.env ?? environment,
        encoding: 'utf8',
        input: options.input,
        timeout: 90_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      assert.equal(
        result.status,
        options.status ?? 0,
        `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
      );
      return result.stdout;
    };
    try {
      const packed = JSON.parse(
        run(
          'npm',
          [
            'pack',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            directory,
          ],
          root,
        ),
      )[0];
      const files = packed.files.map(
        (file: { path: string }) => file.path,
      ) as string[];
      assert.ok(files.includes('dist/cli.js'));
      assert.ok(files.includes('migrations/0003_runtime_configuration.sql'));
      assert.ok(files.includes('migrations/0004_web_admin.sql'));
      assert.ok(
        !files.some(
          (path) =>
            path === 'feeds.json' ||
            path.startsWith('src/') ||
            path.startsWith('cli/') ||
            path.startsWith('test/') ||
            path.startsWith('.env') ||
            path.startsWith('.dev.vars'),
        ),
      );
      const installation = join(directory, 'installed package');
      await mkdir(installation);
      // Exercise lifecycle scripts explicitly, including the package's prepare.
      await writeFile(
        join(installation, 'package.json'),
        JSON.stringify({
          private: true,
          allowScripts: {
            'syndicord@0.0.0': true,
            'workerd@1.20261117.1': true,
          },
        }),
      );
      run(
        'npm',
        [
          'install',
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          join(directory, packed.filename),
        ],
        installation,
      );
      const packageRoot = join(installation, 'node_modules/syndicord');
      const executable = join(installation, 'node_modules/.bin/syndicord');
      const globalBin = join(directory, 'bin');
      await mkdir(globalBin);
      await symlink(
        join(packageRoot, 'dist/cli.js'),
        join(globalBin, 'syndicord'),
      );
      for (const bin of [executable, join(globalBin, 'syndicord')])
        assert.match(run(bin, ['--help'], directory), /Usage: syndicord/);
      for (const dependency of ['husky', 'typescript', 'esbuild', 'wrangler'])
        await assert.rejects(
          readFile(
            join(installation, `node_modules/${dependency}/package.json`),
          ),
        );
      await assert.rejects(readFile(join(packageRoot, 'feeds.json')));
      const packaged = JSON.parse(
        await readFile(
          join(
            packageRoot,
            'dist/worker/v1/workers/default/worker.config.json',
          ),
          'utf8',
        ),
      );
      run('npm', ['run', 'prepare'], packageRoot);
      assert.equal(packaged.env.DB.id, '00000000-0000-4000-8000-000000000001');
      assert.equal(packaged.name, 'syndicord');
      assert.deepEqual(Object.keys(packaged.env), ['DB']);
      assert.equal(
        JSON.parse(
          await readFile(
            join(packageRoot, 'dist/worker/v1/config.json'),
            'utf8',
          ),
        ).settings,
        undefined,
      );

      const hostile = join(directory, 'unrelated project');
      await mkdir(hostile);
      await writeFile(
        join(hostile, 'cloudflare.config.ts'),
        'throw new Error("Caller config must not load");',
      );
      await writeFile(
        join(hostile, '.env'),
        'CLOUDFLARE_ACCOUNT_ID=wrong-account\nSYNDICORD_DATABASE_ID=wrong-db\nSYNDICORD_WORKER_NAME=wrong-worker\n',
      );
      for (const env of [
        environment,
        {
          ...environment,
          CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
          SYNDICORD_DATABASE_ID: '87654321-4321-4321-4321-cba987654321',
          SYNDICORD_WORKER_NAME: 'package-test-two',
        },
      ]) {
        const output = run(executable, ['deploy', '--dry-run'], hostile, {
          env,
        });
        assert.match(
          output,
          new RegExp(
            `Validated package for Worker ${env.SYNDICORD_WORKER_NAME}`,
          ),
        );
      }
      const unchanged = JSON.parse(
        await readFile(
          join(
            packageRoot,
            'dist/worker/v1/workers/default/worker.config.json',
          ),
          'utf8',
        ),
      );
      assert.deepEqual(unchanged, packaged);

      const localEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(environment).filter(
          ([name]) =>
            !name.startsWith('CLOUDFLARE_') && !name.startsWith('SYNDICORD_'),
        ),
      );
      const routes = [
        [{ url: 'https://first.example/feed.xml', destinations: ['one'] }],
        [],
      ];
      const adminEnvironments: NodeJS.ProcessEnv[] = [];
      let outboundRequests = 0;
      for (const [index, feeds] of routes.entries()) {
        const password = `package-admin-password-${index}`;
        const runtime = new Miniflare(
          convertV4MiniflareOptions({
            modules: true,
            // Keep module names relative to the bundle, including when the npm
            // installation path contains spaces or sits outside this checkout.
            modulesRoot: join(
              packageRoot,
              'dist/worker/v1/workers/default/bundle',
            ),
            scriptPath: join(
              packageRoot,
              'dist/worker/v1/workers/default/bundle/index.js',
            ),
            compatibilityDate: '2026-11-18',
            cf: false,
            host: '127.0.0.1',
            port: 0,
            d1Databases: { DB: `package-admin-${index}` },
            bindings: {
              ADMIN_PASSWORD: password,
              CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, index + 1).toString(
                'base64',
              ),
            },
            outboundService: async () => {
              outboundRequests++;
              return new Response(
                'Outbound HTTP is disabled in package tests',
                {
                  status: 503,
                },
              );
            },
          }),
        );
        runtimes.push(runtime);
        const db = await runtime.getD1Database('DB');
        // Read migrations from the installed tarball, never from the checkout.
        for (const name of (await readdir(join(packageRoot, 'migrations')))
          .filter((name) => name.endsWith('.sql'))
          .sort()) {
          const migration = await readFile(
            join(packageRoot, 'migrations', name),
            'utf8',
          );
          await db.batch(
            migration
              .split(';')
              .map((sql) => sql.trim())
              .filter(Boolean)
              .map((sql) => db.prepare(sql)),
          );
        }
        const apiEnvironment = {
          ...localEnvironment,
          SYNDICORD_ADMIN_URL: (await runtime.ready).origin,
          SYNDICORD_ADMIN_PASSWORD: password,
        };
        adminEnvironments.push(apiEnvironment);
        const admin = (
          args: string[],
          options: { input?: string; status?: number } = {},
        ) => runAdminCli(executable, args, hostile, apiEnvironment, options);
        assert.deepEqual(
          JSON.parse((await admin(['feeds', 'get'])).stdout),
          [],
        );
        assert.deepEqual(
          JSON.parse((await admin(['webhooks', 'list'])).stdout),
          [],
        );
        const webhook = `https://discord.com/api/webhooks/${index + 1000}/package-test-token`;
        const replacement = `https://discord.com/api/webhooks/${index + 2000}/replacement-test-token`;
        const unused = `https://discord.com/api/webhooks/${index + 3000}/unused-test-token`;
        await admin(['webhooks', 'set', '--file', '-'], {
          input: JSON.stringify({ one: webhook, unused }),
        });
        await admin(['feeds', 'set', '--file', '-'], {
          input: JSON.stringify(feeds),
        });
        assert.deepEqual(
          JSON.parse((await admin(['feeds', 'get'])).stdout),
          feeds,
        );
        await admin(['webhooks', 'set', '--file', '-'], {
          input: JSON.stringify({ one: replacement }),
        });
        const listed = await admin(['webhooks', 'list']);
        assert.deepEqual(JSON.parse(listed.stdout), ['one', 'unused']);
        assert.doesNotMatch(
          listed.stdout + listed.stderr,
          /test-token|discord\.com/,
        );
        if (feeds.length) {
          const removal = await admin(['webhooks', 'remove', 'one'], {
            status: 2,
          });
          assert.match(removal.stderr, /Remove routes to destination one/);
          assert.deepEqual(
            JSON.parse((await admin(['feeds', 'get'])).stdout),
            feeds,
          );
        }
        await admin(['webhooks', 'remove', 'unused']);
        assert.deepEqual(
          JSON.parse((await admin(['webhooks', 'list'])).stdout),
          ['one'],
        );
        const stored = await db
          .prepare(
            'SELECT feeds, encrypted_webhooks FROM relay_configuration WHERE id = 1',
          )
          .first<{ feeds: string; encrypted_webhooks: string }>();
        assert.deepEqual(JSON.parse(stored!.feeds), feeds);
        assert.match(stored!.encrypted_webhooks, /^v1\./);
        assert.doesNotMatch(
          stored!.encrypted_webhooks,
          /test-token|discord\.com/,
        );
      }
      assert.deepEqual(
        JSON.parse(
          (
            await runAdminCli(
              executable,
              ['feeds', 'get'],
              hostile,
              adminEnvironments[0]!,
            )
          ).stdout,
        ),
        routes[0],
      );
      const unauthenticated = await runAdminCli(
        executable,
        ['feeds', 'get'],
        hostile,
        { ...adminEnvironments[0], SYNDICORD_ADMIN_PASSWORD: 'wrong-password' },
        { status: 2 },
      );
      assert.doesNotMatch(
        unauthenticated.stderr,
        /package-admin-password|wrong-password/,
      );
      assert.equal(
        outboundRequests,
        0,
        'configuration never fetches feeds or sends webhooks',
      );
      for (const runtime of runtimes.splice(0)) await runtime.dispose();

      // Status remains an independent local D1 diagnostic. Seed only its fixture
      // directly; installed configuration commands above all use the admin API.
      const database = '00000000-0000-4000-8000-000000000001';
      for (const [index, feeds] of routes.entries()) {
        const cwd = join(directory, `status installation ${index}`);
        await mkdir(cwd);
        const persist = join(cwd, '.cloudflare/state');
        run(
          executable,
          [
            'cf',
            'd1',
            'migrations',
            'apply',
            database,
            '--local',
            '--persist-to',
            persist,
            '--dir',
            join(packageRoot, 'migrations'),
          ],
          cwd,
          { env: localEnvironment },
        );
        const fixture = join(cwd, 'status-fixture.json');
        await writeFile(
          fixture,
          JSON.stringify([
            {
              sql: 'INSERT INTO relay_configuration (id, feeds, updated_at_ms) VALUES (1, ?, 1)',
              params: [JSON.stringify(feeds)],
            },
          ]),
        );
        run(
          executable,
          [
            'cf',
            'd1',
            'raw',
            database,
            '--batch',
            `@${fixture}`,
            '--local',
            '--persist-to',
            persist,
          ],
          cwd,
          { env: localEnvironment },
        );
        const status = JSON.parse(
          run(executable, ['status', '--local', '--json'], cwd, {
            env: localEnvironment,
            status: feeds.length ? 1 : 0,
          }),
        );
        assert.equal(status.target, 'local');
        assert.equal(status.health, feeds.length ? 'unknown' : 'disabled');
        assert.equal(status.feeds.length, feeds.length);
      }
    } finally {
      for (const runtime of runtimes) await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'normal npm Git installation isolates caller Git state and runs without a retained checkout',
  { timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syndicord git install '));
    let environment: NodeJS.ProcessEnv = {
      ...isolatedGitEnvironment(process.env),
      CI: 'true',
      HUSKY: '0',
      CF_SEND_TELEMETRY: 'false',
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: join(directory, 'logs'),
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'not-a-real-token-git-test',
      SYNDICORD_DATABASE_ID: '12345678-1234-4234-8234-123456789abc',
      SYNDICORD_WORKER_NAME: 'git-package-test',
    };
    const run = (
      command: string,
      args: string[],
      cwd: string,
      env: NodeJS.ProcessEnv = environment,
    ) => {
      const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(
        result.status,
        0,
        `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
      );
      return result.stdout;
    };
    const parent = join(directory, 'caller repository');
    // Bootstrap and inspect the disposable parent independently of the helper
    // under test, so a regression can never redirect these safety checks.
    const bootstrap = Object.fromEntries(
      Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')),
    );
    const snapshot = async () => {
      const paths = (await readdir(parent, { recursive: true }))
        .filter((path) => path !== '.git' && !path.startsWith('.git/'))
        .sort();
      return {
        head: run('git', ['rev-parse', 'HEAD'], parent, bootstrap),
        index: await readFile(join(parent, '.git/index')),
        config: await readFile(join(parent, '.git/config')),
        files: await Promise.all(
          paths.map(async (path) => [path, await readFile(join(parent, path))]),
        ),
      };
    };
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      await mkdir(parent);
      run('git', ['init', '--initial-branch=main'], parent, bootstrap);
      await writeFile(join(parent, 'original.txt'), 'committed\n');
      run('git', ['add', '--all'], parent, bootstrap);
      run(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'user.name=Package Test',
          '-c',
          'user.email=package-test@example.com',
          'commit',
          '-m',
          'Disposable parent',
        ],
        parent,
        bootstrap,
      );
      await writeFile(join(parent, 'original.txt'), 'staged\n');
      run('git', ['add', '--all'], parent, bootstrap);
      await writeFile(join(parent, 'original.txt'), 'unstaged\n');
      await writeFile(join(parent, 'untracked.txt'), 'keep me\n');
      before = await snapshot();
      const inherited: NodeJS.ProcessEnv = {
        ...environment,
        GIT_DIR: join(parent, '.git'),
        GIT_WORK_TREE: parent,
        GIT_COMMON_DIR: join(parent, '.git'),
        GIT_INDEX_FILE: join(parent, '.git/index'),
        GIT_OBJECT_DIRECTORY: join(parent, '.git/objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(parent, '.git/objects'),
        GIT_CONFIG: join(parent, '.git/config'),
        GIT_CONFIG_PARAMETERS: "'core.bare=true'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.worktree',
        GIT_CONFIG_VALUE_0: parent,
        GIT_PREFIX: 'caller/',
      };
      environment = isolatedGitEnvironment(inherited);
      assert.equal(inherited.GIT_DIR, join(parent, '.git'));
      assert.equal(environment.PATH, inherited.PATH);
      assert.equal(
        environment.CLOUDFLARE_API_TOKEN,
        inherited.CLOUDFLARE_API_TOKEN,
      );
      const fixture = join(directory, 'git source');
      const prefix = join(directory, 'installation');
      await mkdir(fixture);
      await mkdir(prefix);
      for (const path of [
        'src',
        'cli',
        'scripts',
        'migrations',
        '.husky',
        '.gitignore',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'cloudflare.config.ts',
      ])
        await cp(join(root, path), join(fixture, path), {
          recursive: true,
        });
      run('git', ['init', '--initial-branch=main'], fixture);
      assert.equal((await lstat(join(fixture, '.git'))).isDirectory(), true);
      run('git', ['add', '--all'], fixture);
      run(
        'git',
        [
          '-c',
          'user.name=Package Test',
          '-c',
          'user.email=package-test@example.com',
          'commit',
          '-m',
          'Package installation fixture',
        ],
        fixture,
      );
      const commit = run('git', ['rev-parse', 'HEAD'], fixture).trim();
      run(
        'npm',
        [
          'install',
          '--no-audit',
          '--no-fund',
          `git+${pathToFileURL(fixture).href}#${commit}`,
        ],
        prefix,
      );
      const installed = join(prefix, 'node_modules/syndicord');
      assert.equal((await lstat(installed)).isSymbolicLink(), false);
      for (const path of ['src/index.ts', 'cli/index.ts', 'feeds.json'])
        await assert.rejects(readFile(join(installed, path)));
      for (const dependency of ['husky', 'typescript', 'esbuild', 'wrangler'])
        for (const base of [prefix, installed])
          await assert.rejects(
            readFile(join(base, `node_modules/${dependency}/package.json`)),
          );
      await readFile(join(installed, 'dist/cli.js'));
      await readFile(
        join(installed, 'dist/worker/v1/workers/default/bundle/index.js'),
      );
      await rm(fixture, { recursive: true, force: true });
      assert.match(
        run('npx', ['--no-install', 'syndicord', '--help'], prefix),
        /Usage: syndicord/,
      );
      const runtimeBin = join(directory, 'runtime-bin');
      await mkdir(runtimeBin);
      await symlink(process.execPath, join(runtimeBin, 'node'));
      const runtimeEnvironment = { ...environment, PATH: runtimeBin };
      const executable = join(prefix, 'node_modules/.bin/syndicord');
      assert.match(
        run(executable, ['--help'], directory, runtimeEnvironment),
        /Usage: syndicord/,
      );
      assert.match(
        run(executable, ['deploy', '--dry-run'], directory, runtimeEnvironment),
        /Validated package for Worker git-package-test/,
      );
    } finally {
      try {
        if (before) assert.deepEqual(await snapshot(), before);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);
