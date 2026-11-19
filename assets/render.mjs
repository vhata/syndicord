import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = process.env.CHROMIUM_BIN || 'chromium';
const profile = resolve(root, '.cloudflare/artwork-render');
mkdirSync(profile, { recursive: true });

for (const [name, width, height, transparent] of [
  ['syndicord', 256, 256, true],
  ['social-preview', 1280, 640, false],
]) {
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      `--user-data-dir=${profile}`,
      `--screenshot=${resolve(root, `assets/${name}.png`)}`,
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      ...(transparent ? ['--default-background-color=00000000'] : []),
      pathToFileURL(resolve(root, `assets/${name}.svg`)).href,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
}
