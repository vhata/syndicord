import assert from 'node:assert/strict';
import test from 'node:test';
import {
  verifyWebhook,
  WebhookVerificationError,
} from '../src/webhook-verification.ts';

const url = 'https://discord.com/api/webhooks/123/private-token';
const metadata = {
  id: '123',
  type: 1,
  guild_id: '100000000000000001',
  channel_id: '200000000000000001',
};

test('webhook verification uses token lookup and validates the actual incoming webhook identity and channel', async () => {
  const verified = await verifyWebhook(url, async (target, init) => {
    assert.equal(
      target,
      'https://discord.com/api/v10/webhooks/123/private-token',
    );
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.body, undefined);
    assert.equal(init?.headers, undefined);
    return Response.json(metadata);
  });
  assert.deepEqual(verified, {
    url,
    guildId: metadata.guild_id,
    channelId: metadata.channel_id,
  });
  for (const override of [
    { id: '999' },
    { type: 2 },
    { guild_id: null },
    { channel_id: 'bad' },
  ])
    await assert.rejects(
      verifyWebhook(url, async () =>
        Response.json({ ...metadata, ...override }),
      ),
      (error: unknown) =>
        error instanceof WebhookVerificationError &&
        error.status === 400 &&
        !error.message.includes('private-token'),
    );
});

test('webhook verification rejects threads and non-Discord URLs before requests and never follows redirects', async () => {
  let calls = 0;
  for (const candidate of [
    url + '?thread_id=1',
    'https://evil.example/api/webhooks/123/token',
    url + '?wait=true',
  ])
    await assert.rejects(
      verifyWebhook(candidate, async () => {
        calls++;
        return Response.json(metadata);
      }),
      WebhookVerificationError,
    );
  assert.equal(calls, 0);
  await assert.rejects(
    verifyWebhook(url, async (_target, init) => {
      assert.equal(init?.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/private-token' },
      });
    }),
    (error: unknown) =>
      error instanceof WebhookVerificationError &&
      error.status === 503 &&
      !error.message.includes('private-token'),
  );
});

test('verification errors bound and sanitize provider bodies while preserving Discord cooldowns', async () => {
  await assert.rejects(
    verifyWebhook(url, async () => new Response('x'.repeat(65 * 1024))),
    (error: unknown) =>
      error instanceof WebhookVerificationError && error.status === 503,
  );
  await assert.rejects(
    verifyWebhook(url, async () => {
      throw new Error('private-token');
    }),
    (error: unknown) =>
      error instanceof WebhookVerificationError &&
      !error.message.includes('private-token'),
  );
  await assert.rejects(
    verifyWebhook(url, async () =>
      Response.json(
        { retry_after: 7.5, global: true, token: 'private-token' },
        {
          status: 429,
          headers: { 'Retry-After': '3', 'X-RateLimit-Reset-After': '5' },
        },
      ),
    ),
    (error: unknown) =>
      error instanceof WebhookVerificationError &&
      error.status === 429 &&
      error.retryAfterMs === 7500 &&
      error.global,
  );
  await assert.rejects(
    verifyWebhook(
      url,
      async () =>
        new Response('not JSON private-token', {
          status: 429,
          headers: { 'Retry-After': '12', 'X-RateLimit-Scope': 'global' },
        }),
    ),
    (error: unknown) =>
      error instanceof WebhookVerificationError &&
      error.retryAfterMs === 12000 &&
      error.global,
  );
});
