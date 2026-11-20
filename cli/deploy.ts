import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIGURATION_SQL, parseStoredFeeds } from '../src/config-store.ts';
import { loadConfig } from '../src/config.ts';
import { query, rows, temporary, type Cf, type Target } from './cloudflare.ts';

export async function storedFeeds(cf: Cf, installation: Target, local = false) {
  const result = rows(
    await query(cf, installation.database, [{ sql: CONFIGURATION_SQL }], local),
  );
  if (result.length !== 1)
    throw new Error(
      'Feed configuration is missing. Run syndicord feeds set --file FILE before deploying.',
    );
  return parseStoredFeeds(result[0]?.feeds);
}

export async function migrate(
  cf: Cf,
  installation: Target,
  packageRoot: string,
) {
  return temporary(async (cwd) => {
    const directory = join(packageRoot, 'migrations');
    await cf(
      ['d1', 'migrations', 'apply', installation.database, '--dir', directory],
      { cwd },
    );
    let remaining: unknown;
    try {
      remaining = JSON.parse(
        await cf(
          [
            'd1',
            'migrations',
            'list',
            installation.database,
            '--dir',
            directory,
          ],
          { cwd },
        ),
      );
    } catch {
      throw new Error(
        'Could not verify applied migrations. Inspect the database before retrying.',
      );
    }
    if (!Array.isArray(remaining) || remaining.length !== 0)
      throw new Error(
        'Database migrations are incomplete; deployment stopped.',
      );
  });
}

export async function stageWorker(
  packageRoot: string,
  directory: string,
  installation: Target,
) {
  const output = join(directory, '.cloudflare/output/v1');
  await mkdir(join(directory, '.cloudflare/output'), { recursive: true });
  await cp(join(packageRoot, 'dist/worker/v1'), output, { recursive: true });
  const configPath = join(output, 'workers/default/worker.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.name = installation.worker;
  config.env.DB = {
    type: 'd1',
    name: installation.worker,
    id: installation.database,
  };
  await writeFile(configPath, JSON.stringify(config));
  // Never inherit an account selection from the machine that built the package.
  const rootPath = join(output, 'config.json');
  const root = JSON.parse(await readFile(rootPath, 'utf8'));
  root.settings = { accountId: installation.account };
  await writeFile(rootPath, JSON.stringify(root));
}

export async function deploy(
  cf: Cf,
  installation: Target,
  packageRoot: string,
  options: { dryRun: boolean; webhooks?: Record<string, string> },
): Promise<string> {
  if (!options.dryRun) {
    await migrate(cf, installation, packageRoot);
    const feeds = await storedFeeds(cf, installation);
    if (options.webhooks) loadConfig(feeds, JSON.stringify(options.webhooks));
    else {
      const secretNames = await temporary(async (cwd) => {
        try {
          return JSON.parse(
            await cf(
              ['workers', 'secrets', 'list', '--worker', installation.worker],
              { cwd },
            ),
          );
        } catch {
          throw new Error(
            'Could not inspect the Worker secrets. For the first deployment, provide --webhooks-file FILE.',
          );
        }
      });
      if (
        !Array.isArray(secretNames) ||
        !secretNames.some((secret) => secret?.name === 'WEBHOOKS')
      )
        throw new Error(
          'WEBHOOKS is missing. For the first deployment, provide --webhooks-file FILE.',
        );
    }
  }
  return temporary(async (cwd) => {
    await stageWorker(packageRoot, cwd, installation);
    const version = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    ).version;
    const message = `syndicord ${version} deployment ${randomUUID()}`;
    const args = [
      'deploy',
      '--prebuilt',
      '--no-provision',
      '--message',
      message,
    ];
    if (options.dryRun) args.push('--dry-run');
    if (options.webhooks) {
      const file = join(cwd, 'secrets.json');
      await writeFile(
        file,
        JSON.stringify({ WEBHOOKS: JSON.stringify(options.webhooks) }),
        { mode: 0o600 },
      );
      args.push('--secrets-file', file);
    }
    await cf(args, { cwd });
    if (options.dryRun)
      return `Validated package for Worker ${installation.worker}; no Cloudflare resources changed.`;
    let versionId: string;
    try {
      const history = JSON.parse(
        await cf(
          ['workers', 'deployments', 'list', '--worker', installation.worker],
          { cwd },
        ),
      );
      const active = history.deployments?.[0]?.versions;
      if (
        !Array.isArray(active) ||
        active.length !== 1 ||
        active[0]?.percentage !== 100 ||
        typeof active[0]?.version_id !== 'string'
      )
        throw new Error();
      versionId = active[0].version_id;
      const serving = JSON.parse(
        await cf(
          [
            'workers',
            'versions',
            'get',
            versionId,
            '--worker',
            installation.worker,
          ],
          { cwd },
        ),
      );
      if (serving.annotations?.['workers/message'] !== message)
        throw new Error();
    } catch {
      throw new Error(
        'Upload finished but the active Worker version could not be verified. Inspect Cloudflare before retrying.',
      );
    }
    return `Deployed syndicord ${version} to ${installation.worker}. Worker version: ${versionId}`;
  });
}
