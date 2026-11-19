# Operational status

Inspect polling health and pending deliveries without invoking the Worker or
sending a Discord message:

```sh
export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
npm run status -- --remote
```

The command uses the installed `cf` CLI and its existing authentication. It only
queries D1; it needs no webhook secret or `.dev.vars` file. Hosted reads count
toward D1 usage. The database ID is non-secret deployment configuration; use
the ID recorded for the deployment rather than creating a new database.
Use `npm run status -- --local` for this checkout's local D1
state instead. An explicit target is required; the command never changes
migrations, releases a lease, or resumes a suspended destination.

The status schema is installed by `0002_operational_status.sql`. Apply migrations
before deploying the Worker that records health. Until that version completes
polls, status is `unknown`; older delivery history does not establish current
health. The migration preserves the existing ledger and is compatible with the
previous Worker, which does not update the new health fields.

## Reading the report

The report covers **the feeds and destinations in this checkout's `feeds.json`**.
Use the deployed revision's configuration when diagnosing production. It does
not verify which code or feed configuration is currently deployed.

- `healthy`: recent completed runs and successful feed checks, initialized
  destinations, no suspension/cooldown, and no stale backlog. Zero new entries
  is healthy when checks succeed.
- `degraded`: failed/stale polling, an expired unfinished run, a failed run,
  suspended or cooling-down destinations, or an old pending delivery.
- `unknown`: no completed health observations yet, an unchecked feed, or a new
  destination that has not established its baseline.
- `disabled`: this checkout's feed list is empty. This describes the selected
  configuration, not proof that a deployed Worker has stopped.

Feed failure reasons are bounded categories such as `http`, `timeout`, or
`parse_error`. A successful check clears the current failure count while
retaining the historical failure timestamp. Last success is recorded atomically
with ledger ingestion; fetch success followed by a database failure does not
advance it. A completed run can still contain a failed feed check, so the report
checks both the run heartbeat and each feed's health.

The output includes pending counts and oldest pending age for active routes,
alongside destination suspension/cooldown state. Removed routes are excluded;
their retained pending deliveries resume if the same configuration is restored.
Feed indices identify entries in `feeds.json`. Only hostnames are printed;
feed paths/query strings, webhook URLs, fingerprints, and message payloads are
not included.

## Thresholds and scripting

The default cron interval is one minute. A run is stale after the greater of
five minutes or three cron intervals. With N feeds, each feed is stale after
the greater of five minutes or three complete rotations. A backlog becomes
stale after the greater of thirty minutes or that feed threshold. These are
operational signals, not delivery guarantees; cooldowns may legitimately last
longer.

If the deployed cron interval changes, supply its interval in minutes:

```sh
npm run status -- --remote --interval-minutes 5
```

For machine-readable output:

```sh
npm run --silent status -- --remote --json
```

JSON timestamps are Unix milliseconds; ages and thresholds are milliseconds.
The query uses database time rather than the inspecting machine's clock.
Exit codes are `0` for healthy/disabled, `1` for degraded/unknown, and `2` for
usage, authentication, query, or missing-schema errors. The command suppresses
raw remote error text and never prints a webhook secret.

The command reads D1 when requested; it does not install an alerting service.
Use Cloudflare's Worker metrics separately for CPU limits and invocation errors.
