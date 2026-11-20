import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../src/admin.ts';
import {
  configurationKey,
  readAdminConfiguration,
  readRelayConfiguration,
  saveAdminConfiguration,
} from '../src/admin-store.ts';
import { WRITE_CONFIGURATION_SQL } from '../src/config-store.ts';
import { createTestDatabase } from './helpers/d1.ts';

const origin = 'https://syndicord.example';
const password = 'test-password:with-colon';
const key = Buffer.alloc(32, 7).toString('base64');
const secret = 'https://discord.com/api/webhooks/123/private-webhook-token';
const other = 'https://discord.com/api/webhooks/456/other-private-token';
const feeds = [
  {
    url: 'https://example.com/feed?token=private-feed-token',
    destinations: ['updates'],
  },
];
const credentials = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
function request(path = '/admin/api/config', init: RequestInit = {}) {
  return new Request(origin + path, {
    ...init,
    headers: { Authorization: credentials, ...init.headers },
  });
}
function put(body: unknown, extra: Record<string, string> = {}) {
  return request('/admin/api/config', {
    method: 'PUT',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}
async function fixture() {
  const database = await createTestDatabase();
  return {
    ...database,
    env: {
      DB: database.db,
      ADMIN_PASSWORD: password,
      CONFIG_ENCRYPTION_KEY: key,
      WEBHOOKS: JSON.stringify({ updates: secret }),
    },
  };
}

test('administration is disabled without a password and every page and API requires valid credentials', async () => {
  const { env, dispose } = await fixture();
  try {
    for (const path of ['/', '/admin', '/admin/', '/admin/api/config']) {
      assert.equal(
        (await handleAdmin(request(path), { ...env, ADMIN_PASSWORD: '' }))!
          .status,
        404,
      );
      for (const authorization of [
        '',
        'Bearer secret',
        'Basic $$$',
        `Basic ${Buffer.from('admin:wrong').toString('base64')}`,
        `Basic ${Buffer.from(`other:${password}`).toString('base64')}`,
      ]) {
        const response = (await handleAdmin(
          request(path, { headers: { Authorization: authorization } }),
          env,
        ))!;
        assert.equal(response.status, 401);
        assert.match(response.headers.get('www-authenticate')!, /^Basic /);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /private-|test-password/);
      }
    }
    const redirect = (await handleAdmin(request('/'), env))!;
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/admin');
    const page = (await handleAdmin(request('/admin'), env))!;
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get('content-security-policy')!,
      /frame-ancestors 'none'/,
    );
    assert.match(await page.text(), /syndicord/i);
    assert.equal(await handleAdmin(request('/unknown'), env), null);
    assert.equal(
      (await handleAdmin(request('/admin', { method: 'POST' }), env))!.status,
      405,
    );
    assert.equal(
      (await handleAdmin(request(), {
        ...env,
        CONFIG_ENCRYPTION_KEY: 'invalid',
      }))!.status,
      503,
    );
  } finally {
    await dispose();
  }
});

test('the first web save encrypts existing and new destinations atomically with feeds and leaves the ledger intact', async () => {
  const { env, db, dispose } = await fixture();
  try {
    const initial = (await (await handleAdmin(request(), env))!.json()) as {
      revision: string;
      feeds: unknown;
      destinations: string[];
    };
    assert.deepEqual(initial.feeds, []);
    assert.deepEqual(initial.destinations, ['updates']);
    assert.doesNotMatch(
      JSON.stringify(initial),
      /private-webhook-token|discord.com/,
    );
    await db
      .prepare(
        "INSERT INTO relay_routes(feed_url, destination, baseline_id, initialized_at_ms) VALUES (?, 'updates', 'existing', 1)",
      )
      .bind(feeds[0]!.url)
      .run();
    const response = (await handleAdmin(
      put({ revision: initial.revision, feeds, webhooks: { other } }),
      env,
    ))!;
    assert.equal(response.status, 200, await response.clone().text());
    const saved = (await response.json()) as {
      revision: string;
      destinations: string[];
    };
    assert.notEqual(saved.revision, initial.revision);
    assert.deepEqual(saved.destinations, ['other', 'updates']);
    assert.doesNotMatch(
      JSON.stringify(saved),
      /private-webhook-token|other-private-token|discord.com/,
    );
    const row = await db
      .prepare('SELECT * FROM relay_configuration')
      .first<{ feeds: string; encrypted_webhooks: string }>();
    assert.deepEqual(JSON.parse(row!.feeds), feeds);
    assert.match(row!.encrypted_webhooks, /^v1\./);
    assert.doesNotMatch(
      row!.encrypted_webhooks,
      /private-webhook-token|other-private-token|discord.com/,
    );
    assert.equal(
      (await db
        .prepare('SELECT baseline_id FROM relay_routes')
        .first<{ baseline_id: string }>())!.baseline_id,
      'existing',
    );
    assert.equal((await readRelayConfiguration(env)).webhooks.updates, secret);
    const changedEnvironment = {
      ...env,
      WEBHOOKS: JSON.stringify({ updates: other }),
      ADMIN_PASSWORD: 'rotated-password',
    };
    assert.equal(
      (await readRelayConfiguration(changedEnvironment)).webhooks.updates,
      secret,
    );
    const reopened = await readAdminConfiguration(
      changedEnvironment,
      await configurationKey(key),
    );
    assert.equal(reopened.revision, saved.revision);
    assert.deepEqual(reopened.destinations, ['other', 'updates']);
    await assert.rejects(
      readRelayConfiguration({
        ...env,
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
      }),
      /Cannot read saved webhooks/,
    );
    await assert.rejects(
      readRelayConfiguration({ ...env, CONFIG_ENCRYPTION_KEY: '' }),
      /Configure CONFIG_ENCRYPTION_KEY/,
    );
  } finally {
    await dispose();
  }
});

test('webhook rotation, destination removal, and route edits preserve unedited secrets and validate every reference', async () => {
  const { env, db, dispose } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    const cryptoKey = await configurationKey(key);
    let current = await readAdminConfiguration(env, cryptoKey);
    current = await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds,
      webhooks: { unused: other },
    });
    for (const invalid of [
      { feeds, webhooks: { updates: null } },
      { feeds, webhooks: { duplicate: secret } },
      { feeds, webhooks: { unused: 'https://example.com/private-token' } },
      {
        feeds: [{ url: 'https://example.com', destinations: ['missing'] }],
        webhooks: {},
      },
      {
        feeds: [
          { url: 'https://private.example/?secret=hidden', destinations: [] },
        ],
        webhooks: {},
      },
      { feeds, webhooks: { updates: false } },
      { feeds, webhooks: { 'invalid name': null } },
    ]) {
      const response = (await handleAdmin(
        put({ revision: current.revision, ...invalid }),
        env,
      ))!;
      assert.equal(response.status, 400);
      assert.doesNotMatch(
        await response.text(),
        /private-token|private-webhook-token|secret=hidden/,
      );
      assert.equal(
        (await readAdminConfiguration(env, cryptoKey)).revision,
        current.revision,
      );
    }
    const rotated = 'https://discord.com/api/webhooks/789/rotated-token';
    current = await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds,
      webhooks: { updates: rotated },
    });
    assert.equal((await readRelayConfiguration(env)).webhooks.updates, rotated);
    assert.deepEqual(current.destinations, ['unused', 'updates']);
    current = await saveAdminConfiguration(env, cryptoKey, {
      revision: current.revision,
      feeds: [],
      webhooks: { updates: null },
    });
    assert.deepEqual(current.feeds, []);
    assert.deepEqual(current.destinations, ['unused']);
    assert.deepEqual((await readRelayConfiguration(env)).feeds, []);
  } finally {
    await dispose();
  }
});

test('stale tabs, CLI feed edits, and concurrent first writes cannot overwrite newer configuration', async () => {
  const { env, db, dispose } = await fixture();
  try {
    const cryptoKey = await configurationKey(key);
    const initial = await readAdminConfiguration(env, cryptoKey);
    const results = await Promise.all(
      [other, 'https://discord.com/api/webhooks/789/third-token'].map((value) =>
        handleAdmin(
          put({
            revision: initial.revision,
            feeds,
            webhooks: { added: value },
          }),
          env,
        ),
      ),
    );
    assert.deepEqual(
      results.map((response) => response!.status).sort(),
      [200, 409],
    );
    const beforeCli = await readAdminConfiguration(env, cryptoKey);
    await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
    assert.equal(
      (await handleAdmin(
        put({ revision: beforeCli.revision, feeds, webhooks: {} }),
        env,
      ))!.status,
      409,
    );
    assert.deepEqual((await readAdminConfiguration(env, cryptoKey)).feeds, []);
    const current = await readAdminConfiguration(env, cryptoKey);
    const concurrent = await Promise.all(
      ['first', 'second'].map((name) =>
        handleAdmin(
          put({
            revision: current.revision,
            feeds: [
              {
                url: `https://${name}.example/feed`,
                destinations: ['updates'],
              },
            ],
            webhooks: {},
          }),
          env,
        ),
      ),
    );
    assert.deepEqual(
      concurrent.map((response) => response!.status).sort(),
      [200, 409],
    );
  } finally {
    await dispose();
  }
});

test('a Worker secret change invalidates a pre-adoption browser revision', async () => {
  const { env, db, dispose } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    const cryptoKey = await configurationKey(key);
    const initial = await readAdminConfiguration(env, cryptoKey);
    const response = (await handleAdmin(
      put({ revision: initial.revision, feeds, webhooks: {} }),
      { ...env, WEBHOOKS: JSON.stringify({ updates: other }) },
    ))!;
    assert.equal(response.status, 409);
    assert.equal(
      (await db
        .prepare('SELECT encrypted_webhooks FROM relay_configuration')
        .first<{ encrypted_webhooks: string | null }>())!.encrypted_webhooks,
      null,
    );
  } finally {
    await dispose();
  }
});

test('mutations require a same-origin JSON request and enforce the body limit before parsing', async () => {
  const { env, dispose } = await fixture();
  try {
    const current = await readAdminConfiguration(
      env,
      await configurationKey(key),
    );
    const body = { revision: current.revision, feeds, webhooks: {} };
    for (const origin of ['https://evil.example', 'null', '']) {
      assert.equal(
        (await handleAdmin(put(body, { Origin: origin }), env))!.status,
        403,
      );
    }
    assert.equal(
      (await handleAdmin(put(body, { 'Content-Type': 'text/plain' }), env))!
        .status,
      415,
    );
    assert.equal(
      (await handleAdmin(
        request('/admin/api/config', { method: 'DELETE' }),
        env,
      ))!.status,
      405,
    );
    assert.equal(
      (await handleAdmin(
        put(body, { 'Content-Length': String(128 * 1024 + 1) }),
        env,
      ))!.status,
      413,
    );
    assert.equal(
      (await handleAdmin(
        put({ ...body, padding: 'x'.repeat(128 * 1024) }),
        env,
      ))!.status,
      413,
    );
    const malformed = request('/admin/api/config', {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{secret-token',
    });
    const result = (await handleAdmin(malformed, env))!;
    assert.equal(result.status, 400);
    assert.doesNotMatch(await result.text(), /secret-token/);
    assert.equal(
      (await handleAdmin(put({ ...body, extra: 'ignored?' }), env))!.status,
      400,
    );
  } finally {
    await dispose();
  }
});

test('corrupt encrypted configuration fails closed without reverting to the Worker secret', async () => {
  const { env, db, dispose } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    await db
      .prepare('UPDATE relay_configuration SET encrypted_webhooks = ?')
      .bind('private-corrupt-ciphertext')
      .run();
    const response = (await handleAdmin(request(), env))!;
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      await response.text(),
      /private-corrupt-ciphertext|private-webhook-token/,
    );
    await assert.rejects(
      readRelayConfiguration(env),
      /Cannot read saved webhooks/,
    );
  } finally {
    await dispose();
  }
});

test('a CLI write during a web save is detected by the database compare-and-swap', async () => {
  const { env, db, dispose } = await fixture();
  try {
    await db.prepare(WRITE_CONFIGURATION_SQL).bind(JSON.stringify(feeds)).run();
    const initial = await readAdminConfiguration(
      env,
      await configurationKey(key),
    );
    let injected = false;
    const racingDb = {
      prepare(sql: string) {
        return new Proxy(db.prepare(sql), {
          get(statement, property) {
            if (property === 'first')
              return async () => {
                const before = await statement.first();
                if (!injected) {
                  injected = true;
                  await db.prepare(WRITE_CONFIGURATION_SQL).bind('[]').run();
                }
                return before;
              };
            const value = Reflect.get(statement, property);
            return typeof value === 'function' ? value.bind(statement) : value;
          },
        });
      },
    } as D1Database;
    const response = (await handleAdmin(
      put({ revision: initial.revision, feeds, webhooks: { other } }),
      { ...env, DB: racingDb },
    ))!;
    assert.ok(injected);
    assert.equal(response.status, 409);
    const row = await db
      .prepare('SELECT feeds, encrypted_webhooks FROM relay_configuration')
      .first<{ feeds: string; encrypted_webhooks: string | null }>();
    assert.equal(row!.feeds, '[]');
    assert.equal(
      row!.encrypted_webhooks,
      null,
      'the conflicting save writes neither feeds nor webhooks',
    );
  } finally {
    await dispose();
  }
});
