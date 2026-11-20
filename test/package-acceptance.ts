import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test(
  'production tarball runs without a checkout, preserves installation isolation, and needs no dev dependencies',
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'syndicord package acceptance '),
    );
    const environment = {
      ...process.env,
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
      assert.deepEqual(packaged.env.WEBHOOKS, { type: 'secret' });
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

      const localEnvironment: NodeJS.ProcessEnv = { ...environment };
      delete localEnvironment.CLOUDFLARE_ACCOUNT_ID;
      delete localEnvironment.SYNDICORD_DATABASE_ID;
      const database = '00000000-0000-4000-8000-000000000001';
      const routes = [
        [{ url: 'https://first.example/feed.xml', destinations: ['one'] }],
        [],
      ];
      for (const [index, feeds] of routes.entries()) {
        const cwd = join(directory, `local installation ${index}`);
        await mkdir(cwd);
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
            join(cwd, '.cloudflare/state'),
            '--dir',
            join(packageRoot, 'migrations'),
          ],
          cwd,
          { env: localEnvironment },
        );
        run(executable, ['feeds', 'set', '--local', '--file', '-'], cwd, {
          input: JSON.stringify(feeds),
          env: localEnvironment,
        });
        assert.deepEqual(
          JSON.parse(
            run(executable, ['feeds', 'get', '--local'], cwd, {
              env: localEnvironment,
            }),
          ),
          feeds,
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
      assert.deepEqual(
        JSON.parse(
          run(
            executable,
            ['feeds', 'get', '--local'],
            join(directory, 'local installation 0'),
            { env: localEnvironment },
          ),
        ),
        routes[0],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'normal npm Git installation builds the CLI and runs without a retained checkout',
  { timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syndicord git install '));
    const environment = {
      ...process.env,
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
    try {
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
      await rm(directory, { recursive: true, force: true });
    }
  },
);
