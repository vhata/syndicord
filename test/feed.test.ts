import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
      presentationLink: 'https://example.test/posts/one',
      description: 'Hello © world.\n\nNext 🚀.',
      publishedAt: '2026-11-18T12:00:00.000Z',
      feedTitle: 'News & Notes',
    },
    {
      id: 'link:https://example.test/feeds/posts/two',
      title: 'Untitled',
      link: 'https://example.test/feeds/posts/two',
      presentationLink: null,
      description: 'Undated content.',
      publishedAt: null,
      feedTitle: 'News & Notes',
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
      presentationLink: 'https://example.test/blog/posts/one',
      description: 'Hello & goodbye.',
      publishedAt: '2026-11-17T11:00:00.000Z',
      feedTitle: 'Example updates',
    },
    {
      id: 'id:urn:post:two',
      title: 'Two',
      link: null,
      presentationLink: null,
      description: 'Plain <text> stays readable.',
      publishedAt: null,
      feedTitle: 'Example updates',
    },
  ]);
});

test('keeps private feed bases out of RSS presentation links without changing identities', async () => {
  const privateFeed =
    'https://example.test/private-path-token/feed.xml?token=private-query-token';
  for (const [supplied, resolved, presentation] of [
    ['#post', `${privateFeed}#post`, null],
    ['./post', 'https://example.test/private-path-token/post', null],
    [
      '?page=2',
      'https://example.test/private-path-token/feed.xml?page=2',
      null,
    ],
    [
      '/public/post?lang=en#section',
      'https://example.test/public/post?lang=en#section',
      'https://example.test/public/post?lang=en#section',
    ],
    [
      'https://example.test/private-path-token/public-post',
      'https://example.test/private-path-token/public-post',
      'https://example.test/private-path-token/public-post',
    ],
    [
      'https://other.test/post',
      'https://other.test/post',
      'https://other.test/post',
    ],
  ] as const) {
    const feed = await parseFeedDocument(
      rss(`<item><link>${supplied}</link></item>`),
      privateFeed,
    );
    assert.equal(feed.entries[0]?.id, `link:${resolved}`);
    assert.equal(feed.entries[0]?.link, resolved);
    assert.equal(feed.entries[0]?.presentationLink, presentation);
  }
  const guid = 'https://example.test/private-path-token/public-post';
  const feed = await parseFeedDocument(
    rss(`<item><guid>${guid}</guid></item>`),
    privateFeed,
  );
  assert.equal(feed.entries[0]?.id, `id:${guid}`);
  assert.equal(feed.entries[0]?.presentationLink, guid);
});

test('tracks public Atom XML bases at feed, entry, and link scope', async () => {
  const privateFeed =
    'https://example.test/private%2Dpath-token/feed.xml?token=private-query-token';
  for (const scope of ['feed', 'entry', 'link']) {
    for (const [base, expected, presentation] of [
      [
        'nested/',
        'https://example.test/private%2Dpath-token/nested/post',
        null,
      ],
      [
        '/public/',
        'https://example.test/public/post',
        'https://example.test/public/post',
      ],
      [
        'https://other.test/public/',
        'https://other.test/public/post',
        'https://other.test/public/post',
      ],
    ] as const) {
      const xmlBase = (name: string) =>
        scope === name ? ` xml:base="${base}"` : '';
      const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom"${xmlBase('feed')}><a:title>Test</a:title><a:entry${xmlBase('entry')}><a:link href="post"${xmlBase('link')}/></a:entry></a:feed>`;
      const feed = await parseFeedDocument(xml, privateFeed);
      assert.equal(
        feed.entries[0]?.id,
        `link:${expected}`,
        `${scope}: ${base}`,
      );
      assert.equal(feed.entries[0]?.link, expected);
      assert.equal(feed.entries[0]?.presentationLink, presentation);
    }
  }
});

test('retains RSS paragraphs without changing legacy content fingerprints', async () => {
  const feed = await parseFeedDocument(
    rss(
      '<item><description><![CDATA[<p>one</p><p>two</p>]]></description></item>',
    ),
    url,
  );
  assert.equal(feed.entries[0]?.description, 'one\n\ntwo');
  assert.equal(
    feed.entries[0]?.id,
    'sha256:8f51e54af06de5d77219ab8b79faa97a96ca1a0c75c4a302bb9b409589f89deb',
  );
  const changedTitle = await parseFeedDocument(
    rss(
      '<item><description><![CDATA[<p>one</p><p>two</p>]]></description></item>',
    ).replace('<title>Test</title>', '<title>Renamed</title>'),
    url,
  );
  assert.equal(changedTitle.entries[0]?.id, feed.entries[0]?.id);
  assert.equal(changedTitle.entries[0]?.feedTitle, 'Renamed');
});

test('HTML cleanup preserves malformed markup outputs and stored fallback fingerprints', async () => {
  const cases: { html: string; description: string; id: string }[] = JSON.parse(
    await readFile(
      new NodeURL('./fixtures/html-cleanup.json', import.meta.url),
      'utf8',
    ),
  );
  for (const { html, description, id } of cases) {
    const feed = await parseFeedDocument(
      rss(`<item><description><![CDATA[${html}]]></description></item>`),
      url,
    );
    assert.equal(feed.entries[0]?.description, description, html);
    assert.equal(feed.entries[0]?.id, id, html);
  }
});

test('HTML cleanup stays bounded across increasing adversarial feed sizes', async (t) => {
  for (const pattern of [
    '<a',
    '<p',
    '<!--',
    '<script>',
    '<style>',
    '<script ',
  ]) {
    await t.test(JSON.stringify(pattern), () => {
      // A child timeout also catches synchronous regex stalls. The generous
      // process CPU ceiling detects rescanning, not hosted Worker headroom.
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict';
          import { parseFeedDocument } from ${JSON.stringify(new NodeURL('../src/feed.ts', import.meta.url).href)};
          const pattern = ${JSON.stringify(pattern)};
          const results = [];
          for (const size of [16_000, 64_000, 240_000]) {
            const body = pattern.repeat(Math.floor(size / pattern.length));
            const xml = '<rss version="2.0"><channel><title>Test</title><item>' +
              '<guid isPermaLink="false">stable</guid><description><![CDATA[' +
              body + ']]></description></item></channel></rss>';
            assert.ok(Buffer.byteLength(xml) < 256 * 1024);
            const before = process.cpuUsage();
            for (let i = 0; i < 4; i++) {
              const feed = await parseFeedDocument(xml, 'https://example.test/feed');
              assert.equal(feed.entries[0].id, 'id:stable');
            }
            const cpu = process.cpuUsage(before);
            results.push({ size, cpuMs: (cpu.user + cpu.system) / 1000 });
          }
          console.log(JSON.stringify(results));`,
        ],
        { encoding: 'utf8', timeout: 5_000 },
      );
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const results: { size: number; cpuMs: number }[] = JSON.parse(
        child.stdout,
      );
      assert.equal(results.length, 3);
      for (const { size, cpuMs } of results)
        assert.ok(cpuMs < 750, `${pattern}: ${size} bytes took ${cpuMs}ms CPU`);
    });
  }
});

test('keeps Atom plaintext paragraphs and existing fingerprints', async () => {
  const feed = await parseFeedDocument(
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>Updates</title>
      <entry><content type="text">First paragraph.\n\nSecond paragraph.</content></entry>
    </feed>`,
    url,
  );
  assert.equal(
    feed.entries[0]?.description,
    'First paragraph.\n\nSecond paragraph.',
  );
  assert.equal(
    feed.entries[0]?.id,
    'sha256:c0a417a3a05f9af3d35d8467a3cc4a773f6d0d84cd365a291c57731b1a863d50',
  );
});

test('bounds feed titles stored with entries and omits missing names', async () => {
  const long = await parseFeedDocument(
    rss('<item><guid>one</guid></item>').replace(
      '<title>Test</title>',
      `<title>${'🚀'.repeat(300)}</title>`,
    ),
    url,
  );
  assert.equal(long.entries[0]?.feedTitle?.length, 512);
  assert.equal(long.entries[0]?.feedTitle?.isWellFormed(), true);
  const unnamed = await parseFeedDocument(
    rss('<item><guid>one</guid></item>').replace('<title>Test</title>', ''),
    url,
  );
  assert.equal(unnamed.entries[0]?.feedTitle, undefined);
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
