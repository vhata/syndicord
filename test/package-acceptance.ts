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

// Drive the real browser/Worker protocol while the installed CLI polls. Discord
// HTTP is mocked by Miniflare; no credential fixture bypasses application auth.
async function approveCliLogin(verificationUri: string) {
  const origin = new URL(verificationUri).origin;
  const cookies = new Map<string, string>();
  const browser = async (path: string, init: RequestInit = {}) => {
    const target = new URL(path, origin);
    assert.equal(target.origin, origin);
    const result = await fetch(target, {
      ...init,
      redirect: 'manual',
      headers: {
        Cookie: [...cookies]
          .map(([name, value]) => `${name}=${value}`)
          .join('; '),
        ...init.headers,
      },
    });
    for (const value of result.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0]!;
      const split = pair.indexOf('=');
      const name = pair.slice(0, split);
      if (value.includes('Max-Age=0')) cookies.delete(name);
      else cookies.set(name, pair.slice(split + 1));
    }
    return result;
  };
  const requestId = new URL(verificationUri).searchParams.get('request')!;
  const landing = await browser(verificationUri);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Sign in with Discord/);
  const start = await browser(`/admin/auth/login?request=${requestId}`);
  assert.equal(start.status, 303);
  const authorization = new URL(start.headers.get('location')!);
  assert.equal(authorization.origin, 'https://discord.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    authorization.searchParams.get('scope'),
    'identify guilds.members.read',
  );
  const callback = new URL('/admin/auth/callback', origin);
  callback.searchParams.set('state', authorization.searchParams.get('state')!);
  callback.searchParams.set('code', 'package-authorization-code');
  callback.searchParams.set('iss', 'https://discord.com');
  const signedIn = await browser(callback.href);
  assert.equal(signedIn.status, 303);
  assert.equal(
    signedIn.headers.get('location'),
    `/admin/auth/cli?request=${requestId}`,
  );
  const consent = await browser(verificationUri);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const approval = /name="approval" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(
    approval,
    'the browser must explicitly approve the terminal request',
  );
  const approved = await browser('/admin/auth/cli/approve', {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ requestId, approval, decision: 'approve' }),
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.doesNotMatch(await approved.text(), /discord-package-private-token/);
  return async (path: string, init: RequestInit = {}) => browser(path, init);
}

async function installedLogin(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  let approval: ReturnType<typeof approveCliLogin> | undefined;
  let stderr = '';
  const result = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = execFile(
        executable,
        ['login', '--no-browser'],
        {
          cwd,
          env,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, output) => {
          if (error)
            reject(new Error(`Installed login failed: ${stdout} ${output}`));
          else resolve({ stdout, stderr: output });
        },
      );
      child.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
        const match =
          /^Open (http:\/\/127\.0\.0\.1:\d+\/admin\/auth\/cli\?request=[A-Za-z0-9_-]+)$/m.exec(
            stderr,
          );
        if (!approval && match) {
          approval = approveCliLogin(match[1]!);
          approval.catch((error: unknown) => {
            child.kill();
            reject(error);
          });
        }
      });
      child.stdin!.end();
    },
  );
  assert.ok(approval, 'installed login printed a browser verification URL');
  assert.match(result.stdout, /Signed in as/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /discord-package-private-token|package-client-secret/,
  );
  return approval;
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
      assert.ok(files.includes('migrations/0005_discord_auth.sql'));
      assert.ok(files.includes('migrations/0007_session_permission_cache.sql'));
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
      assert.equal(packaged.observability.redactQueryString, true);
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
        const authBindings = {
          DISCORD_CLIENT_ID: '100000000000000001',
          DISCORD_CLIENT_SECRET: 'package-client-secret',
          DISCORD_REDIRECT_URI: 'http://127.0.0.1/admin/auth/callback',
          DISCORD_GUILD_ID: '100000000000000002',
          DISCORD_ROLE_ID: '100000000000000003',
          CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, index + 1).toString('base64'),
        };
        let hasRole = true;
        let policy: string | undefined;
        const runtimeOptions = (redirectUri: string) =>
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
              ...authBindings,
              DISCORD_REDIRECT_URI: redirectUri,
              ...(policy ? { DISCORD_AUTH_POLICY: policy } : {}),
            },
            outboundService: async (request) => {
              if (request.url === 'https://discord.com/api/oauth2/token') {
                const body = new URLSearchParams(await request.text());
                assert.equal(body.get('code'), 'package-authorization-code');
                assert.ok(body.get('code_verifier'));
                return Response.json({
                  access_token: 'discord-package-private-token',
                  token_type: 'Bearer',
                  expires_in: 3600,
                  scope: 'identify guilds.members.read',
                });
              }
              if (request.url === 'https://discord.com/api/v10/users/@me')
                return Response.json({
                  id: '100000000000000004',
                  username: 'package-user',
                  global_name: 'Package User',
                });
              if (
                request.url ===
                `https://discord.com/api/v10/users/@me/guilds/${authBindings.DISCORD_GUILD_ID}/member`
              )
                return Response.json({
                  roles: hasRole ? [authBindings.DISCORD_ROLE_ID] : [],
                });
              const webhook = /^\/api\/v10\/webhooks\/(\d+)\//.exec(
                new URL(request.url).pathname,
              );
              if (policy && webhook && request.method === 'GET')
                return Response.json({
                  id: webhook[1],
                  type: 1,
                  guild_id: authBindings.DISCORD_GUILD_ID,
                  channel_id:
                    webhook[1] === '100000000000000099'
                      ? '100000000000000007'
                      : '100000000000000006',
                });
              outboundRequests++;
              return new Response(
                'Unexpected outbound HTTP is disabled in package tests',
                { status: 503 },
              );
            },
          });
        const runtime = new Miniflare(
          runtimeOptions(authBindings.DISCORD_REDIRECT_URI),
        );
        runtimes.push(runtime);
        const adminOrigin = (await runtime.ready).origin;
        await runtime.setOptions({
          ...runtimeOptions(`${adminOrigin}/admin/auth/callback`),
          port: Number(new URL(adminOrigin).port),
        });
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
          SYNDICORD_ADMIN_URL: adminOrigin,
          XDG_CONFIG_HOME: join(directory, 'private cli sessions'),
        };
        adminEnvironments.push(apiEnvironment);
        const browser = await installedLogin(
          executable,
          hostile,
          apiEnvironment,
        );
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
        // The browser sees exactly the installed CLI's current configuration.
        const snapshot = await browser('/admin/api/config');
        assert.equal(snapshot.status, 200);
        const current = (await snapshot.json()) as {
          feeds: unknown;
          revision: string;
        };
        assert.deepEqual(current.feeds, feeds);
        hasRole = false;
        assert.deepEqual(
          JSON.parse((await admin(['feeds', 'get'])).stdout),
          feeds,
        );
        assert.equal((await browser('/admin/api/config')).status, 200);
        // The installed browser and CLI keep their existing grants within the
        // window, then both must refresh once persisted evidence has expired.
        await db
          .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
          .bind(Date.now() - 120_000)
          .run();
        const rejected = await admin(['feeds', 'get'], { status: 2 });
        assert.match(rejected.stderr, /Access.*denied|role|server/i);
        const denied = await browser('/admin/api/config', {
          method: 'PUT',
          headers: { Origin: adminOrigin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: current.revision,
            feeds: [],
            webhooks: {},
          }),
        });
        assert.equal(denied.status, 403);
        hasRole = true;
        if (index === 1) {
          policy = JSON.stringify({
            version: 1,
            grants: [
              {
                guildId: authBindings.DISCORD_GUILD_ID,
                roleId: authBindings.DISCORD_ROLE_ID,
                addFeeds: true,
                channelIds: ['100000000000000006', '100000000000000007'],
              },
            ],
          });
          await runtime.setOptions({
            ...runtimeOptions(`${adminOrigin}/admin/auth/callback`),
            port: Number(new URL(adminOrigin).port),
          });
          const scopedBrowser = await installedLogin(
            executable,
            hostile,
            apiEnvironment,
          );
          await admin(['catalog', 'initialize']);
          await admin(['catalog', 'add', '--file', '-'], {
            input: JSON.stringify({
              label: 'Private catalog source',
              url: 'https://catalog.example/feed?secret=package-private-source',
            }),
          });
          const catalog = JSON.parse(
            (await admin(['catalog', 'list'])).stdout,
          ) as { id: string }[];
          assert.equal(catalog.length, 1);
          assert.doesNotMatch(
            JSON.stringify(catalog),
            /package-private-source|catalog\.example/,
          );
          await admin(['destinations', 'register', '--file', '-'], {
            input: JSON.stringify({
              label: 'Scoped target',
              webhookUrl:
                'https://discord.com/api/webhooks/100000000000000099/scoped-package-token',
            }),
          });
          const destinations = JSON.parse(
            (await admin(['destinations', 'list'])).stdout,
          ) as { id: string; label: string }[];
          const scopedTarget = destinations.find(
            (value) => value.label === 'Scoped target',
          )!;
          assert.ok(scopedTarget);
          await admin([
            'subscriptions',
            'add',
            catalog[0]!.id,
            scopedTarget.id,
          ]);
          assert.deepEqual(
            JSON.parse((await admin(['subscriptions', 'list'])).stdout),
            [{ feedId: catalog[0]!.id, destinationId: scopedTarget.id }],
          );
          const scopedSnapshot = await scopedBrowser('/admin/api/catalog');
          assert.equal(scopedSnapshot.status, 200);
          assert.doesNotMatch(
            await scopedSnapshot.text(),
            /package-private-source|scoped-package-token/,
          );
          assert.match(
            (
              await admin(['feeds', 'set', '--file', '-'], {
                input: '[]',
                status: 2,
              })
            ).stderr,
            /catalog|scoped/i,
          );
          hasRole = false;
          assert.equal((await scopedBrowser('/admin/api/catalog')).status, 200);
          await admin(['catalog', 'list']);
          await db
            .prepare('UPDATE admin_sessions SET permissions_checked_at_ms = ?')
            .bind(Date.now() - 120_000)
            .run();
          assert.equal((await scopedBrowser('/admin/api/catalog')).status, 403);
          await admin(['catalog', 'list'], { status: 2 });
          hasRole = true;
        }
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
        {
          ...adminEnvironments[0],
          XDG_CONFIG_HOME: join(directory, 'signed out'),
        },
        { status: 2 },
      );
      assert.doesNotMatch(
        unauthenticated.stderr,
        /discord-package-private-token|package-client-secret/,
      );
      assert.equal(
        outboundRequests,
        0,
        'authentication and configuration never fetch feeds or send webhooks',
      );
      await runAdminCli(executable, ['logout'], hostile, adminEnvironments[1]!);
      const signedOut = await runAdminCli(
        executable,
        ['feeds', 'get'],
        hostile,
        adminEnvironments[1]!,
        { status: 2 },
      );
      assert.match(signedOut.stderr, /login/);
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
  'packing from Git and installing globally preserves caller state and runs through npx from another directory',
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
      npm_config_loglevel: 'error',
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
      const prefix = join(directory, 'global installation');
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
          'pack',
          `git+${pathToFileURL(fixture).href}#${commit}`,
          '--pack-destination',
          directory,
        ],
        parent,
      );
      const tarballs = (await readdir(directory)).filter((path) =>
        path.endsWith('.tgz'),
      );
      assert.equal(tarballs.length, 1);
      const tarball = join(directory, tarballs[0]!);
      await rm(fixture, { recursive: true, force: true });
      run(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          tarball,
        ],
        parent,
      );
      const installed = join(prefix, 'lib/node_modules/syndicord');
      assert.equal((await lstat(installed)).isSymbolicLink(), false);
      for (const path of ['src/index.ts', 'cli/index.ts', 'feeds.json'])
        await assert.rejects(readFile(join(installed, path)));
      for (const dependency of ['husky', 'typescript', 'esbuild', 'wrangler'])
        for (const base of [join(prefix, 'lib'), installed])
          await assert.rejects(
            readFile(join(base, `node_modules/${dependency}/package.json`)),
          );
      await readFile(join(installed, 'dist/cli.js'));
      await readFile(
        join(installed, 'dist/worker/v1/workers/default/bundle/index.js'),
      );
      await rm(tarball);
      // A fresh offline cache proves npx resolves the installed global binary
      // without downloading a registry package or depending on the source tree.
      const npxEnvironment = {
        ...environment,
        npm_config_prefix: prefix,
        npm_config_cache: join(directory, 'empty npx cache'),
        npm_config_offline: 'true',
      };
      assert.match(
        run('npx', ['syndicord', '--help'], parent, npxEnvironment),
        /Usage: syndicord/,
      );
      assert.match(
        run(
          'npx',
          ['syndicord', 'deploy', '--dry-run'],
          parent,
          npxEnvironment,
        ),
        /Validated package for Worker git-package-test/,
      );
      const runtimeBin = join(directory, 'runtime-bin');
      await mkdir(runtimeBin);
      await symlink(process.execPath, join(runtimeBin, 'node'));
      const runtimeEnvironment = { ...environment, PATH: runtimeBin };
      const executable = join(prefix, 'bin/syndicord');
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
