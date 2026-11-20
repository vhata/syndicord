import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  artifact: string,
  directory: string,
  installation: Target,
) {
  const output = join(directory, '.cloudflare/output/v1');
  await mkdir(join(directory, '.cloudflare/output'), { recursive: true });
  await cp(artifact, output, { recursive: true });
  const configPath = join(output, 'workers/default/worker.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const modules = config.manifest?.modules;
  if (
    typeof config.manifest?.mainModule !== 'string' ||
    !modules ||
    typeof modules !== 'object' ||
    Array.isArray(modules) ||
    !Object.hasOwn(modules, config.manifest.mainModule)
  )
    throw new Error('Worker artifact is missing its entrypoint.');
  await Promise.all(
    Object.keys(modules).map((name) =>
      access(join(output, 'workers/default/bundle', name)),
    ),
  );
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
  options: {
    dryRun: boolean;
    webhooks?: Record<string, string>;
    sourceCheckout?: boolean;
  },
): Promise<string> {
  let artifact = join(packageRoot, 'dist/worker/v1');
  if (options.sourceCheckout) {
    artifact = join(packageRoot, '.cloudflare/output/v1');
    // A failed or partial build must never fall back to yesterday's bundle.
    await rm(artifact, { recursive: true, force: true });
    try {
      await cf(['build'], { cwd: packageRoot });
    } catch {
      throw new Error(
        'Worker build failed. Run npm run build for diagnostics; no Cloudflare changes were made.',
      );
    }
  }
  return temporary(async (cwd) => {
    // Check the selected artifact before migrations can change the database.
    await stageWorker(artifact, cwd, installation);
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
      return `Validated ${options.sourceCheckout ? 'source' : 'package'} for Worker ${installation.worker}; no Cloudflare resources changed.`;
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
        typeof active[0]?.version_id !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
          active[0].version_id,
        )
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
