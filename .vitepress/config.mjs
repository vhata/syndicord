import { readdirSync, readFileSync } from 'node:fs';
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

const base = basePath();
const origin = publicOrigin();
const mark = readFileSync(
  new URL('../assets/syndicord.svg', import.meta.url),
  'utf8',
);
const favicon = `data:image/svg+xml,${encodeURIComponent(mark)}`;
const description = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).description;
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
    const head = [
      [
        'meta',
        {
          property: 'og:title',
          content:
            pageData.title === 'syndicord'
              ? pageData.title
              : `${pageData.title} | syndicord`,
        },
      ],
      [
        'meta',
        {
          property: 'og:description',
          content: pageData.description || description,
        },
      ],
      ['meta', { property: 'og:type', content: 'website' }],
    ];
    if (origin) {
      const path = pageData.relativePath
        .replace(/\.md$/, '.html')
        .replace(/index\.html$/, '');
      head.push([
        'link',
        { rel: 'canonical', href: `${origin}${base}${path}` },
      ]);
    }
    return head;
  },
  vite: {
    publicDir: false,
    server: { host: '127.0.0.1' },
  },
});
