import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderAdminPage } from '../src/admin-page.ts';
import type { CatalogMutation, CatalogSnapshot } from '../src/catalog-types.ts';

const initial: CatalogSnapshot = {
  mode: 'scoped',
  initialized: true,
  revision: 'first',
  maxBytes: 96 * 1024,
  permissions: {
    addFeeds: true,
    channels: [
      { guildId: '100000000000000001', channelId: '100000000000000002' },
    ],
  },
  feeds: [
    { id: 'f_original', label: 'Original feed' },
    { id: 'f_replacement', label: 'Replacement feed' },
  ],
  destinations: [
    {
      id: 'd_updates',
      label: 'Updates',
      guildId: '100000000000000001',
      channelId: '100000000000000002',
    },
  ],
  subscriptions: [{ feedId: 'f_original', destinationId: 'd_updates' }],
};

class Element {
  children: Element[] = [];
  events = new Map<string, (event: { preventDefault(): void }) => void>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  required = false;
  type = '';
  className = '';
  tag: string;
  constructor(tag = 'div') {
    this.tag = tag;
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
    if (key.startsWith('data-')) this.dataset[key.slice(5)] = value;
  }
  focus() {}
  reset() {
    for (const element of this.querySelectorAll('input, select'))
      element.value = '';
  }
  addEventListener(
    name: string,
    listener: (event: { preventDefault(): void }) => void,
  ) {
    this.events.set(name, listener);
  }
  querySelectorAll(selector: string): Element[] {
    const descendants = this.children.flatMap((child) => [
      child,
      ...child.querySelectorAll('*'),
    ]);
    return selector === '*'
      ? descendants
      : descendants.filter((child) => selector.split(', ').includes(child.tag));
  }
  trigger(name = 'click') {
    assert.equal(
      this.disabled,
      false,
      `${this.textContent || this.tag} is disabled`,
    );
    const event = this.events.get(name);
    assert.ok(event, `missing ${name} listener`);
    event({ preventDefault() {} });
  }
  text(): string {
    return [
      this.textContent,
      ...this.children.map((child) => child.text()),
    ].join(' ');
  }
}

async function editor(
  snapshot: CatalogSnapshot = initial,
  mutate?: (body: CatalogMutation) => Response | Promise<Response>,
) {
  const html = renderAdminPage('nonce', {
    id: '123',
    name: 'Member',
    permissions: { mode: 'scoped' },
  });
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.hidden = /\bhidden\b/.test(match[2]!);
    element.type = match[2]!.match(/type="([^"]+)"/)?.[1] ?? '';
    elements.set(match[3]!, element);
  }
  const byId = (id: string) => {
    const element = elements.get(id);
    assert.ok(element, `missing ${id}`);
    return element;
  };
  for (const match of html.matchAll(
    /<form\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g,
  )) {
    byId(match[1]!).append(
      ...[...match[2]!.matchAll(/\bid="([^"]+)"/g)].map((child) =>
        byId(child[1]!),
      ),
    );
  }
  const script = html.match(/<script nonce="nonce">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const writes: CatalogMutation[] = [];
  let current = structuredClone(snapshot);
  const fetches: string[] = [];
  runInNewContext(script, {
    document: {
      getElementById: byId,
      createElement: (tag: string) => new Element(tag),
      querySelectorAll: () =>
        [
          ...new Set(
            [...elements.values()].flatMap((item) => [
              item,
              ...item.querySelectorAll('*'),
            ]),
          ),
        ].filter((item) => item.attributes.has('data-action')),
    },
    window: { addEventListener() {}, confirm: () => true },
    fetch: async (
      url: string,
      init: RequestInit & { credentials?: string },
    ) => {
      fetches.push(url);
      assert.equal(url, '/admin/api/catalog');
      assert.equal(init.credentials, 'same-origin');
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as CatalogMutation;
        writes.push(body);
        assert.deepEqual(Object.keys(body).sort(), ['operation', 'revision']);
        if (mutate) return mutate(body);
        current = { ...current, revision: 'next' };
      }
      return Response.json(current);
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  return {
    html,
    byId,
    writes,
    fetches,
    settle,
    setSnapshot: (next: CatalogSnapshot) => {
      current = next;
    },
  };
}

test('scoped editor creates an unrouted feed and keeps saved source URLs out of the page', async () => {
  const page = await editor({
    ...initial,
    permissions: { addFeeds: true, channels: [] },
    destinations: [],
    subscriptions: [],
  });
  assert.equal(page.byId('workspace').hidden, false);
  assert.equal(page.byId('add-webhook').hidden, true);
  assert.equal(page.byId('add-feed').disabled, false);
  page.byId('add-feed').trigger();
  page.byId('feed-label').value = 'New source';
  page.byId('feed-url').value = 'https://example.com/feed?token=private';
  page.byId('feed-form').trigger('submit');
  await page.settle();
  assert.deepEqual(page.writes, [
    {
      revision: 'first',
      operation: {
        type: 'feed.create',
        label: 'New source',
        url: 'https://example.com/feed?token=private',
      },
    },
  ]);
  assert.equal(page.byId('feed-url').value, '');
  assert.doesNotMatch(page.byId('feed-list').text(), /token|https:/);
  assert.match(
    page.byId('notice').textContent,
    /Subscribe destinations separately/,
  );
});

test('routing-only editor explicitly adopts a replacement for one destination', async () => {
  const page = await editor({
    ...initial,
    permissions: { ...initial.permissions, addFeeds: false },
  });
  assert.equal(page.byId('add-feed').hidden, true);
  assert.equal(page.byId('feed-list').querySelectorAll('button').length, 0);
  page.byId('add-subscription').trigger();
  page.byId('subscription-feed').value = 'f_replacement';
  page.byId('subscription-destination').value = 'd_updates';
  page.byId('subscription-form').trigger('submit');
  await page.settle();
  assert.deepEqual(page.writes[0], {
    revision: 'first',
    operation: {
      type: 'subscription.add',
      feedId: 'f_replacement',
      destinationId: 'd_updates',
    },
  });
  page.byId('subscription-list').querySelectorAll('button')[0]!.trigger();
  await page.settle();
  assert.deepEqual(page.writes[1], {
    revision: 'next',
    operation: {
      type: 'subscription.remove',
      feedId: 'f_original',
      destinationId: 'd_updates',
    },
  });
});

test('renames preserve identities and rotations send only the selected destination credential', async () => {
  const page = await editor();
  page.byId('feed-list').querySelectorAll('button')[0]!.trigger();
  assert.equal(page.byId('feed-url-field').hidden, true);
  page.byId('feed-label').value = 'Renamed';
  page.byId('feed-form').trigger('submit');
  await page.settle();
  assert.deepEqual(page.writes[0]!.operation, {
    type: 'feed.rename',
    id: 'f_original',
    label: 'Renamed',
  });
  page.byId('webhook-list').querySelectorAll('button')[1]!.trigger();
  assert.equal(page.byId('webhook-label-field').hidden, true);
  page.byId('webhook-url').value =
    'https://discord.com/api/webhooks/123/private';
  page.byId('webhook-form').trigger('submit');
  await page.settle();
  assert.deepEqual(page.writes[1]!.operation, {
    type: 'destination.rotate',
    id: 'd_updates',
    webhookUrl: 'https://discord.com/api/webhooks/123/private',
  });
  assert.equal(page.byId('webhook-url').value, '');
  assert.doesNotMatch(page.byId('webhook-list').text(), /private/);
});

test('initialization requires an explicit action and preserves the import on verification failure', async () => {
  const page = await editor({ ...initial, initialized: false }, () =>
    Response.json({ error: 'Webhook verification failed.' }, { status: 400 }),
  );
  assert.equal(page.writes.length, 0);
  assert.equal(page.byId('initialize-panel').hidden, false);
  assert.equal(page.byId('catalog-panels').hidden, true);
  page.byId('initialize-catalog').trigger();
  await page.settle();
  assert.deepEqual(page.writes, [
    { revision: 'first', operation: { type: 'initialize' } },
  ]);
  assert.equal(page.byId('initialize-panel').hidden, false);
  assert.match(page.byId('notice').textContent, /verification failed/);
});

test('conflicts preserve forms and block further saves until reload', async () => {
  const page = await editor(initial, () =>
    Response.json({ error: 'Conflict' }, { status: 409 }),
  );
  page.byId('add-feed').trigger();
  page.byId('feed-label').value = 'Unsent label';
  page.byId('feed-url').value = 'https://example.com/feed';
  page.byId('feed-form').trigger('submit');
  await page.settle();
  assert.equal(page.byId('feed-form').hidden, false);
  assert.equal(page.byId('feed-label').value, 'Unsent label');
  assert.equal(page.byId('save-feed').disabled, true);
  assert.equal(page.byId('reload').hidden, false);
  assert.match(page.byId('notice').textContent, /Copy changes/);
  assert.equal(page.writes.length, 1);
  page.byId('reload').trigger();
  await page.settle();
  assert.equal(page.byId('feed-form').hidden, true);
  assert.equal(page.byId('add-feed').disabled, false);
});

test('ambiguous saves are never retried and require reload', async () => {
  const page = await editor(initial, async () => {
    throw new Error('connection reset');
  });
  page.byId('add-webhook').trigger();
  page.byId('webhook-label').value = 'Updates';
  page.byId('webhook-url').value =
    'https://discord.com/api/webhooks/123/private';
  page.byId('webhook-form').trigger('submit');
  await page.settle();
  assert.equal(page.writes.length, 1);
  assert.equal(page.byId('save-webhook').disabled, true);
  assert.match(page.byId('notice').textContent, /not retried/);
  assert.equal(
    page.byId('webhook-url').value,
    'https://discord.com/api/webhooks/123/private',
  );
});

test('revoked scope exposes sign-in recovery and labels remain text', async () => {
  const page = await editor(
    {
      ...initial,
      feeds: [{ id: 'f_original', label: '<script>private</script>' }],
    },
    () => Response.json({ error: 'Role revoked.' }, { status: 403 }),
  );
  assert.equal(
    page.byId('feed-list').children[0]!.children[0]!.children[0]!.textContent,
    '<script>private</script>',
  );
  page.byId('feed-list').querySelectorAll('button')[1]!.trigger();
  await page.settle();
  assert.equal(page.byId('access-link').hidden, false);
  assert.equal(page.byId('add-feed').disabled, true);
  assert.match(page.byId('notice').textContent, /Role revoked/);
});

test('malformed nested success responses preserve the form and require reload before another write', async () => {
  for (const invalid of [
    { ...initial, feeds: [null] },
    {
      ...initial,
      destinations: [{ ...initial.destinations[0], channelId: null }],
    },
    {
      ...initial,
      subscriptions: [{ feedId: 'missing', destinationId: 'd_updates' }],
    },
    { ...initial, permissions: { addFeeds: true, channels: [null] } },
  ]) {
    const page = await editor(initial, () => Response.json(invalid));
    page.byId('add-feed').trigger();
    page.byId('feed-label').value = 'Keep this draft';
    page.byId('feed-url').value = 'https://example.com/feed?token=private';
    page.byId('feed-form').trigger('submit');
    await page.settle();
    assert.equal(page.writes.length, 1);
    assert.equal(page.byId('feed-form').hidden, false);
    assert.equal(page.byId('feed-label').value, 'Keep this draft');
    assert.equal(
      page.byId('feed-url').value,
      'https://example.com/feed?token=private',
    );
    assert.equal(page.byId('save-feed').disabled, true);
    assert.equal(page.byId('add-feed').disabled, true);
    assert.equal(page.byId('reload').hidden, false);
    assert.match(
      page.byId('notice').textContent,
      /unexpected response.*Reload/,
    );
    page.byId('reload').trigger();
    await page.settle();
    assert.equal(page.byId('feed-form').hidden, true);
    assert.equal(page.byId('add-feed').disabled, false);
  }
});
