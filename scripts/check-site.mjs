import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import {
  basePath,
  publicOrigin,
  routeFor,
  sources,
} from '../.vitepress/site.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.vitepress/dist');
const base = basePath();
const hostedOrigin = publicOrigin();
const origin = hostedOrigin || 'https://site-check.invalid';
const socialImage = readFileSync(resolve(root, 'assets/social-preview.png'));
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
  const metadata = new Map();
  let canonical;
  function visit(node) {
    const attributes = Object.fromEntries(
      (node.attrs || []).map(({ name, value }) => [name, value]),
    );
    if (node.tagName === 'meta') {
      const key = attributes.property || attributes.name;
      if (key?.startsWith('og:') || key?.startsWith('twitter:')) {
        assert(!metadata.has(key), `${file}: duplicate ${key}`);
        metadata.set(key, attributes.content);
      }
    }
    if (node.tagName === 'link' && attributes.rel === 'canonical') {
      assert.equal(canonical, undefined, `${file}: duplicate canonical URL`);
      canonical = attributes.href;
    }
    for (const { name, value } of node.attrs || []) {
      if (name === 'id' || (node.tagName === 'a' && name === 'name'))
        ids.add(value);
      if (name === 'href' || name === 'src') references.push(value);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parsed);
  const result = { ids, references, metadata, canonical };
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
  const { references, metadata, canonical } = document(file);
  for (const reference of references) checkReference(file, reference);
  const meta = (key) => {
    const value = metadata.get(key);
    assert(value?.trim(), `${file}: missing ${key}`);
    return value;
  };
  assert.equal(meta('og:type'), 'website');
  assert.equal(meta('og:site_name'), 'syndicord');
  assert.equal(meta('twitter:card'), 'summary_large_image');
  for (const key of ['title', 'description', 'image', 'image:alt']) {
    assert.equal(meta(`og:${key}`), meta(`twitter:${key}`));
  }
  assert.equal(meta('og:image:type'), 'image/png');
  const image = meta('og:image');
  assert.match(image, hostedOrigin ? /^https?:\/\// : /^\/(?!\/)/);
  const imageUrl = new URL(image, `${origin}${base}${file}`);
  assert.equal(
    imageUrl.origin,
    origin,
    `${file}: image must use the site origin`,
  );
  assert(
    imageUrl.pathname.startsWith(base),
    `${file}: image escapes site base`,
  );
  checkReference(file, image, false);
  const png = readFileSync(
    resolve(output, decodeURIComponent(imageUrl.pathname.slice(base.length))),
  );
  assert.deepEqual(
    png,
    socialImage,
    `${file}: published artwork differs from source`,
  );
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 640);
  assert.equal(meta('og:image:width'), String(png.readUInt32BE(16)));
  assert.equal(meta('og:image:height'), String(png.readUInt32BE(20)));
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 12);
  assert(imageUrl.pathname.endsWith(`/social-preview-${hash}.png`));
  if (hostedOrigin) {
    const expected = `${origin}${base}${file.replace(/index\.html$/, '')}`;
    assert.equal(meta('og:url'), expected);
    assert.equal(canonical, expected);
  } else {
    assert.equal(metadata.has('og:url'), false);
    assert.equal(canonical, undefined);
  }
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
  `Website verified: ${sources.length} content pages, 404 page, social previews, ${checked} local links/assets at ${base}`,
);
