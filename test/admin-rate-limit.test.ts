import assert from 'node:assert/strict';
import test from 'node:test';
import { handleAdmin } from '../src/admin.ts';
import {
  configurationKey,
  readAdminConfiguration,
  readRelayConfiguration,
} from '../src/admin-store.ts';
import { readCatalog, saveCatalog } from '../src/catalog-store.ts';
import type { AdminPermissions } from '../src/admin-policy.ts';
import { createTestDatabase } from './helpers/d1.ts';
import {
  authEnv,
  browserLogin,
  discordFixture,
  TEST_GUILD_ID,
  TEST_ROLE_ID,
} from './helpers/auth.ts';

const origin = 'https://syndicord.example';
const channel = '200000000000000001';
const webhookId = '300000000000000001';
const webhook = `https://discord.com/api/webhooks/${webhookId}/private-token`;
const permissions: AdminPermissions = {
  mode: 'scoped',
  addFeeds: true,
  channels: [{ guildId: TEST_GUILD_ID, channelId: channel }],
};

// These budgets reproduce a small provider window; they are not assertions
// about Discord's quotas, which vary and must come from its responses.
for (const mode of ['legacy', 'scoped'] as const) {
  test(`${mode} login, editor load, webhook save and feed save share one cached membership check`, async () => {
    const budget = 1;
    const { db, dispose } = await createTestDatabase();
    const env = authEnv(db);
    if (mode === 'scoped') {
      env.DISCORD_AUTH_POLICY = JSON.stringify({
        version: 1,
        grants: [
          {
            guildId: TEST_GUILD_ID,
            roleId: TEST_ROLE_ID,
            addFeeds: true,
            channelIds: [channel],
          },
        ],
      });
    }
    const key = await configurationKey(env.CONFIG_ENCRYPTION_KEY);
    let memberChecks = 0;
    let webhookChecks = 0;
    const discord = discordFixture();
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith('/member') && ++memberChecks > budget)
        return Response.json(
          { retry_after: 30, message: 'private-provider-message' },
          { status: 429 },
        );
      if (path === `/api/v10/webhooks/${webhookId}/private-token`) {
        webhookChecks++;
        return Response.json({
          id: webhookId,
          type: 1,
          guild_id: TEST_GUILD_ID,
          channel_id: channel,
        });
      }
      return discord(input, init);
    };
    try {
      if (mode === 'scoped') {
        // Model an already initialized installation without spending login's
        // provider budget on one-time operator setup.
        await saveCatalog(
          env,
          key,
          {
            revision: (await readCatalog(env, key, permissions)).revision,
            operation: { type: 'initialize' },
          },
          permissions,
          fetcher,
          async () => permissions,
        );
      }
      const { cookie } = await browserLogin(env, fetcher);
      assert.equal(memberChecks, 1);
      const request = (path: string, method = 'GET', body?: unknown) =>
        handleAdmin(
          new Request(origin + path, {
            method,
            headers: {
              Cookie: cookie,
              Origin: origin,
              'Content-Type': 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          env,
          fetcher,
        );
      assert.equal((await request('/admin'))!.status, 200);
      const path =
        mode === 'legacy' ? '/admin/api/config' : '/admin/api/catalog';
      const loaded = (await request(path))!;
      assert.equal(loaded.status, 200);
      let current = (await loaded.json()) as { revision: string };
      assert.equal(memberChecks, 1);
      const method = mode === 'legacy' ? 'PUT' : 'POST';
      const savedWebhook = (await request(
        path,
        method,
        mode === 'legacy'
          ? {
              revision: current.revision,
              feeds: [],
              webhooks: { updates: webhook },
            }
          : {
              revision: current.revision,
              operation: {
                type: 'destination.create',
                label: 'Updates',
                webhookUrl: webhook,
              },
            },
      ))!;
      assert.equal(savedWebhook.status, 200, await savedWebhook.clone().text());
      current = (await savedWebhook.json()) as { revision: string };
      assert.equal(memberChecks, 1);
      const savedFeed = (await request(
        path,
        method,
        mode === 'legacy'
          ? {
              revision: current.revision,
              feeds: [
                { url: 'https://example.com/feed', destinations: ['updates'] },
              ],
              webhooks: {},
            }
          : {
              revision: current.revision,
              operation: {
                type: 'feed.create',
                label: 'Example',
                url: 'https://example.com/feed',
              },
            },
      ))!;
      assert.equal(savedFeed.status, 200, await savedFeed.clone().text());
      assert.equal(memberChecks, budget);
      assert.equal(webhookChecks, mode === 'legacy' ? 0 : 1);
      if (mode === 'legacy')
        assert.equal(
          (await readRelayConfiguration(env)).feeds[0]?.url,
          'https://example.com/feed',
        );
      else
        assert.equal(
          (await readCatalog(env, key, permissions)).feeds[0]?.label,
          'Example',
        );
    } finally {
      await dispose();
    }
  });
}

test('mutation entry rejects invalid sessions and cooldowns before consuming a body or calling Discord', async () => {
  const { db, dispose } = await createTestDatabase();
  const env = authEnv(db);
  let bodyReads = 0;
  let providerCalls = 0;
  const fetcher: typeof fetch = async () => {
    providerCalls++;
    throw new Error('No Discord request should be made');
  };
  try {
    const { cookie } = await browserLogin(env);
    const before = await readAdminConfiguration(
      env,
      await configurationKey(env.CONFIG_ENCRYPTION_KEY),
    );
    const attempt = (headers: Record<string, string>, selected = env) =>
      handleAdmin(
        new Request(origin + '/admin/api/config', {
          method: 'PUT',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...headers,
          },
          body: new ReadableStream(
            {
              pull(controller) {
                bodyReads++;
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          duplex: 'half',
        } as RequestInit),
        selected,
        fetcher,
      );
    assert.equal((await attempt({}))!.status, 401);
    assert.equal(
      (await attempt(
        { Cookie: cookie },
        { ...env, DISCORD_ROLE_ID: '100000000000000099' },
      ))!.status,
      401,
    );
    await db
      .prepare('UPDATE admin_sessions SET retry_at_ms = ?')
      .bind(Date.now() + 30000)
      .run();
    const limited = (await attempt({ Cookie: cookie }))!;
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    await db.prepare('UPDATE admin_sessions SET expires_at_ms = 0').run();
    assert.equal((await attempt({ Cookie: cookie }))!.status, 401);
    await db.prepare('DELETE FROM admin_sessions').run();
    assert.equal((await attempt({ Cookie: cookie }))!.status, 401);
    assert.equal(bodyReads, 0);
    assert.equal(providerCalls, 0);
    assert.equal(
      (
        await readAdminConfiguration(
          env,
          await configurationKey(env.CONFIG_ENCRYPTION_KEY),
        )
      ).revision,
      before.revision,
    );
  } finally {
    await dispose();
  }
});
