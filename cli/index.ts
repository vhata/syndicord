#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { loadConfig, loadFeeds, validateWebhooks } from '../src/config.ts';
import { WRITE_CONFIGURATION_SQL } from '../src/config-store.ts';
import { runStatus } from '../src/status-command.ts';
import {
  cloudflare,
  query,
  rows,
  target,
  temporary,
  type Cf,
  type Environment,
} from './cloudflare.ts';
import { deploy, migrate, storedFeeds } from './deploy.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const USAGE = `Usage: syndicord <command>

  feeds get [--local]              Read the installation's feed routes
  feeds set [--local] --file FILE|-  Replace feed routes from JSON (or stdin)
  webhooks set --file FILE|-      Replace the complete WEBHOOKS secret
  status [--local] [--json] [--interval-minutes N]
  migrate                         Apply the packaged D1 migrations
  deploy [--dry-run] [--webhooks-file FILE|-]
  cf <arguments...>                Run the bundled Cloudflare CLI

Set CLOUDFLARE_ACCOUNT_ID and SYNDICORD_DATABASE_ID for the installation.
SYNDICORD_WORKER_NAME defaults to syndicord. Each installation needs its own D1
database. Feed routes live in D1; webhook URLs live in the encrypted Worker secret.
Configuration writes do not rebuild or deploy code. Use 'cf auth login' to sign in.
Cloudflare resources and API operations may be billable under your account plan.`;

interface Dependencies {
  cf?: Cf;
  readInput?: (path: string) => Promise<unknown>;
  packageRoot?: string;
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
  const cf = dependencies.cf ?? cloudflare(env);
  const input = dependencies.readInput ?? readInput;
  const packageRoot = dependencies.packageRoot ?? PACKAGE_ROOT;
  try {
    const [command, ...rest] = args;
    if (command === 'cf') {
      if (!rest.length)
        throw new Error(
          'Provide a Cloudflare CLI command, such as cf auth login.',
        );
      await cf(rest, { cwd: process.cwd(), interactive: true });
      return ok('');
    }
    const local =
      ['feeds', 'status'].includes(command!) && rest.includes('--local');
    if (command === 'feeds' && local) rest.splice(rest.indexOf('--local'), 1);
    const installation = target(env, local);
    if (command === 'feeds' && rest[0] === 'get' && rest.length === 1)
      return ok(
        JSON.stringify(await storedFeeds(cf, installation, local), null, 2),
      );
    if (command === 'feeds' && rest[0] === 'set') {
      const feeds = loadFeeds(await input(fileArgument(rest.slice(1))));
      rows(
        await query(
          cf,
          installation.database,
          [{ sql: WRITE_CONFIGURATION_SQL, params: [JSON.stringify(feeds)] }],
          local,
        ),
      );
      return ok(
        `Saved ${feeds.length} feeds in D1. The next scheduled poll uses this configuration.`,
      );
    }
    if (command === 'webhooks' && rest[0] === 'set') {
      const webhooks = validateWebhooks(
        await input(fileArgument(rest.slice(1))),
      );
      loadConfig(await storedFeeds(cf, installation), JSON.stringify(webhooks));
      await temporary(async (cwd) => {
        const file = join(cwd, 'webhooks.json');
        await writeFile(file, JSON.stringify(webhooks), { mode: 0o600 });
        await cf(
          [
            'workers',
            'secrets',
            'update',
            'WEBHOOKS',
            '--worker',
            installation.worker,
            '--type',
            'secret_text',
            '--text',
            `@${file}`,
          ],
          { cwd },
        );
      });
      return ok(`Updated WEBHOOKS on ${installation.worker}.`);
    }
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
      const options: { dryRun: boolean; webhooks?: Record<string, string> } = {
        dryRun: false,
      };
      const remaining = [...rest];
      const dryRunIndex = remaining.indexOf('--dry-run');
      if (dryRunIndex !== -1) {
        options.dryRun = true;
        remaining.splice(dryRunIndex, 1);
      }
      if (remaining.length)
        options.webhooks = validateWebhooks(
          await input(fileArgument(remaining, '--webhooks-file')),
        );
      return ok(await deploy(cf, installation, packageRoot, options));
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
