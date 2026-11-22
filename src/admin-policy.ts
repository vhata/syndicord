export interface ChannelScope {
  guildId: string;
  channelId: string;
}

export interface AdminPermissions {
  mode: 'legacy' | 'scoped';
  addFeeds: boolean;
  channels: ChannelScope[];
}

export interface RoleGrant {
  guildId: string;
  roleId: string;
  addFeeds: boolean;
  channelIds: string[];
}

export interface AuthPolicy {
  version: 1;
  grants: RoleGrant[];
}

export const DISCORD_ID = /^[1-9][0-9]{16,19}$/;
const MAX_POLICY_BYTES = 16 * 1024;
const MAX_GRANTS = 32;
const MAX_GUILDS = 16;
const MAX_CHANNELS_PER_GRANT = 64;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Parse the operator-owned DISCORD_AUTH_POLICY binding, never API input. */
export function parseAuthPolicy(raw: string): AuthPolicy {
  const invalid = () => new Error('Invalid DISCORD_AUTH_POLICY configuration.');
  if (new TextEncoder().encode(raw).byteLength > MAX_POLICY_BYTES)
    throw invalid();
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !record(input) ||
    !keys(input, ['version', 'grants']) ||
    input.version !== 1 ||
    !Array.isArray(input.grants) ||
    input.grants.length > MAX_GRANTS
  )
    throw invalid();
  const guilds = new Set<string>();
  const pairs = new Set<string>();
  const grants: RoleGrant[] = [];
  for (const value of input.grants) {
    if (
      !record(value) ||
      !keys(value, ['guildId', 'roleId', 'addFeeds', 'channelIds']) ||
      typeof value.guildId !== 'string' ||
      !DISCORD_ID.test(value.guildId) ||
      typeof value.roleId !== 'string' ||
      !DISCORD_ID.test(value.roleId) ||
      (value.addFeeds !== undefined && typeof value.addFeeds !== 'boolean') ||
      (value.channelIds !== undefined && !Array.isArray(value.channelIds))
    )
      throw invalid();
    const channelIds: unknown[] = value.channelIds ?? [];
    if (
      channelIds.length > MAX_CHANNELS_PER_GRANT ||
      !channelIds.every(
        (id) => typeof id === 'string' && DISCORD_ID.test(id),
      ) ||
      new Set(channelIds).size !== channelIds.length ||
      (value.addFeeds !== true && channelIds.length === 0)
    )
      throw invalid();
    const pair = `${value.guildId}:${value.roleId}`;
    if (pairs.has(pair)) throw invalid();
    pairs.add(pair);
    guilds.add(value.guildId);
    if (guilds.size > MAX_GUILDS) throw invalid();
    grants.push({
      guildId: value.guildId,
      roleId: value.roleId,
      addFeeds: value.addFeeds === true,
      channelIds: (channelIds as string[]).slice().sort(),
    });
  }
  // Equivalent JSON ordering does not unnecessarily invalidate sessions.
  grants.sort((a, b) =>
    `${a.guildId}:${a.roleId}`.localeCompare(`${b.guildId}:${b.roleId}`),
  );
  return { version: 1, grants };
}

/** Membership evidence must come from Discord for the current request. */
export function permissionsForRoles(
  policy: AuthPolicy,
  rolesByGuild: ReadonlyMap<string, readonly string[]>,
): AdminPermissions {
  let addFeeds = false;
  const channels = new Map<string, ChannelScope>();
  for (const grant of policy.grants) {
    if (!rolesByGuild.get(grant.guildId)?.includes(grant.roleId)) continue;
    addFeeds ||= grant.addFeeds;
    for (const channelId of grant.channelIds)
      channels.set(`${grant.guildId}:${channelId}`, {
        guildId: grant.guildId,
        channelId,
      });
  }
  return { mode: 'scoped', addFeeds, channels: [...channels.values()] };
}

export function canManageChannel(
  permissions: AdminPermissions,
  guildId: string,
  channelId: string,
): boolean {
  return (
    permissions.mode === 'scoped' &&
    permissions.channels.some(
      (scope) => scope.guildId === guildId && scope.channelId === channelId,
    )
  );
}
