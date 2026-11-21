import { randomUUID } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary, type Cf, type Target } from './cloudflare.ts';
import { verifyDeployment } from './verify-deployment.ts';

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
    sourceCheckout?: boolean;
  },
  wait?: (milliseconds: number) => Promise<void>,
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
    if (!options.dryRun) await migrate(cf, installation, packageRoot);
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
    await cf(args, { cwd });
    if (options.dryRun)
      return `Validated ${options.sourceCheckout ? 'source' : 'package'} for Worker ${installation.worker}; no Cloudflare resources changed.`;
    const versionId = await verifyDeployment(
      async (args) => JSON.parse(await cf(args, { cwd })),
      installation.worker,
      message,
      wait,
    );
    return `Deployed syndicord ${version} to ${installation.worker}. Worker version: ${versionId}`;
  });
}
