import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitepress';
import { slug } from 'github-slugger';
import {
  basePath,
  groups,
  pageTitle,
  publicOrigin,
  repository,
  root,
  routeFor,
  sources,
} from './site.mjs';
import { repositoryMarkdown } from './source.mjs';
import { writeRedirects } from './redirects.mjs';

const base = basePath();
const origin = publicOrigin();
const mark = readFileSync(
  new URL('../assets/syndicord.svg', import.meta.url),
  'utf8',
);
const favicon = `data:image/svg+xml,${encodeURIComponent(mark)}`;
const description =
  'RSS and Atom updates in your Discord channels, delivered through webhooks. No bot to install. Editing access follows your Discord roles.';
const socialImage = readFileSync(
  new URL('../assets/social-preview.png', import.meta.url),
);
const imageHash = createHash('sha256')
  .update(socialImage)
  .digest('hex')
  .slice(0, 12);
const imagePath = `assets/social-preview-${imageHash}.png`;
const imageUrl = `${origin || ''}${base}${imagePath}`;
const imageAlt =
  'syndicord: Your feeds. In the conversation. Feed cards flow into a teal message bubble. Discord webhooks and roles, with no bot to install.';
const excludes = [
  ...readdirSync(root).filter(
    (name) => !['README.md', 'docs', '.vitepress'].includes(name),
  ),
  ...readdirSync(new URL('../docs/', import.meta.url))
    .filter((name) => !sources.includes(`docs/${name}`))
    .map((name) => `docs/${name}`),
].flatMap((name) => [name, `${name}/**`]);

export default defineConfig({
  title: 'syndicord',
  description,
  lang: 'en',
  base,
  srcExclude: excludes,
  rewrites: { 'README.md': 'index.md', 'docs/README.md': 'docs/index.md' },
  cleanUrls: false,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: favicon }],
    ['meta', { name: 'theme-color', content: '#102A33' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Get started', link: '/docs/USAGE.html' },
      { text: 'Documentation', link: '/docs/' },
      { text: 'GitHub', link: repository },
    ],
    sidebar: groups.map(({ text, files }) => ({
      text,
      items: files.map((file) => ({
        text: pageTitle(`docs/${file}.md`),
        link: `/${routeFor(`docs/${file}.md`).replace(/index\.html$/, '')}`,
      })),
    })),
    search: { provider: 'local' },
    outline: { level: [2, 3], label: 'On this page' },
    editLink: {
      pattern: `${repository}/edit/main/:path`,
      text: 'Edit this page on GitHub',
    },
  },
  markdown: {
    anchor: { slugify: slug },
    config(md) {
      repositoryMarkdown(md, base);
    },
  },
  transformPageData(page) {
    if (page.relativePath === 'index.md' || page.filePath === 'README.md') {
      page.frontmatter.layout = 'home';
      page.frontmatter.pageClass = 'product-home';
      page.title = 'syndicord';
      page.frontmatter.titleTemplate = false;
    }
  },
  transformHead({ pageData }) {
    const title =
      pageData.title === 'syndicord'
        ? 'syndicord — feeds to Discord, without a bot'
        : `${pageData.title} | syndicord`;
    const summary = pageData.description || description;
    const head = [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: summary }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'syndicord' }],
      ['meta', { property: 'og:image', content: imageUrl }],
      ['meta', { property: 'og:image:type', content: 'image/png' }],
      ['meta', { property: 'og:image:width', content: '1280' }],
      ['meta', { property: 'og:image:height', content: '640' }],
      ['meta', { property: 'og:image:alt', content: imageAlt }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: summary }],
      ['meta', { name: 'twitter:image', content: imageUrl }],
      ['meta', { name: 'twitter:image:alt', content: imageAlt }],
    ];
    if (origin) {
      const path = pageData.relativePath
        .replace(/\.md$/, '.html')
        .replace(/index\.html$/, '');
      const url = `${origin}${base}${path}`;
      head.push(
        ['link', { rel: 'canonical', href: url }],
        ['meta', { property: 'og:url', content: url }],
      );
    }
    return head;
  },
  buildEnd(siteConfig) {
    const target = resolve(siteConfig.outDir, imagePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, socialImage);
    writeRedirects(siteConfig.outDir);
  },
  vite: {
    publicDir: false,
    server: { host: '127.0.0.1' },
  },
});
