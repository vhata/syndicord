# Operational status

**For the installation owner, with access to the installation's Cloudflare
account.** If you only manage feeds or channels, ask the installation owner to
run this check.

The status report summarizes polling health and pending deliveries saved in D1,
without invoking the Worker or sending a Discord message. It is not a live
delivery test; for live logs and CPU errors, see
[Inspect a run](RECOVERY.md#inspect-a-run).

[Select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation)
first, then run:

```sh
npm run syndicord -- status
```

The command uses the project's pinned `cf` dependency and only queries D1; it
needs no webhook secret or `.dev.vars` file. Hosted reads count toward D1 usage.
Use the database ID recorded for the installation rather than creating a new
database. Use `npm run syndicord -- status --local` from a development checkout
for its local D1 state instead. Remote is the default; the command never changes
migrations, releases a lease, or resumes a suspended destination.

Deployment applies migrations. A fresh installation has no feeds and reports
`disabled`. Add configuration with [Manage feeds and channels](FEEDS.md). Until
the Worker records completed polls, active feeds have status `unknown`; older
delivery history does not establish current health.

## Reading the report

The report reads **the selected database's current feed configuration** and its
health records in one snapshot. It requires no local feed file and excludes
historical routes that are no longer configured. It does not verify the active
Worker code version or test Discord connectivity.

- `healthy`: recent completed runs and successful feed checks, initialized
  destinations, no suspension/cooldown, and no stale backlog. Zero new entries
  is healthy when checks succeed.
- `degraded`: failed/stale polling, an expired unfinished run, a failed run,
  suspended or cooling-down destinations, or an old pending delivery.
- `unknown`: no completed health observations yet, an unchecked feed, or a new
  destination that has not established its baseline.
- `disabled`: the installation is fresh or the stored feed list is empty. A poll
  already in progress may still finish; this is not proof that all invocations
  have stopped.

Feed failure reasons are bounded categories such as `http`, `timeout`, or
`parse_error`. A successful check clears the current failure count while
retaining the historical failure timestamp. Last success is recorded atomically
with ledger ingestion; fetch success followed by a database failure does not
advance it. A completed run can still contain a failed feed check, so the report
checks both the run heartbeat and each feed's health.

The output includes pending counts and oldest pending age for active routes,
alongside destination suspension/cooldown state. Removed routes are excluded;
their retained pending deliveries resume if the same configuration is restored.
Feed indices are zero-based positions in the current relay feed list. How you
match them to configuration depends on the installation's editing permissions:

- With **one admin role**, inspect the list with
  `npm run syndicord -- feeds get`.
- With **separate feed and channel permissions**, the report omits catalog feeds
  without subscriptions, so its feed indices are **not catalog IDs**. The bulk
  `feeds get` command is unavailable; see
  [Inspect a run](RECOVERY.md#inspect-a-run) for matching indices to the
  catalog.

Destination names in this report are delivery-tracking keys, which may differ
from destination labels and IDs shown in the editor or by `destinations list`.
Use the [recovery notes](RECOVERY.md#inspect-a-run) when matching records. Only
hostnames are printed; feed paths/query strings, webhook URLs, fingerprints, and
message payloads are not included.

## Thresholds and scripting

The default cron interval is one minute. A run is stale after the greater of
five minutes or three cron intervals. With N feeds, each feed is stale after the
greater of five minutes or three complete rotations. A backlog becomes stale
after the greater of thirty minutes or that feed threshold. These are
operational signals, not delivery guarantees; cooldowns may legitimately last
longer.

If the deployed cron interval changes, supply its interval in minutes:

```sh
npm run syndicord -- status --interval-minutes 5
```

For machine-readable output:

```sh
npm run syndicord -- status --json
```

JSON timestamps are Unix milliseconds; ages and thresholds are milliseconds. The
query uses database time rather than the inspecting machine's clock. Exit codes
are `0` for healthy/disabled, `1` for degraded/unknown, and `2` for usage,
authentication, query, missing-schema, or configuration errors. The command
suppresses raw remote error text and never prints a webhook secret.

The command reads D1 when requested; it does not install an alerting service.
Inspect [invocation metrics](SETUP.md#verify-delivery) through the CLI tail or
Cloudflare dashboard separately for CPU limits and invocation errors.
