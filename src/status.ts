import type { FeedRoute } from './types.ts';

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export const STATUS_SCHEMA_SQL = `
  SELECT
    (SELECT COUNT(*) FROM pragma_table_info('relay_lease')
      WHERE name IN ('last_started_ms', 'last_completed_ms', 'last_outcome')) AS run_columns,
    (SELECT COUNT(*) FROM pragma_table_info('relay_feed_health')
      WHERE name IN ('feed_url', 'last_attempt_ms', 'last_success_ms',
        'last_failure_ms', 'last_error', 'consecutive_failures', 'entry_count')) AS feed_columns
`;

// Only aggregate counts and health metadata are selected. Payloads, webhook
// fingerprints, and webhook URLs never enter the status response.
export const STATUS_SQL = `
  WITH active AS (
    SELECT json_extract(value, '$.url') AS feed_url,
      json_extract(value, '$.destination') AS destination
    FROM json_each(?)
  ), feeds AS (
    SELECT feed_url, COUNT(*) AS destination_count FROM active GROUP BY feed_url
  )
  SELECT json_object(
    'now_ms', ${NOW_MS},
    'run', (SELECT json_object(
      'last_started_ms', last_started_ms,
      'last_completed_ms', last_completed_ms,
      'last_outcome', last_outcome,
      'lease_expires_ms', expires_at_ms
    ) FROM relay_lease WHERE id = 1),
    'feeds', (SELECT json_group_array(json_object(
      'url', feeds.feed_url,
      'last_attempt_ms', health.last_attempt_ms,
      'last_success_ms', health.last_success_ms,
      'last_failure_ms', health.last_failure_ms,
      'last_error', health.last_error,
      'consecutive_failures', COALESCE(health.consecutive_failures, 0),
      'entry_count', health.entry_count,
      'uninitialized', feeds.destination_count - (
        SELECT COUNT(*) FROM relay_routes AS routes JOIN active
          ON active.feed_url = routes.feed_url AND active.destination = routes.destination
        WHERE routes.feed_url = feeds.feed_url
      ),
      'pending', (SELECT COUNT(*) FROM relay_deliveries AS deliveries JOIN active
        ON active.feed_url = deliveries.feed_url AND active.destination = deliveries.destination
        WHERE deliveries.feed_url = feeds.feed_url AND deliveries.state = 'pending'),
      'oldest_pending_ms', (SELECT MIN(deliveries.first_seen_ms) FROM relay_deliveries AS deliveries JOIN active
        ON active.feed_url = deliveries.feed_url AND active.destination = deliveries.destination
        WHERE deliveries.feed_url = feeds.feed_url AND deliveries.state = 'pending')
    )) FROM feeds LEFT JOIN relay_feed_health AS health ON health.feed_url = feeds.feed_url),
    'destinations', (SELECT json_group_array(json_object(
      'name', names.destination,
      'known', destinations.destination IS NOT NULL,
      'suspended', COALESCE(destinations.suspended, 0),
      'cooldown_until_ms', COALESCE(destinations.cooldown_until_ms, 0)
    )) FROM (SELECT DISTINCT destination FROM active) AS names
      LEFT JOIN relay_destinations AS destinations ON destinations.destination = names.destination),
    'global_cooldown_until_ms', COALESCE((SELECT cooldown_until_ms
      FROM relay_destinations WHERE destination = '*'), 0)
  ) AS snapshot
`;

export function statusParameters(feeds: readonly FeedRoute[]): string {
  return JSON.stringify(
    feeds.flatMap((feed) =>
      feed.destinations.map((destination) => ({ url: feed.url, destination })),
    ),
  );
}

interface FeedHealth {
  url: string;
  last_attempt_ms: number | null;
  last_success_ms: number | null;
  last_failure_ms: number | null;
  last_error: string | null;
  consecutive_failures: number;
  entry_count: number | null;
  uninitialized: number;
  pending: number;
  oldest_pending_ms: number | null;
}

interface RunHealth {
  last_started_ms: number | null;
  last_completed_ms: number | null;
  last_outcome: 'running' | 'completed' | 'failed' | null;
  lease_expires_ms: number;
}

interface DestinationHealth {
  name: string;
  known: number;
  suspended: number;
  cooldown_until_ms: number;
}

export interface StatusSnapshot {
  now_ms: number;
  run: RunHealth | null;
  feeds: FeedHealth[];
  destinations: DestinationHealth[];
  global_cooldown_until_ms: number;
}

type Health = 'healthy' | 'degraded' | 'unknown' | 'disabled';

function timestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 8_640_000_000_000_000)
  );
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStatusSnapshot(value: unknown): StatusSnapshot {
  if (
    !object(value) ||
    !count(value.now_ms) ||
    !count(value.global_cooldown_until_ms) ||
    !Array.isArray(value.feeds) ||
    !Array.isArray(value.destinations)
  )
    throw new Error('Invalid status response.');
  if (
    value.run !== null &&
    (!object(value.run) ||
      !timestamp(value.run.last_started_ms) ||
      !timestamp(value.run.last_completed_ms) ||
      !count(value.run.lease_expires_ms) ||
      ![null, 'running', 'completed', 'failed'].includes(
        value.run.last_outcome as string | null,
      ))
  )
    throw new Error('Invalid status response.');
  for (const feed of value.feeds) {
    if (
      !object(feed) ||
      typeof feed.url !== 'string' ||
      !timestamp(feed.last_attempt_ms) ||
      !timestamp(feed.last_success_ms) ||
      !timestamp(feed.last_failure_ms) ||
      !timestamp(feed.oldest_pending_ms) ||
      !count(feed.consecutive_failures) ||
      !count(feed.uninitialized) ||
      !count(feed.pending) ||
      !(feed.entry_count === null || count(feed.entry_count)) ||
      ![
        null,
        'timeout',
        'network',
        'http',
        'redirect',
        'too_large',
        'encoding',
        'parse_error',
      ].includes(feed.last_error as string | null)
    )
      throw new Error('Invalid status response.');
  }
  for (const destination of value.destinations) {
    if (
      !object(destination) ||
      typeof destination.name !== 'string' ||
      ![0, 1].includes(destination.known as number) ||
      ![0, 1].includes(destination.suspended as number) ||
      !count(destination.cooldown_until_ms)
    )
      throw new Error('Invalid status response.');
  }
  return value as unknown as StatusSnapshot;
}

export function summarizeStatus(
  snapshot: StatusSnapshot,
  routes: readonly FeedRoute[],
  intervalMinutes = 1,
) {
  if (
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes <= 0 ||
    intervalMinutes > 1440
  )
    throw new Error('Polling interval must be between 0 and 1440 minutes.');
  const runStaleMs = Math.max(5, 3 * intervalMinutes) * 60_000;
  const feedStaleMs = Math.max(5, 3 * routes.length * intervalMinutes) * 60_000;
  const backlogStaleMs = Math.max(30 * 60_000, feedStaleMs);
  const now = snapshot.now_ms;
  const age = (value: number | null) =>
    value === null ? null : Math.max(0, now - value);
  const feeds = routes.map((route, index) => {
    const feed = snapshot.feeds.find(
      (candidate) => candidate.url === route.url,
    );
    if (!feed) throw new Error('Status response does not match feeds.json.');
    let health: Health = 'healthy';
    if (feed.last_success_ms === null || feed.uninitialized > 0)
      health = 'unknown';
    if (
      feed.consecutive_failures > 0 ||
      (age(feed.last_success_ms) ?? 0) > feedStaleMs ||
      (age(feed.oldest_pending_ms) ?? 0) > backlogStaleMs
    )
      health = 'degraded';
    return {
      index,
      host: new URL(route.url).hostname,
      destinations: route.destinations,
      health,
      lastAttempt: feed.last_attempt_ms,
      lastSuccess: feed.last_success_ms,
      lastFailure: feed.last_failure_ms,
      error: feed.last_error,
      consecutiveFailures: feed.consecutive_failures,
      entries: feed.entry_count,
      uninitializedDestinations: feed.uninitialized,
      pending: feed.pending,
      oldestPendingAgeMs: age(feed.oldest_pending_ms),
    };
  });
  const names = [...new Set(routes.flatMap((route) => route.destinations))];
  const destinations = names.map((name) => {
    const destination = snapshot.destinations.find(
      (candidate) => candidate.name === name,
    );
    if (!destination)
      throw new Error('Status response does not match feeds.json.');
    return {
      name,
      state: destination.suspended
        ? 'suspended'
        : !destination.known
          ? 'unknown'
          : Math.max(
                destination.cooldown_until_ms,
                snapshot.global_cooldown_until_ms,
              ) > now
            ? 'cooldown'
            : 'ready',
      cooldownUntil:
        Math.max(
          destination.cooldown_until_ms,
          snapshot.global_cooldown_until_ms,
        ) || null,
    };
  });
  let health: Health = 'healthy';
  if (
    !snapshot.run?.last_completed_ms ||
    feeds.some((feed) => feed.health === 'unknown') ||
    destinations.some((destination) => destination.state === 'unknown')
  )
    health = 'unknown';
  if (
    snapshot.run?.last_outcome === 'failed' ||
    (snapshot.run?.last_outcome === 'running' &&
      snapshot.run.lease_expires_ms <= now) ||
    (age(snapshot.run?.last_completed_ms ?? null) ?? 0) > runStaleMs ||
    feeds.some((feed) => feed.health === 'degraded') ||
    destinations.some((destination) =>
      ['suspended', 'cooldown'].includes(destination.state),
    )
  )
    health = 'degraded';
  if (routes.length === 0) health = 'disabled';
  return {
    health,
    observedAt: now,
    scope: 'feeds.json in this checkout',
    expectedPollIntervalMinutes: intervalMinutes,
    runStaleAfterMs: runStaleMs,
    feedStaleAfterMs: feedStaleMs,
    backlogStaleAfterMs: backlogStaleMs,
    lastRunStarted: snapshot.run?.last_started_ms ?? null,
    lastRunCompleted: snapshot.run?.last_completed_ms ?? null,
    lastRunOutcome: snapshot.run?.last_outcome ?? null,
    pending: feeds.reduce((sum, feed) => sum + feed.pending, 0),
    feeds,
    destinations,
  };
}

export type StatusReport = ReturnType<typeof summarizeStatus>;

export function formatStatus(
  report: StatusReport,
  target: 'local' | 'remote',
): string {
  const date = (value: number | null) => {
    if (value === null) return 'never';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? 'beyond the supported date range'
      : parsed.toISOString();
  };
  const age = (value: number | null) =>
    value === null ? 'none' : `${Math.floor(value / 60_000)}m`;
  return [
    `syndicord: ${report.health} (${target}; ${report.scope})`,
    `Last completed run: ${date(report.lastRunCompleted)}; latest outcome: ${report.lastRunOutcome ?? 'unknown'}`,
    `Pending deliveries: ${report.pending}; feed stale threshold: ${report.feedStaleAfterMs / 60_000}m`,
    ...report.feeds.map(
      (feed) =>
        `Feed ${feed.index} (${feed.host} -> ${feed.destinations.join(', ')}): ${feed.health}; last success ${date(feed.lastSuccess)}; pending ${feed.pending}; oldest ${age(feed.oldestPendingAgeMs)}${feed.error ? `; ${feed.error} (${feed.consecutiveFailures} consecutive)` : ''}${feed.uninitializedDestinations ? `; ${feed.uninitializedDestinations} destinations awaiting baseline` : ''}`,
    ),
    ...report.destinations.map(
      (destination) =>
        `Destination ${destination.name}: ${destination.state}${destination.state === 'cooldown' ? ` until ${date(destination.cooldownUntil)}` : ''}`,
    ),
  ].join('\n');
}
