import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadConfig,
  validateWebhooks,
  webhookFingerprints,
} from '../src/config.ts';

const hook = 'https://discord.com/api/webhooks/123456/secret-token';
const feeds = [{ url: 'https://example.com/feed', destinations: ['updates'] }];

test('whole webhook maps validate every destination without needing feed configuration', () => {
  assert.deepEqual(Object.keys(validateWebhooks({})), []);
  assert.equal(validateWebhooks({ updates: `${hook}/` }).updates, hook);
  for (const value of [
    null,
    [],
    { 'bad name': hook },
    { updates: hook, other: `${hook}/` },
    { updates: 'https://invalid.example/private-token' },
    JSON.parse('{"__proto__":"private-token"}'),
  ]) {
    assert.throws(
      () => validateWebhooks(value),
      (error: unknown) =>
        error instanceof Error && !error.message.includes('private-token'),
    );
  }
});

test('configuration normalizes URLs, supports threads, and ignores unused secrets', () => {
  const config = loadConfig(
    feeds,
    JSON.stringify({ updates: `${hook}?thread_id=123`, retired: 'unused' }),
  );
  assert.equal(config.feeds[0]?.url, 'https://example.com/feed');
  assert.equal(config.webhooks.updates, `${hook}?thread_id=123`);
  assert.equal(config.webhooks.retired, undefined);
  assert.deepEqual(loadConfig([], undefined).feeds, []);
});

test('configuration rejects missing, duplicate and malformed routing without revealing secrets', () => {
  for (const input of [
    null,
    {},
    [{ url: 'file:///etc/passwd', destinations: ['updates'] }],
    [...feeds, ...feeds],
    [{ ...feeds[0], destinations: ['updates', 'updates'] }],
    [{ ...feeds[0], destinations: ['__proto__'] }],
    [{ ...feeds[0], destinations: [] }],
    [{ ...feeds[0], typo: true }],
  ]) {
    assert.throws(() => loadConfig(input, JSON.stringify({ updates: hook })));
  }
  for (const secret of [
    undefined,
    'not-json',
    '[]',
    '{}',
    JSON.stringify({
      updates: 'https://user:secret@discord.com/api/webhooks/1/token',
    }),
    JSON.stringify({ updates: 'https://evil.example/token' }),
    JSON.stringify({ updates: `${hook}?thread_id=x` }),
    JSON.stringify({ updates: `${hook}?wait=false` }),
  ]) {
    assert.throws(
      () => loadConfig(feeds, secret),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('secret-token') &&
        !error.message.includes('user:secret'),
    );
  }
  assert.throws(() =>
    loadConfig(
      [{ ...feeds[0], destinations: ['one', 'two'] }],
      JSON.stringify({ one: hook, two: hook }),
    ),
  );
  assert.throws(() =>
    loadConfig(
      [
        {
          ...feeds[0],
          destinations: Array.from({ length: 21 }, (_, i) => `d${i}`),
        },
      ],
      '{}',
    ),
  );
});

test('webhook fingerprints are stable and change when the secret changes', async () => {
  const first = await webhookFingerprints({ updates: hook });
  assert.match(first.updates!, /^[a-f0-9]{64}$/);
  assert.deepEqual(await webhookFingerprints({ updates: hook }), first);
  assert.notEqual(
    (await webhookFingerprints({ updates: `${hook}2` })).updates,
    first.updates,
  );
});

test('feed URL bounds apply after percent encoding', () => {
  assert.throws(() =>
    loadConfig(
      [
        {
          url: `https://example.test/${'é'.repeat(400)}`,
          destinations: ['updates'],
        },
      ],
      JSON.stringify({ updates: hook }),
    ),
  );
});
