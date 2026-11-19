import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL as NodeURL } from 'node:url';
import { parseFeedDocument } from '../src/feed.ts';

const url = 'https://example.test/feeds/news.xml';
const rss = (items: string) =>
  `<rss version="2.0"><channel><title>Test</title>${items}</channel></rss>`;

test('normalizes RSS IDs, relative links, HTML, entities, and undated content', async () => {
  const feed = await parseFeedDocument(
    await readFile(new NodeURL('./fixtures/rss.xml', import.meta.url), 'utf8'),
    url,
  );
  assert.equal(feed.title, 'News & Notes');
  assert.deepEqual(feed.entries, [
    {
      id: 'id:post-1',
      title: 'First & best',
      link: 'https://example.test/posts/one',
      description: 'Hello © world. Next 🚀.',
      publishedAt: '2026-11-18T12:00:00.000Z',
    },
    {
      id: 'link:https://example.test/feeds/posts/two',
      title: 'Untitled',
      link: 'https://example.test/feeds/posts/two',
      description: 'Undated content.',
      publishedAt: null,
    },
  ]);
});

test('normalizes Atom text constructs, xml:base, alternate links, and dates', async () => {
  const feed = await parseFeedDocument(
    await readFile(new NodeURL('./fixtures/atom.xml', import.meta.url), 'utf8'),
    url,
  );
  assert.equal(feed.title, 'Example updates');
  assert.deepEqual(feed.entries, [
    {
      id: 'id:urn:post:one',
      title: 'First & best',
      link: 'https://example.test/blog/posts/one',
      description: 'Hello & goodbye.',
      publishedAt: '2026-11-17T11:00:00.000Z',
    },
    {
      id: 'id:urn:post:two',
      title: 'Two',
      link: null,
      description: 'Plain <text> stays readable.',
      publishedAt: null,
    },
  ]);
});

test('preserves literal HTML entity names in Atom plain text constructs', async () => {
  const feed = await parseFeedDocument(
    `<feed xmlns="http://www.w3.org/2005/Atom">
    <title type="text">Feed &amp;copy;</title>
    <entry><id>one</id><title type="text">Literal &amp;copy; and &amp;lt;tag&amp;gt;</title>
    <summary type="text">An &amp;amp; example.</summary></entry>
  </feed>`,
    url,
  );
  assert.equal(feed.title, 'Feed &copy;');
  assert.equal(feed.entries[0]?.title, 'Literal &copy; and &lt;tag&gt;');
  assert.equal(feed.entries[0]?.description, 'An &amp; example.');
});

test('preserves literal entity names in RSS titles', async () => {
  const feed = await parseFeedDocument(
    rss(
      '<item><title>Literal &amp;copy; and &amp;lt;tag&amp;gt;</title></item>',
    ),
    url,
  );
  assert.equal(feed.entries[0]?.title, 'Literal &copy; and &lt;tag&gt;');
});

test('resolves link-level XML bases with namespace aliases and inherited bases', async () => {
  const feed = await parseFeedDocument(
    `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://example.test/base/">
    <a:title>Example</a:title>
    <b:entry xmlns:b="http://www.w3.org/2005/Atom" xml:base="entries/">
      <b:id>one</b:id><b:title>One</b:title>
      <wrong:link xmlns:wrong="https://other.test/namespace" href="https://wrong.test/"/>
      <c:link xmlns:c="http://www.w3.org/2005/Atom" href="one" xml:base="https://other.example/posts/"/>
    </b:entry>
    <a:entry><a:id>two</a:id><a:title>Two</a:title><a:link xml:base="relative/" href="two?a=1&amp;b=2"/></a:entry>
  </a:feed>`,
    url,
  );
  assert.equal(feed.entries[0]?.link, 'https://other.example/posts/one');
  assert.equal(
    feed.entries[1]?.link,
    'https://example.test/base/relative/two?a=1&b=2',
  );
});

test('declaration examples inside CDATA and comments remain ordinary feed content', async () => {
  const feed = await parseFeedDocument(
    rss(
      '<!-- <!DOCTYPE example> --><item><description><![CDATA[<!DOCTYPE html><p>An example.</p>]]></description></item>',
    ),
    url,
  );
  assert.equal(feed.entries.length, 1);
  assert.match(feed.entries[0]!.description, /An example\./);
});

test('rejects unsafe XML bases rather than resolving links against the wrong parent', async () => {
  await assert.rejects(
    parseFeedDocument(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><entry><id>one</id><link xml:base="https://user:pass@other.test/" href="one"/></entry></feed>',
      url,
    ),
    /base URL/,
  );
});

test('stable IDs win over content changes and duplicate items', async () => {
  const first = await parseFeedDocument(
    rss(
      '<item><guid isPermaLink="false">same</guid><title>Old</title></item><item><guid isPermaLink="false">same</guid><title>New</title></item>',
    ),
    url,
  );
  const edited = await parseFeedDocument(
    rss(
      '<item><guid isPermaLink="false">same</guid><title>Edited</title></item>',
    ),
    url,
  );
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0]?.title, 'Old');
  assert.equal(first.entries[0]?.id, edited.entries[0]?.id);
});

test('content fingerprints are deterministic and distinguish text beyond display limits', async () => {
  const prefix = 'x'.repeat(4_100);
  const feed = await parseFeedDocument(
    rss(
      `<item><description>${prefix}a</description></item><item><description>${prefix}b</description></item>`,
    ),
    url,
  );
  const again = await parseFeedDocument(
    rss(`<item><description>${prefix}a</description></item>`),
    url,
  );
  assert.equal(feed.entries.length, 2);
  assert.match(feed.entries[0]!.id, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(feed.entries[0]?.id, feed.entries[1]?.id);
  assert.equal(feed.entries[0]?.id, again.entries[0]?.id);
  assert.equal(feed.entries[0]?.description.length, 4_000);
});

test('rejects unsafe links and only uses genuine HTTP permalink GUIDs', async () => {
  const feed = await parseFeedDocument(
    rss(
      '<item><guid isPermaLink="false">safe-id</guid><link>javascript:alert(1)</link></item><item><guid>https://example.test/post</guid></item><item><guid isPermaLink="false">private</guid><link>https://user:secret@example.test/post</link></item>',
    ),
    url,
  );
  assert.equal(feed.entries[0]?.link, null);
  assert.equal(feed.entries[1]?.link, 'https://example.test/post');
  assert.equal(feed.entries[2]?.link, null);
});

test('retains usable entries while ignoring entirely empty items', async () => {
  const feed = await parseFeedDocument(
    rss('<item/><item><title>Readable</title></item>'),
    url,
  );
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0]?.title, 'Readable');
  assert.equal((await parseFeedDocument(rss(''), url)).entries.length, 0);
});

test('rejects malformed, unsupported, and declaration-bearing documents', async () => {
  for (const input of [
    '<rss><channel><title>Broken</channel></rss>',
    '<html><body>not a feed</body></html>',
    '{"version":"https://jsonfeed.org/version/1.1","title":"No","items":[]}',
    '<!DOCTYPE rss [<!ENTITY x "value">]>' +
      rss('<item><title>&x;</title></item>'),
    '<!DOCTYPE rss SYSTEM "https://example.test/dtd">' + rss(''),
  ]) {
    await assert.rejects(parseFeedDocument(input, url));
  }
});

test('rejects excessive entries and oversized stable IDs instead of truncating identity', async () => {
  await assert.rejects(
    parseFeedDocument(
      rss('<item><title>Entry</title></item>'.repeat(201)),
      url,
    ),
    /too many/,
  );
  await assert.rejects(
    parseFeedDocument(
      rss(`<item><guid>${'a'.repeat(2_049)}</guid></item>`),
      url,
    ),
    /ID exceeds/,
  );
  await assert.rejects(
    parseFeedDocument(rss(''), 'file:///tmp/feed.xml'),
    /HTTP/,
  );
});
