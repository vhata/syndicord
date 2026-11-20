import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test(
  'npm deployment builds current source from a checkout without package artifacts',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syndicord clean source '));
    try {
      for (const path of [
        'src',
        'cli',
        'migrations',
        'package.json',
        'tsconfig.json',
        'cloudflare.config.ts',
      ])
        await cp(join(root, path), join(directory, path), { recursive: true });
      // Dependencies are immutable input; all build output stays in this fixture.
      await symlink(
        join(root, 'node_modules'),
        join(directory, 'node_modules'),
        'dir',
      );
      const env = {
        ...process.env,
        CI: 'true',
        CF_SEND_TELEMETRY: 'false',
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: join(directory, 'logs'),
        CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_API_TOKEN: 'not-a-real-token-source-test',
        SYNDICORD_DATABASE_ID: '12345678-1234-4234-8234-123456789abc',
        SYNDICORD_WORKER_NAME: 'source-test',
      };
      const deploy = () =>
        spawnSync('npm', ['run', 'deploy', '--', '--dry-run'], {
          cwd: directory,
          env,
          encoding: 'utf8',
          timeout: 20_000,
          maxBuffer: 4 * 1024 * 1024,
        });
      const bundle = join(
        directory,
        '.cloudflare/output/v1/workers/default/bundle/index.js',
      );
      await assert.rejects(readFile(bundle));
      const first = deploy();
      assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
      assert.match(first.stdout, /Validated source for Worker source-test/);
      const firstBundle = await readFile(bundle, 'utf8');
      await assert.rejects(
        readFile(join(directory, 'dist/worker/v1/config.json')),
      );
      const source = join(directory, 'src/index.ts');
      const original = await readFile(source, 'utf8');
      assert.match(original, /Not found/);
      await writeFile(
        source,
        original.replace('Not found', 'Source revision changed'),
      );
      const second = deploy();
      assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
      const secondBundle = await readFile(bundle, 'utf8');
      assert.notEqual(secondBundle, firstBundle);
      assert.match(secondBundle, /Source revision changed/);
      await writeFile(source, 'const invalid source = ;');
      const broken = deploy();
      assert.notEqual(broken.status, 0);
      await assert.rejects(readFile(bundle));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
