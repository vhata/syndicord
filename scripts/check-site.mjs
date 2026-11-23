import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { basePath, routeFor, sources } from '../.vitepress/site.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.vitepress/dist');
const base = basePath();
const origin = 'https://site-check.invalid';
const files = readdirSync(output, { recursive: true })
  .filter((file) => file.endsWith('.html'))
  .sort();
assert.deepEqual(
  files,
  [...sources.map(routeFor), '404.html'].sort(),
  'The website must contain exactly the public documentation pages and 404 page.',
);

const documents = new Map();
function document(file) {
  if (documents.has(file)) return documents.get(file);
  const parsed = parse(readFileSync(resolve(output, file), 'utf8'));
  const ids = new Set();
  const references = [];
  function visit(node) {
    for (const { name, value } of node.attrs || []) {
      if (name === 'id' || (node.tagName === 'a' && name === 'name'))
        ids.add(value);
      if (name === 'href' || name === 'src') references.push(value);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parsed);
  const result = { ids, references };
  documents.set(file, result);
  return result;
}

const failures = [];
let checked = 0;
function checkReference(from, reference, fragment = true) {
  if (!reference || /^(?:data:|mailto:|tel:|javascript:)/i.test(reference))
    return;
  const url = new URL(reference, `${origin}${base}${from}`);
  if (url.origin !== origin) return;
  checked++;
  if (!url.pathname.startsWith(base)) {
    failures.push(`${from}: reference escapes SITE_BASE_PATH: ${reference}`);
    return;
  }
  let file = decodeURIComponent(url.pathname.slice(base.length));
  if (file.endsWith('/') || !file) file += 'index.html';
  const path = resolve(output, file);
  if (!path.startsWith(`${output}/`) || !existsSync(path)) {
    failures.push(`${from}: missing local target: ${reference}`);
    return;
  }
  if (
    fragment &&
    url.hash &&
    file.endsWith('.html') &&
    !document(file).ids.has(decodeURIComponent(url.hash.slice(1)))
  ) {
    failures.push(`${from}: missing fragment: ${reference}`);
  }
}

for (const file of files) {
  for (const reference of document(file).references)
    checkReference(file, reference);
}
for (const file of readdirSync(output, { recursive: true }).filter((file) =>
  file.endsWith('.css'),
)) {
  const css = readFileSync(resolve(output, file), 'utf8');
  for (const match of css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) {
    checkReference(file, match[1], false);
  }
}
assert.equal(
  failures.length,
  0,
  `Website links and assets failed:\n${failures.join('\n')}`,
);
console.log(
  `Website verified: ${sources.length} content pages, 404 page, ${checked} local links/assets at ${base}`,
);
