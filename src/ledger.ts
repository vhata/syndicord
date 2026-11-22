import type { Delivery, FeedEntry, FeedRoute } from './types.ts';

const LEASE_MS = 120_000;
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const OWNER_GUARD = `EXISTS (
  SELECT 1 FROM relay_lease
  WHERE id = 1 AND owner = ? AND expires_at_ms > ${NOW_MS}
)`;

export class LostLeaseError extends Error {
  constructor() {
    super('Polling lease is no longer held.');
    this.name = 'LostLeaseError';
  }
}

function duration(value: number): number {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(Math.ceil(value))
  ) {
    throw new RangeError(
      'Duration must be a nonnegative safe number of milliseconds.',
    );
  }
  return Math.ceil(value);
}

function leaseDuration(value: number): number {
  if (value <= 0) throw new RangeError('Lease duration must be positive.');
  return duration(value);
}

export class DeliveryLedger {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async acquire(owner: string, ttlMs = LEASE_MS): Promise<number | null> {
    if (!owner) throw new TypeError('A lease owner is required.');
    const row = await this.db
      .prepare(
        `
        INSERT INTO relay_lease
          (id, owner, expires_at_ms, cursor, last_started_ms, last_outcome)
        VALUES (1, ?, ${NOW_MS} + ?, 1, ${NOW_MS}, 'running')
        ON CONFLICT (id) DO UPDATE SET
          owner = excluded.owner,
          expires_at_ms = excluded.expires_at_ms,
          cursor = relay_lease.cursor + 1,
          last_started_ms = excluded.last_started_ms,
          last_outcome = 'running'
        WHERE relay_lease.expires_at_ms <= ${NOW_MS}
        RETURNING cursor - 1 AS cursor
      `,
      )
      .bind(owner, leaseDuration(ttlMs))
      .first<{ cursor: number }>();
    return row?.cursor ?? null;
  }

  private renewal(owner: string, ttlMs = LEASE_MS): D1PreparedStatement {
    return this.db
      .prepare(
        `
        UPDATE relay_lease SET expires_at_ms = ${NOW_MS} + ?
        WHERE id = 1 AND owner = ? AND expires_at_ms > ${NOW_MS}
      `,
      )
      .bind(leaseDuration(ttlMs), owner);
  }

  async renew(owner: string, ttlMs = LEASE_MS): Promise<boolean> {
    const result = await this.renewal(owner, ttlMs).run();
    return result.meta.changes === 1;
  }

  async release(owner: string, completed = false): Promise<boolean> {
    const result = await this.db
      .prepare(
        `
        UPDATE relay_lease SET owner = '', expires_at_ms = 0,
          last_completed_ms = CASE WHEN ? THEN ${NOW_MS} ELSE last_completed_ms END,
          last_outcome = CASE WHEN ? THEN 'completed' ELSE 'failed' END
        WHERE id = 1 AND owner = ? AND expires_at_ms > ${NOW_MS}
      `,
      )
      .bind(completed, completed, owner)
      .run();
    if (completed && result.meta.changes !== 1) throw new LostLeaseError();
    return result.meta.changes === 1;
  }

  // A zero-row renewal does not abort a D1 batch. Every subsequent write
  // therefore repeats the ownership predicate. A valid renewal gives the
  // transaction two minutes, beyond D1's maximum transaction duration.
  private async mutate(
    owner: string,
    statements: D1PreparedStatement[],
  ): Promise<D1Result[] | null> {
    const results = await this.db.batch([this.renewal(owner), ...statements]);
    if (results[0]?.meta.changes !== 1) return null;
    return results.slice(1);
  }

  async ingest(
    owner: string,
    route: FeedRoute,
    entries: readonly FeedEntry[],
  ): Promise<{ baselined: number; queued: number }> {
    const destinations = JSON.stringify([...new Set(route.destinations)]);
    const uniqueEntries = [
      ...new Map(entries.map((entry) => [entry.id, entry])).values(),
    ];
    const baselineId = crypto.randomUUID();
    const results = await this.mutate(owner, [
      this.db
        .prepare(
          `
          INSERT INTO relay_routes
            (feed_url, destination, baseline_id, initialized_at_ms)
          SELECT ?, value, ?, ${NOW_MS}
          FROM json_each(?) WHERE ${OWNER_GUARD}
          ON CONFLICT (feed_url, destination) DO NOTHING
        `,
        )
        .bind(route.url, baselineId, destinations, owner),
      this.db
        .prepare(
          `
          INSERT INTO relay_deliveries
            (feed_url, destination, entry_id, state, payload, attempts,
             first_seen_ms, next_attempt_ms)
          SELECT ?, routes.destination, json_extract(entries.value, '$.id'),
            CASE WHEN routes.baseline_id = ? THEN 'baseline' ELSE 'pending' END,
            CASE WHEN routes.baseline_id = ? THEN NULL ELSE entries.value END,
            0, ${NOW_MS}, ${NOW_MS}
          FROM relay_routes AS routes CROSS JOIN json_each(?) AS entries
          WHERE routes.feed_url = ?
            AND routes.destination IN (SELECT value FROM json_each(?))
            AND ${OWNER_GUARD}
          ON CONFLICT (feed_url, destination, entry_id) DO NOTHING
        `,
        )
        .bind(
          route.url,
          baselineId,
          baselineId,
          JSON.stringify(uniqueEntries),
          route.url,
          destinations,
          owner,
        ),
      this.db
        .prepare(
          `
          INSERT INTO relay_feed_health
            (feed_url, last_attempt_ms, last_success_ms, entry_count)
          SELECT ?, ${NOW_MS}, ${NOW_MS}, ? WHERE ${OWNER_GUARD}
          ON CONFLICT (feed_url) DO UPDATE SET
            last_success_ms = excluded.last_success_ms,
            last_error = NULL, consecutive_failures = 0,
            entry_count = excluded.entry_count
        `,
        )
        .bind(route.url, uniqueEntries.length, owner),
    ]);
    if (!results) throw new LostLeaseError();
    const baselined = results[0]!.meta.changes;
    const inserted = results[1]!.meta.changes;
    return { baselined, queued: inserted - baselined * uniqueEntries.length };
  }

  async syncDestinations(
    owner: string,
    fingerprints: Readonly<Record<string, string>>,
    feedUrl?: string,
  ): Promise<void> {
    const destinations = Object.entries(fingerprints).map(
      ([destination, fingerprint]) => {
        if (destination === '*' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
          throw new TypeError(
            'Destination fingerprints must be SHA-256 hashes.',
          );
        }
        return { destination, fingerprint };
      },
    );
    const statements = [
      this.db
        .prepare(
          `
          INSERT INTO relay_destinations (destination, fingerprint)
          SELECT json_extract(value, '$.destination'), json_extract(value, '$.fingerprint')
          FROM json_each(?) WHERE ${OWNER_GUARD}
          ON CONFLICT (destination) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            suspended = 0,
            cooldown_until_ms = 0
          WHERE relay_destinations.fingerprint IS NOT excluded.fingerprint
        `,
        )
        .bind(JSON.stringify(destinations), owner),
    ];
    if (feedUrl) {
      statements.push(
        this.db
          .prepare(
            `
            INSERT INTO relay_feed_health (feed_url, last_attempt_ms)
            SELECT ?, ${NOW_MS} WHERE ${OWNER_GUARD}
            ON CONFLICT (feed_url) DO UPDATE SET
              last_attempt_ms = excluded.last_attempt_ms
          `,
          )
          .bind(feedUrl, owner),
      );
    }
    const results = await this.mutate(owner, statements);
    if (!results) throw new LostLeaseError();
  }

  async feedFailed(
    owner: string,
    feedUrl: string,
    reason: string,
  ): Promise<void> {
    if (
      ![
        'timeout',
        'network',
        'http',
        'redirect',
        'too_large',
        'encoding',
        'parse_error',
      ].includes(reason)
    ) {
      throw new TypeError('Unsupported feed failure reason.');
    }
    const results = await this.mutate(owner, [
      this.db
        .prepare(
          `
        UPDATE relay_feed_health
        SET last_failure_ms = ${NOW_MS}, last_error = ?,
          consecutive_failures = consecutive_failures + 1
        WHERE feed_url = ? AND ${OWNER_GUARD}
      `,
        )
        .bind(reason, feedUrl, owner),
    ]);
    if (!results) throw new LostLeaseError();
  }

  async pending(
    owner: string,
    routes: readonly FeedRoute[],
    limit: number,
  ): Promise<Delivery[]> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) {
      throw new RangeError(
        'Pending delivery limit must be an integer from 0 to 100.',
      );
    }
    if (limit === 0) return [];
    const { results } = await this.db
      .prepare(
        `
        WITH active AS MATERIALIZED (
          SELECT DISTINCT json_extract(feeds.value, '$.url') AS feed_url,
            destinations.value AS destination
          FROM json_each(?) AS feeds
          CROSS JOIN json_each(json_extract(feeds.value, '$.destinations')) AS destinations
        )
        SELECT deliveries.feed_url, deliveries.destination,
          deliveries.payload, deliveries.attempts
        FROM relay_deliveries AS deliveries
        JOIN active ON active.feed_url = deliveries.feed_url
          AND active.destination = deliveries.destination
        LEFT JOIN relay_destinations AS destination
          ON destination.destination = deliveries.destination
        WHERE deliveries.state = 'pending'
          AND deliveries.next_attempt_ms <= ${NOW_MS}
          AND COALESCE(destination.suspended, 0) = 0
          AND COALESCE(destination.cooldown_until_ms, 0) <= ${NOW_MS}
          AND NOT EXISTS (
            SELECT 1 FROM relay_destinations
            WHERE destination = '*' AND cooldown_until_ms > ${NOW_MS}
          )
          AND ${OWNER_GUARD}
        ORDER BY deliveries.first_seen_ms, deliveries.feed_url,
          deliveries.destination, deliveries.entry_id
        LIMIT ?
      `,
      )
      .bind(JSON.stringify(routes), owner, limit)
      .all<{
        feed_url: string;
        destination: string;
        payload: string;
        attempts: number;
      }>();
    return results.map((row) => ({
      feedUrl: row.feed_url,
      destination: row.destination,
      entry: JSON.parse(row.payload) as FeedEntry,
      attempts: row.attempts,
    }));
  }

  async ack(owner: string, delivery: Delivery): Promise<boolean> {
    const results = await this.mutate(owner, [
      this.db
        .prepare(
          `
          UPDATE relay_deliveries
          SET state = 'sent', payload = NULL, next_attempt_ms = 0, last_error = NULL
          WHERE feed_url = ? AND destination = ? AND entry_id = ?
            AND state = 'pending' AND ${OWNER_GUARD}
        `,
        )
        .bind(delivery.feedUrl, delivery.destination, delivery.entry.id, owner),
    ]);
    return results?.[0]?.meta.changes === 1;
  }

  async retry(
    owner: string,
    delivery: Delivery,
    delayMs: number,
    reason: string,
  ): Promise<boolean> {
    const results = await this.mutate(owner, [
      this.db
        .prepare(
          `
          UPDATE relay_deliveries
          SET attempts = attempts + 1, next_attempt_ms = ${NOW_MS} + ?, last_error = ?
          WHERE feed_url = ? AND destination = ? AND entry_id = ?
            AND state = 'pending' AND ${OWNER_GUARD}
        `,
        )
        .bind(
          duration(delayMs),
          reason.slice(0, 128),
          delivery.feedUrl,
          delivery.destination,
          delivery.entry.id,
          owner,
        ),
    ]);
    return results?.[0]?.meta.changes === 1;
  }

  async cooldown(
    owner: string,
    destination: string,
    delayMs: number,
  ): Promise<boolean> {
    const results = await this.mutate(owner, [
      this.db
        .prepare(
          `
          INSERT INTO relay_destinations (destination, cooldown_until_ms)
          SELECT ?, ${NOW_MS} + ? WHERE ${OWNER_GUARD}
          ON CONFLICT (destination) DO UPDATE SET
            cooldown_until_ms = MAX(relay_destinations.cooldown_until_ms, excluded.cooldown_until_ms)
        `,
        )
        .bind(destination, duration(delayMs), owner),
    ]);
    return results?.[0]?.meta.changes === 1;
  }

  async suspend(owner: string, destination: string): Promise<boolean> {
    const results = await this.mutate(owner, [
      this.db
        .prepare(
          `
          INSERT INTO relay_destinations (destination, suspended)
          SELECT ?, 1 WHERE ${OWNER_GUARD}
          ON CONFLICT (destination) DO UPDATE SET suspended = 1
        `,
        )
        .bind(destination, owner),
    ]);
    return results?.[0]?.meta.changes === 1;
  }
}
