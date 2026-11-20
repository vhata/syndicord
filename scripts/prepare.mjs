import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

if (existsSync(join(root, 'src/index.ts'))) {
  const npm = process.env.npm_execpath;
  if (!npm)
    throw new Error('Run npm install or npm run prepare from this checkout.');
  execFileSync(process.execPath, [npm, 'run', 'package'], {
    cwd: root,
    stdio: 'inherit',
  });
}

if (existsSync(join(root, '.git'))) {
  execFileSync(process.execPath, [join(root, 'node_modules/husky/bin.js')], {
    cwd: root,
    stdio: 'inherit',
  });
}
