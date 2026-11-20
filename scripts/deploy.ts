import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFeeds } from '../src/config.ts';

type Environment = Record<string, string | undefined>;
type Run = (command: string, args: string[], capture?: boolean) => string;

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LOCAL_DATABASE = '00000000-0000-4000-8000-000000000001';

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value)
    throw new Error(`Set ${key} in the production GitHub environment.`);
  return value;
}

function configuration(env: Environment) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')
  ) {
    throw new Error(
      'Production deployment must run in GitHub Actions on main.',
    );
  }
  const sha = required(env, 'GITHUB_SHA');
  const repository = required(env, 'GITHUB_REPOSITORY');
  const account = required(env, 'CLOUDFLARE_ACCOUNT_ID');
  const database = required(env, 'SYNDICORD_DATABASE_ID');
  const worker = env.SYNDICORD_WORKER_NAME ?? 'syndicord';
  required(env, 'CLOUDFLARE_API_TOKEN');
  required(env, 'GITHUB_TOKEN');
  if (!SHA.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Invalid GitHub repository or commit identity.');
  }
  if (!/^[a-f0-9]{32}$/i.test(account)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account ID.');
  }
  if (!UUID.test(database) || database === LOCAL_DATABASE) {
    throw new Error(
      'SYNDICORD_DATABASE_ID must identify the production database.',
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) {
    throw new Error('SYNDICORD_WORKER_NAME must be a valid Worker name.');
  }
  return { sha, repository, database, worker };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function currentMain(
  repository: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(
      `https://api.github.com/repos/${repository}/git/ref/heads/main`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error('GitHub request failed');
    const body = record(await response.json());
    const sha = record(body?.object)?.sha;
    if (
      body?.ref !== 'refs/heads/main' ||
      typeof sha !== 'string' ||
      !SHA.test(sha)
    ) {
      throw new Error('Invalid main reference');
    }
    return sha;
  } catch {
    throw new Error(
      'Could not verify current main; no further changes were made.',
    );
  }
}

export async function deploy(options: {
  env: Environment;
  run: Run;
  main: () => Promise<string>;
  report: (message: string) => void;
}): Promise<'deployed' | 'superseded'> {
  const { env, run, main, report } = options;
  const { sha, database, worker } = configuration(env);
  if (run('git', ['rev-parse', 'HEAD'], true).trim() !== sha) {
    throw new Error('The checkout does not match the commit checked by CI.');
  }
  const cf = resolve('node_modules/.bin/cf');
  const json = (args: string[]): unknown => {
    try {
      return JSON.parse(run(cf, args, true));
    } catch {
      throw new Error(
        'Could not read Cloudflare metadata; inspect the preceding output before retrying.',
      );
    }
  };
  const fresh = async (afterMigrations = false) => {
    if ((await main()) === sha) return true;
    report(
      `Skipped ${sha}: main has advanced.${afterMigrations ? ' Applied migrations remain in place; the newer run will deploy its code.' : ''}`,
    );
    return false;
  };
  if (!(await fresh())) return 'superseded';

  const secrets = json(['workers', 'secrets', 'list', '--worker', worker]);
  if (
    !Array.isArray(secrets) ||
    !secrets.some((secret) => record(secret)?.name === 'WEBHOOKS')
  ) {
    throw new Error(
      'Set the WEBHOOKS secret on the selected Worker before deploying.',
    );
  }

  // The deployment job holds one concurrency lock across this whole sequence.
  if (!(await fresh())) return 'superseded';
  run(cf, ['d1', 'migrations', 'apply', database, '--dir', 'migrations']);
  const remaining = json([
    'd1',
    'migrations',
    'list',
    database,
    '--dir',
    'migrations',
  ]);
  if (!Array.isArray(remaining) || remaining.length !== 0) {
    throw new Error(
      'Database migrations are incomplete; Worker deployment stopped.',
    );
  }
  const stored = json([
    'd1',
    'raw',
    database,
    '--sql',
    'SELECT feeds FROM relay_configuration WHERE id = 1',
  ]);
  try {
    const query =
      Array.isArray(stored) && stored.length === 1 ? record(stored[0]) : null;
    const result = record(query?.results);
    const rows = result?.rows;
    if (
      query?.success !== true ||
      !Array.isArray(result?.columns) ||
      result.columns.length !== 1 ||
      result.columns[0] !== 'feeds' ||
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      !Array.isArray(rows[0]) ||
      rows[0].length !== 1 ||
      typeof rows[0][0] !== 'string'
    )
      throw new Error('Missing feed configuration');
    loadFeeds(JSON.parse(rows[0][0]));
  } catch {
    throw new Error(
      'Configure feeds in the selected D1 database with syndicord feeds set before deploying. The running Worker has not been replaced.',
    );
  }
  if (!(await fresh(true))) return 'superseded';
  const message = `syndicord commit ${sha}`;
  run(cf, ['deploy', '--prebuilt', '--no-provision', '--message', message]);

  const history = record(
    json(['workers', 'deployments', 'list', '--worker', worker]),
  );
  const latest = Array.isArray(history?.deployments)
    ? record(history.deployments[0])
    : null;
  const versions = latest?.versions;
  const active =
    Array.isArray(versions) && versions.length === 1
      ? record(versions[0])
      : null;
  const versionId = active?.version_id;
  if (
    active?.percentage !== 100 ||
    typeof versionId !== 'string' ||
    !UUID.test(versionId)
  ) {
    throw new Error(
      'Deployment outcome is unknown; inspect Cloudflare before retrying.',
    );
  }
  const version = record(
    json(['workers', 'versions', 'get', versionId, '--worker', worker]),
  );
  if (record(version?.annotations)?.['workers/message'] !== message) {
    throw new Error(
      'Active Worker version does not match this commit; inspect Cloudflare before retrying.',
    );
  }
  report(`Deployed commit ${sha}\n\nWorker version: ${versionId}`);
  return 'deployed';
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const run: Run = (command, args, capture = false) => {
    try {
      return (
        execFileSync(command, args, {
          encoding: 'utf8',
          stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
          maxBuffer: 4 * 1024 * 1024,
        }) ?? ''
      );
    } catch {
      throw new Error(
        'Deployment command failed; inspect the preceding output. Applied migrations are not rolled back.',
      );
    }
  };
  try {
    const config = configuration(process.env);
    await deploy({
      env: process.env,
      run,
      main: () => currentMain(config.repository, process.env.GITHUB_TOKEN!),
      report: (message) => {
        console.log(message);
        if (process.env.GITHUB_STEP_SUMMARY) {
          appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
        }
      },
    });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Deployment failed.',
    );
    process.exitCode = 1;
  }
}
