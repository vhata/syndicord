import { webhookFingerprints } from './config.ts';
import type { RelayConfig } from './config.ts';
import { sendDiscord } from './discord.ts';
import { parseFeedDocument } from './feed.ts';
import { FeedFetchError, fetchFeed } from './http.ts';
import { DeliveryLedger, LostLeaseError } from './ledger.ts';
import type { Fetcher } from './types.ts';

export interface RelayEvent {
  event: string;
  feedIndex?: number;
  destination?: string;
  reason?: string;
  status?: number | null;
  count?: number;
}

export interface RunReport {
  outcome: 'completed' | 'busy' | 'unconfigured' | 'lost_lease';
  baselined: number;
  queued: number;
  sent: number;
  deferred: number;
  feedErrors: number;
}

interface RunOptions {
  fetcher?: Fetcher;
  log?: (event: RelayEvent) => void;
  now?: () => number;
  owner?: string;
}

export async function runRelay(
  config: RelayConfig,
  db: D1Database,
  options: RunOptions = {},
): Promise<RunReport> {
  const report: RunReport = {
    outcome: 'completed',
    baselined: 0,
    queued: 0,
    sent: 0,
    deferred: 0,
    feedErrors: 0,
  };
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  if (config.feeds.length === 0) {
    report.outcome = 'unconfigured';
    log({ event: 'relay_unconfigured' });
    return report;
  }
  const now = options.now ?? Date.now;
  const deadline = now() + 30_000;
  const fetcher = options.fetcher ?? fetch;
  const owner = options.owner ?? crypto.randomUUID();
  const ledger = new DeliveryLedger(db);
  let acquired = false;
  try {
    const cursor = await ledger.acquire(owner);
    if (cursor === null) {
      report.outcome = 'busy';
      log({ event: 'relay_busy' });
      return report;
    }
    acquired = true;
    await ledger.syncDestinations(
      owner,
      await webhookFingerprints(config.webhooks),
    );
    const feedIndex = cursor % config.feeds.length;
    const route = config.feeds[feedIndex]!;
    let parsed;
    try {
      const response = await fetchFeed(route.url, fetcher);
      parsed = await parseFeedDocument(response.text, response.url);
    } catch (error) {
      report.feedErrors++;
      log({
        event: 'feed_failed',
        feedIndex,
        reason: error instanceof FeedFetchError ? error.reason : 'parse_error',
      });
    }
    if (parsed) {
      const result = await ledger.ingest(owner, route, parsed.entries);
      report.baselined += result.baselined;
      report.queued += result.queued;
      log({ event: 'feed_checked', feedIndex, count: parsed.entries.length });
    }

    const pending = await ledger.pending(owner, config.feeds, 5);
    const blocked = new Set<string>();
    for (const delivery of pending) {
      if (now() > deadline - 7000) break;
      if (blocked.has(delivery.destination)) continue;
      const webhook = config.webhooks[delivery.destination];
      if (!webhook) continue;
      if (!(await ledger.renew(owner))) throw new LostLeaseError();
      const result = await sendDiscord(
        webhook,
        delivery.entry,
        delivery.feedUrl,
        fetcher,
      );
      if (result.ok) {
        if (!(await ledger.ack(owner, delivery))) throw new LostLeaseError();
        report.sent++;
        log({ event: 'delivery_sent', destination: delivery.destination });
        if (result.cooldownMs > 0) {
          if (
            !(await ledger.cooldown(
              owner,
              delivery.destination,
              result.cooldownMs,
            ))
          )
            throw new LostLeaseError();
          blocked.add(delivery.destination);
        }
      } else {
        const backoff = Math.min(
          6 * 60 * 60_000,
          60_000 * 2 ** Math.min(delivery.attempts, 10),
        );
        const delay = Math.max(backoff, result.retryAfterMs ?? 0);
        if (!(await ledger.retry(owner, delivery, delay, result.reason)))
          throw new LostLeaseError();
        report.deferred++;
        log({
          event: 'delivery_deferred',
          destination: delivery.destination,
          reason: result.reason,
          status: result.status,
        });
        if (
          result.status === 401 ||
          result.status === 403 ||
          result.status === 404
        ) {
          if (!(await ledger.suspend(owner, delivery.destination)))
            throw new LostLeaseError();
          blocked.add(delivery.destination);
          log({
            event: 'destination_suspended',
            destination: delivery.destination,
            status: result.status,
          });
        } else if (result.reason === 'rate_limited') {
          if (
            !(await ledger.cooldown(
              owner,
              result.global ? '*' : delivery.destination,
              delay,
            ))
          )
            throw new LostLeaseError();
          if (result.global) break;
          blocked.add(delivery.destination);
        }
      }
    }
    log({ event: 'relay_complete', count: report.sent });
    return report;
  } catch (error) {
    if (error instanceof LostLeaseError) {
      report.outcome = 'lost_lease';
      log({ event: 'relay_lost_lease' });
      return report;
    }
    throw new Error('Relay database operation failed');
  } finally {
    if (acquired) {
      try {
        await ledger.release(owner);
      } catch {
        throw new Error('Relay lease release failed');
      }
    }
  }
}
