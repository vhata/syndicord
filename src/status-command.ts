import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { ConfigurationError } from './config-store.ts';
import {
  STATUS_SCHEMA_SQL,
  STATUS_SQL,
  formatStatus,
  parseStatusSnapshot,
  summarizeStatus,
} from './status.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cf = join(
  dirname(createRequire(import.meta.url).resolve('cf/package.json')),
  'bin/cf',
);
const execute = promisify(execFile);
const LOCAL_DATABASE_ID = '00000000-0000-4000-8000-000000000001';
const USAGE = `Usage: syndicord status (--remote | --local) [--json] [--interval-minutes N]

Reads configuration, health and delivery counts from the selected D1 database without sending messages.
--remote requires SYNDICORD_DATABASE_ID and authenticated cf access.
--local reads this checkout's local D1 state. The default cron interval is 1 minute.
Exit codes: 0 healthy/disabled, 1 degraded/unknown, 2 usage/query/schema error.`;

interface Query {
  sql: string;
  params?: string[];
}

interface Dependencies {
  query?: (
    queries: Query[],
    database: string,
    local: boolean,
  ) => Promise<unknown>;
}

function rows(response: unknown): Record<string, unknown>[] {
  if (!Array.isArray(response) || response.length !== 1)
    throw new Error('Invalid D1 response.');
  const query = response[0];
  if (
    query?.success !== true ||
    !Array.isArray(query.results?.columns) ||
    !Array.isArray(query.results?.rows) ||
    query.results.rows.length !== 1 ||
    !query.results.columns.every(
      (column: unknown) => typeof column === 'string',
    )
  )
    throw new Error('Invalid D1 response.');
  return query.results.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== query.results.columns.length)
      throw new Error('Invalid D1 response.');
    return Object.fromEntries(
      query.results.columns.map((column: string, index: number) => [
        column,
        row[index],
      ]),
    );
  });
}

export async function runStatus(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Dependencies = {},
) {
  const fail = (stderr: string) => ({ code: 2, stdout: '', stderr });
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!))
    return { code: 0, stdout: USAGE, stderr: '' };
  let target: 'local' | 'remote' | undefined;
  let json = false;
  let interval = 1;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === '--local' || option === '--remote') {
      if (target) return fail(USAGE);
      target = option === '--local' ? 'local' : 'remote';
    } else if (option === '--json') {
      json = true;
    } else if (option === '--interval-minutes') {
      interval = Number(args[++index]);
      if (!Number.isFinite(interval) || interval <= 0 || interval > 1440)
        return fail(USAGE);
    } else return fail(USAGE);
  }
  if (!target) return fail(USAGE);
  const database =
    env.SYNDICORD_DATABASE_ID || (target === 'local' ? LOCAL_DATABASE_ID : '');
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      database,
    )
  )
    return fail(
      'Set SYNDICORD_DATABASE_ID to the provisioned D1 database UUID.',
    );

  const query =
    dependencies.query ??
    (async (queries: Query[], id: string, local: boolean) => {
      const { stdout } = await execute(
        process.execPath,
        [
          cf,
          'd1',
          'raw',
          id,
          ...(local ? ['--local'] : []),
          '--batch',
          JSON.stringify(queries),
        ],
        {
          cwd: root,
          env: {
            ...env,
            CF_SEND_TELEMETRY: 'false',
            WRANGLER_SEND_METRICS: 'false',
            NO_COLOR: '1',
            CI: 'true',
          },
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return JSON.parse(stdout);
    });
  try {
    const schema = rows(
      await query([{ sql: STATUS_SCHEMA_SQL }], database, target === 'local'),
    )[0]!;
    if (
      schema.run_columns !== 3 ||
      schema.feed_columns !== 7 ||
      schema.config_columns !== 3
    )
      return fail(
        'Operational status schema is missing. Apply migrations through 0003_runtime_configuration.sql to the selected database, then deploy the matching Worker.',
      );
    const response = rows(
      await query([{ sql: STATUS_SQL }], database, target === 'local'),
    )[0]!;
    if (typeof response.snapshot !== 'string')
      throw new Error('Invalid D1 response.');
    const report = summarizeStatus(
      parseStatusSnapshot(JSON.parse(response.snapshot)),
      interval,
    );
    return {
      code: ['healthy', 'disabled'].includes(report.health) ? 0 : 1,
      stdout: json
        ? JSON.stringify({ target, ...report }, null, 2)
        : formatStatus(report, target),
      stderr: '',
    };
  } catch (error) {
    if (error instanceof ConfigurationError) return fail(error.message);
    return fail(
      `Could not read ${target} D1 status. Check cf authentication, the database ID, migrations, and connectivity. Remote error details are suppressed to protect secrets.`,
    );
  }
}
