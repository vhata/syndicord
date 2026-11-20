import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

export interface Target {
  account: string;
  database: string;
  worker: string;
}

export type Environment = Record<string, string | undefined>;
export interface Query {
  sql: string;
  params?: string[];
}
export type Cf = (
  args: string[],
  options: { cwd: string; interactive?: boolean },
) => Promise<string>;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LOCAL_DATABASE = '00000000-0000-4000-8000-000000000001';

export function target(env: Environment, local = false): Target {
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const database =
    env.SYNDICORD_DATABASE_ID?.trim() || (local ? LOCAL_DATABASE : '');
  const worker = env.SYNDICORD_WORKER_NAME?.trim() || 'syndicord';
  if (!local && !/^[a-f0-9]{32}$/i.test(account))
    throw new Error(
      'Set CLOUDFLARE_ACCOUNT_ID to the installation account ID.',
    );
  if (!UUID.test(database) || (!local && database === LOCAL_DATABASE))
    throw new Error('Set SYNDICORD_DATABASE_ID to the installation D1 UUID.');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker))
    throw new Error(
      'SYNDICORD_WORKER_NAME must be 1–63 lowercase letters, digits, or hyphens, starting with a letter or digit.',
    );
  return { account, database, worker };
}

export async function temporary<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'syndicord-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function cloudflare(env: Environment): Cf {
  const cf = join(
    dirname(createRequire(import.meta.url).resolve('cf/package.json')),
    'bin/cf',
  );
  return async (args, options) => {
    const environment: Environment = {
      ...env,
      CF_SEND_TELEMETRY: 'false',
      WRANGLER_SEND_METRICS: 'false',
      ...(options.interactive ? {} : { CI: 'true', NO_COLOR: '1' }),
    };
    if (!options.interactive) {
      // An enclosing Cloudflare CI job must not silently change our target.
      delete environment.CLOUDFLARE_CI_OVERRIDE_WORKER_NAME;
      delete environment.CLOUDFLARE_CI_MATCH_WORKER_TAG;
      delete environment.WRANGLER_CI_MATCH_TAG;
      environment.CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID?.trim();
    }
    if (options.interactive) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cf, ...args], {
          cwd: options.cwd,
          env: environment,
          stdio: 'inherit',
        });
        child.once('error', () =>
          reject(new Error('Could not start the Cloudflare CLI.')),
        );
        child.once('exit', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('Cloudflare CLI command failed.')),
        );
      });
      return '';
    }
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [cf, ...args],
        {
          cwd: options.cwd,
          env: environment,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      return result.stdout;
    } catch {
      // cf diagnostics may echo API response bodies, including submitted data.
      throw new Error(
        'Cloudflare command failed. Check authentication, target IDs, permissions, and connectivity. Inspect the installation before retrying a write.',
      );
    }
  };
}

export async function query(
  cf: Cf,
  database: string,
  queries: Query[],
  local = false,
): Promise<unknown> {
  return temporary(async (cwd) => {
    const path = join(cwd, 'query.json');
    await writeFile(path, JSON.stringify(queries), { mode: 0o600 });
    const output = await cf(
      [
        'd1',
        'raw',
        database,
        '--batch',
        `@${path}`,
        ...(local
          ? [
              '--local',
              '--persist-to',
              join(process.cwd(), '.cloudflare/state'),
            ]
          : []),
      ],
      {
        cwd: local ? process.cwd() : cwd,
      },
    );
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('Cloudflare returned an invalid D1 response.');
    }
  });
}

export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Cloudflare returned an invalid D1 response.');
  const result = value[0];
  if (
    result?.success !== true ||
    !Array.isArray(result.results?.columns) ||
    !Array.isArray(result.results?.rows)
  )
    throw new Error('Cloudflare returned an invalid D1 response.');
  const columns: unknown[] = result.results.columns;
  if (!columns.every((column) => typeof column === 'string'))
    throw new Error('Cloudflare returned an invalid D1 response.');
  return result.results.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== columns.length)
      throw new Error('Cloudflare returned an invalid D1 response.');
    return Object.fromEntries(
      columns.map((column, index) => [column, row[index]]),
    );
  });
}
