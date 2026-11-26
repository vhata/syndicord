import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repository = 'https://github.com/vhata/syndicord';
export const groups = [
  { text: 'Start here', files: ['README', 'FEEDS'] },
  {
    text: 'Host an installation',
    files: ['SETUP', 'DISCORD_SIGN_IN', 'PERMISSIONS', 'GITHUB_DEPLOYMENT'],
  },
  {
    text: 'Operate',
    files: ['OPERATIONS', 'STATUS', 'RECOVERY', 'PROVIDER_API'],
  },
  { text: 'Reference', files: ['DELIVERY'] },
  { text: 'Contribute', files: ['DEVELOPMENT', 'QUALITY', 'WEBSITE'] },
];
export const sources = [
  'README.md',
  ...groups.flatMap(({ files }) => files.map((name) => `docs/${name}.md`)),
];

export function basePath() {
  const base = process.env.SITE_BASE_PATH || '/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) {
    throw new Error(
      'SITE_BASE_PATH must be / or a path such as /syndicord/ (with a trailing slash).',
    );
  }
  return base;
}

export function publicOrigin() {
  if (!process.env.SITE_URL) return undefined;
  const url = new URL(process.env.SITE_URL);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'SITE_URL must be an HTTP(S) origin, such as https://vhata.github.io, without a path.',
    );
  }
  return url.origin;
}

export function routeFor(source) {
  return source
    .replace(/(^|\/)README\.md$/, '$1index.md')
    .replace(/\.md$/, '.html');
}

export function pageTitle(source) {
  const title = readFileSync(resolve(root, source), 'utf8').match(
    /^# (.+)$/m,
  )?.[1];
  if (!title) throw new Error(`Missing Markdown title in ${source}`);
  return title;
}

// Keep source-relative links useful in GitHub and local Markdown readers. The
// site alone translates public documents to pages and other repo files to GitHub.
export function pageLink(source, href, base = '') {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return href;
  const [, pathname, suffix] = href.match(/^([^?#]*)(.*)$/);
  if (!pathname) return href;
  const target = posix.normalize(
    posix.join(
      pathname.startsWith('/') ? '' : posix.dirname(source),
      decodeURIComponent(pathname),
    ),
  );
  const relative = target.replace(/^\//, '');
  if (relative.startsWith('../') || !existsSync(resolve(root, relative))) {
    throw new Error(`Unresolved repository link in ${source}: ${href}`);
  }
  if (sources.includes(relative)) {
    return `${base || '/'}${routeFor(relative).replace(/index\.html$/, '')}${suffix}`;
  }
  return `${repository}/blob/main/${relative.split('/').map(encodeURIComponent).join('/')}${suffix}`;
}
