#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { loadFeeds, validateWebhooks } from '../src/config.ts';
import { runStatus } from '../src/status-command.ts';
import { adminClient, type AdminFetch } from './admin.ts';
import { login, logout, type LoginDependencies } from './auth.ts';
import {
  cloudflare,
  query,
  target,
  type Cf,
  type Environment,
} from './cloudflare.ts';
import { deploy, migrate } from './deploy.ts';
import { CATALOG_USAGE, runCatalogCommand } from './catalog.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_CHECKOUT = import.meta.url.endsWith('/cli/index.ts');
export const USAGE = `Usage: syndicord <command>

  login [--no-browser]            Sign in with Discord in your browser
  logout                          Invalidate this installation’s CLI session
  catalog|destinations|subscriptions   Manage scoped configuration (see below)
  feeds get                       Read the installation's feed routes
  feeds set --file FILE|-          Replace feed routes from JSON (or stdin)
  webhooks list                   List destination names without webhook URLs
  webhooks set --file FILE|-       Add or update the supplied webhook URLs
  webhooks remove NAME            Remove an unused destination
  status [--local] [--json] [--interval-minutes N]
  migrate                         Apply the packaged D1 migrations
  deploy [--dry-run]               Deploy code without changing configuration
  cf <arguments...>                Run the bundled Cloudflare CLI

Set SYNDICORD_ADMIN_URL and run 'syndicord login' to manage feeds and webhooks
through the same API as the web interface. See docs/WEB.md for configuration.
Use a loopback URL for local configuration; configuration commands do not use
--local. Saved webhook URLs are encrypted in D1 and never returned by the API.

Status, migration, and deployment use CLOUDFLARE_ACCOUNT_ID and
SYNDICORD_DATABASE_ID. SYNDICORD_WORKER_NAME defaults to syndicord.
Configuration writes do not rebuild or deploy code. 'cf auth login' signs in to
Cloudflare for infrastructure operations.
Cloudflare resources and API operations may be billable under your account plan.

${CATALOG_USAGE}`;

interface Dependencies {
  cf?: Cf;
  adminFetch?: AdminFetch;
  auth?: Omit<LoginDependencies, 'fetcher'>;
  readInput?: (path: string) => Promise<unknown>;
  packageRoot?: string;
  sourceCheckout?: boolean;
  wait?: (milliseconds: number) => Promise<void>;
}

async function readInput(path: string): Promise<unknown> {
  try {
    let text: string;
    if (path === '-') {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 256 * 1024) throw new Error();
        chunks.push(buffer);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error();
    return JSON.parse(text);
  } catch {
    throw new Error(
      'Cannot read JSON input. Provide a valid JSON file or use - for stdin (maximum 256 KiB).',
    );
  }
}

function fileArgument(args: string[], flag = '--file'): string {
  if (
    args.length !== 2 ||
    args[0] !== flag ||
    !args[1] ||
    args[1].startsWith('--')
  )
    throw new Error(`Expected ${flag} FILE (or ${flag} - for stdin).`);
  return args[1];
}

export async function runCli(
  args: string[],
  env: Environment = process.env,
  dependencies: Dependencies = {},
) {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  if (
    args.length === 0 ||
    (args.length === 1 && ['--help', '-h'].includes(args[0]!))
  )
    return ok(USAGE);
  const input = dependencies.readInput ?? readInput;
  const packageRoot = dependencies.packageRoot ?? PACKAGE_ROOT;
  try {
    const [command, ...rest] = args;
    if (command === 'login' || command === 'logout') {
      if (
        command === 'logout'
          ? rest.length !== 0
          : rest.length > 1 || (rest.length === 1 && rest[0] !== '--no-browser')
      )
        throw new Error(
          command === 'login'
            ? 'Expected syndicord login [--no-browser].'
            : 'Expected syndicord logout with no arguments.',
        );
      return ok(
        command === 'login'
          ? await login(env, {
              ...dependencies.auth,
              ...(rest[0] === '--no-browser'
                ? { openBrowser: async () => {} }
                : {}),
              ...(dependencies.adminFetch
                ? { fetcher: dependencies.adminFetch }
                : {}),
            })
          : await logout(env, dependencies.adminFetch),
      );
    }
    if (['catalog', 'destinations', 'subscriptions'].includes(command!))
      return ok(
        await runCatalogCommand(
          command!,
          rest,
          env,
          dependencies.adminFetch,
          input,
        ),
      );
    if (['feeds', 'webhooks'].includes(command!)) {
      if (rest.includes('--local'))
        throw new Error(
          'Configuration commands do not use --local. Set SYNDICORD_ADMIN_URL to a loopback URL and omit --local to edit a local Worker.',
        );
      const admin = adminClient(env, dependencies.adminFetch);
      if (command === 'feeds' && rest[0] === 'get' && rest.length === 1)
        return ok(JSON.stringify((await admin.read()).feeds, null, 2));
      if (command === 'feeds' && rest[0] === 'set') {
        const feeds = loadFeeds(await input(fileArgument(rest.slice(1))));
        const current = await admin.read();
        for (const feed of feeds)
          for (const name of feed.destinations)
            if (!current.destinations.includes(name))
              throw new Error(
                `Missing webhook for destination ${name}. Add it before routing feeds to it.`,
              );
        await admin.write(current, feeds, {});
        return ok(
          `Saved ${feeds.length} feeds. The next scheduled poll uses this configuration.`,
        );
      }
      if (command === 'webhooks' && rest[0] === 'list' && rest.length === 1)
        return ok(JSON.stringify((await admin.read()).destinations, null, 2));
      if (command === 'webhooks' && rest[0] === 'set') {
        const webhooks = validateWebhooks(
          await input(fileArgument(rest.slice(1))),
        );
        if (Object.keys(webhooks).length === 0)
          throw new Error('Provide at least one destination webhook URL.');
        const current = await admin.read();
        await admin.write(current, current.feeds, webhooks);
        return ok(
          `Saved ${Object.keys(webhooks).length} webhook destinations. The next scheduled poll uses this configuration.`,
        );
      }
      if (command === 'webhooks' && rest[0] === 'remove' && rest.length === 2) {
        const name = rest[1]!;
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))
          throw new Error(
            'Destination names must start with a letter and contain at most 64 letters, digits, underscores or hyphens.',
          );
        const current = await admin.read();
        if (!current.destinations.includes(name))
          throw new Error(`Destination ${name} is not configured.`);
        if (current.feeds.some((feed) => feed.destinations.includes(name)))
          throw new Error(
            `Remove routes to destination ${name} before deleting its webhook.`,
          );
        await admin.write(current, current.feeds, { [name]: null });
        return ok(`Removed destination ${name}.`);
      }
      throw new Error(USAGE);
    }
    const cf = dependencies.cf ?? cloudflare(env);
    if (command === 'cf') {
      if (!rest.length)
        throw new Error(
          'Provide a Cloudflare CLI command, such as cf auth login.',
        );
      await cf(rest, { cwd: process.cwd(), interactive: true });
      return ok('');
    }
    const local = command === 'status' && rest.includes('--local');
    const installation = target(env, local);
    if (command === 'status') {
      return runStatus([...(local ? [] : ['--remote']), ...rest], env, {
        query: (queries, database, localQuery) =>
          query(cf, database, queries, localQuery),
      });
    }
    if (command === 'migrate' && rest.length === 0) {
      await migrate(cf, installation, packageRoot);
      return ok('Database migrations are up to date.');
    }
    if (command === 'deploy') {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--dry-run'))
        throw new Error(
          'Expected deploy [--dry-run]. Configure feeds and webhooks through their configuration commands.',
        );
      const options = { dryRun: rest[0] === '--dry-run' };
      return ok(
        await deploy(
          cf,
          installation,
          packageRoot,
          {
            ...options,
            sourceCheckout: dependencies.sourceCheckout ?? SOURCE_CHECKOUT,
          },
          dependencies.wait,
        ),
      );
    }
    throw new Error(USAGE);
  } catch (error) {
    return {
      code: 2,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Command failed.',
    };
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.code;
}
