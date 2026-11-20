import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('cli/index.ts', root))],
  outfile: fileURLToPath(new URL('cli.js', dist)),
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
});
await chmod(new URL('cli.js', dist), 0o755);
await cp(new URL('.cloudflare/output/v1/', root), new URL('worker/v1/', dist), {
  recursive: true,
});
const workerPath = new URL(
  'worker/v1/workers/default/worker.config.json',
  dist,
);
const worker = JSON.parse(await readFile(workerPath, 'utf8'));
worker.name = 'syndicord';
worker.env = {
  DB: {
    type: 'd1',
    name: 'syndicord',
    id: '00000000-0000-4000-8000-000000000001',
  },
  WEBHOOKS: { type: 'secret' },
};
await writeFile(workerPath, JSON.stringify(worker));
const rootPath = new URL('worker/v1/config.json', dist);
const metadata = JSON.parse(await readFile(rootPath, 'utf8'));
delete metadata.settings;
await writeFile(rootPath, JSON.stringify(metadata));
