import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canManageChannel,
  parseAuthPolicy,
  permissionsForRoles,
} from '../src/admin-policy.ts';

const guildId = '100000000000000001';
const roleId = '100000000000000002';
const channelId = '100000000000000003';
const secondGuild = '100000000000000004';
const secondRole = '100000000000000005';
const secondChannel = '100000000000000006';

function parse(grants: unknown[]) {
  return parseAuthPolicy(JSON.stringify({ version: 1, grants }));
}

test('operator policy combines exact role grants without broadening channel scopes', () => {
  const policy = parse([
    { guildId, roleId, addFeeds: true },
    { guildId, roleId: secondRole, channelIds: [channelId] },
    { guildId: secondGuild, roleId, channelIds: [secondChannel] },
  ]);
  const permissions = permissionsForRoles(
    policy,
    new Map([
      [guildId, [roleId, secondRole]],
      [secondGuild, [roleId]],
    ]),
  );
  assert.deepEqual(permissions, {
    mode: 'scoped',
    addFeeds: true,
    channels: [
      { guildId, channelId },
      { guildId: secondGuild, channelId: secondChannel },
    ],
  });
  assert.equal(canManageChannel(permissions, guildId, channelId), true);
  assert.equal(canManageChannel(permissions, secondGuild, channelId), false);
  assert.equal(canManageChannel(permissions, guildId, secondChannel), false);
  assert.equal(
    canManageChannel(
      { mode: 'legacy', addFeeds: true, channels: [] },
      guildId,
      channelId,
    ),
    false,
  );
  assert.deepEqual(permissionsForRoles(policy, new Map()), {
    mode: 'scoped',
    addFeeds: false,
    channels: [],
  });
  assert.equal(
    permissionsForRoles(policy, new Map([[guildId, [secondRole]]])).addFeeds,
    false,
  );
});

test('canonical operator policies deduplicate effective scopes and preserve equivalent ordering', () => {
  const first = { guildId, roleId, channelIds: [secondChannel, channelId] };
  const second = {
    guildId,
    roleId: secondRole,
    addFeeds: false,
    channelIds: [channelId],
  };
  const policy = parse([first, second]);
  assert.deepEqual(
    policy,
    parse([second, { ...first, channelIds: [channelId, secondChannel] }]),
  );
  assert.equal(
    permissionsForRoles(policy, new Map([[guildId, [roleId, secondRole]]]))
      .channels.length,
    2,
  );
  assert.deepEqual(parse([]), { version: 1, grants: [] });
});

test('policy validation rejects unknown authority, malformed scopes and excessive inputs', () => {
  const valid = { guildId, roleId, addFeeds: true };
  for (const value of [
    '',
    'null',
    '{}',
    '[]',
    JSON.stringify({ version: 2, grants: [valid] }),
    JSON.stringify({ version: 1, grants: [valid], admin: true }),
    JSON.stringify({ version: 1, grants: [valid] }) + ' '.repeat(16 * 1024),
  ])
    assert.throws(() => parseAuthPolicy(value), /Invalid DISCORD_AUTH_POLICY/);
  for (const grant of [
    {},
    null,
    [],
    { ...valid, guildId: '*' },
    { ...valid, roleId: 100 },
    { ...valid, roleId: '100000000000000002\n' },
    { ...valid, addFeeds: 'true' },
    { ...valid, admin: true },
    { guildId, roleId },
    { guildId, roleId, addFeeds: false, channelIds: [] },
    { ...valid, channelIds: '*' },
    { ...valid, channelIds: [channelId, channelId] },
    { ...valid, channelIds: [channelId, '*'] },
    { ...valid, threadIds: [channelId] },
    {
      ...valid,
      channelIds: Array.from({ length: 65 }, (_, i) =>
        String(100000000000000000n + BigInt(i)),
      ),
    },
  ])
    assert.throws(() => parse([grant]), /Invalid DISCORD_AUTH_POLICY/);
  assert.throws(() => parse([valid, valid]), /Invalid DISCORD_AUTH_POLICY/);
  assert.throws(
    () =>
      parse(
        Array.from({ length: 33 }, (_, i) => ({
          ...valid,
          roleId: String(100000000000000000n + BigInt(i)),
        })),
      ),
    /Invalid DISCORD_AUTH_POLICY/,
  );
  assert.throws(
    () =>
      parse(
        Array.from({ length: 17 }, (_, i) => ({
          ...valid,
          guildId: String(100000000000000000n + BigInt(i)),
        })),
      ),
    /Invalid DISCORD_AUTH_POLICY/,
  );
});
