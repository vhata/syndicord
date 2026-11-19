# Configuration and operations

## Feeds and destinations

`feeds.json` is bundled into the Worker. It contains the initial trial feed:

```json
[
  {
    "url": "https://github.com/vhata/syndicord/commits.atom",
    "destinations": ["updates"]
  }
]
```

Each feed URL appears once and has one or more destination names. Names start
with a letter and contain letters, digits, underscores, or hyphens. The limit
is 20 feed/destination pairs. An empty array disables polling and delivery.
Feed changes require a new build and deployment.

`WEBHOOKS` is a secret containing a JSON object mapping names to Discord webhook
URLs. In the ignored `.dev.vars` file:

```dotenv
WEBHOOKS='{"updates":"https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN"}'
```

Replace the placeholders with the webhook copied from Discord. URLs must use
`https://discord.com/api/webhooks/ID/TOKEN`; a numeric `thread_id` query parameter
selects an existing thread. Each destination has a distinct webhook URL.
Forum or media channels need that existing thread ID. Do not commit real URLs
or put them in command-line arguments.

To add feeds and destinations, extend `feeds.json` and the `WEBHOOKS` mapping.
For example, this sends commits to `updates` and another feed to both channels:

```json
[
  {
    "url": "https://github.com/vhata/syndicord/commits.atom",
    "destinations": ["updates"]
  },
  {
    "url": "https://example.com/feed.xml",
    "destinations": ["updates", "security"]
  }
]
```

Replace the example feed URL and add the second webhook to `.dev.vars`,
preserving the existing `updates` value:

```dotenv
WEBHOOKS='{"updates":"YOUR_EXISTING_WEBHOOK_URL","security":"YOUR_SECOND_WEBHOOK_URL"}'
```

Run `npm run check` and deploy with
`npm run deploy -- --secrets-file .dev.vars`, using the existing exported
database ID. Each new feed/destination pair records a silent baseline on its
first successful poll. Keep existing destination names when changing a webhook;
renaming a destination creates a new pair.

Each cron invocation checks one feed and attempts at most five deliveries.
Feeds rotate, including after fetch failures. With the default one-minute cron,
N feeds are each checked about every N minutes. A run stops starting deliveries
after its 30-second work budget; individual HTTP requests have six-second
deadlines. Leases and per-destination cooldowns can delay work further.

Feed responses are UTF-8 XML, at most 256 KiB and 200 entries. Redirects are
limited to three and HTTPS downgrades are rejected. Malformed XML, unsupported
document declarations, and oversized responses fail without changing a baseline.
Identity records remain in D1 indefinitely; pending payloads are cleared after
delivery. Monitor database growth for busy feeds.

See [relay behavior](BEHAVIOR.md) for first-poll baselines, entry identity,
configuration changes, and the possible duplicate after an ambiguous send.

## First deployment

These commands create or change metered Cloudflare resources. Confirm
provisioning before running them, even when expected usage fits the free plan.
The deployment needs one D1 database and one Worker with a cron trigger.

1. Install this checkout's dependencies and hooks, then run the full checks:

   ```sh
   npm ci
   npm run check
   ```

2. Populate `.dev.vars` with the destination webhooks.
3. Sign in and create the database:

   ```sh
   npx cf auth login
   npx cf d1 create --name syndicord
   ```

4. Export the database ID returned by that command and apply the schema:

   ```sh
   export SYNDICORD_DATABASE_ID='the-returned-database-uuid'
   npx cf d1 migrations apply "$SYNDICORD_DATABASE_ID" --dir migrations
   ```

   This command targets the hosted database. The local development command
   includes `--local` instead.

5. Deploy the Worker and secret together:

   ```sh
   npm run deploy -- --secrets-file .dev.vars
   ```

   The deployment script requires an exported database ID and uses
   `--no-provision`, so it does not automatically create resource bindings.
   The local placeholder database ID is only for local development.
   `workers.dev` and preview URLs are disabled.

For later deployments, run `npm ci` after pulling dependency changes and
`npm run check` before deploying. Use the same exported database ID and
secret file. Apply new migrations before deploying code that depends on them.

## Verify the trial

Watch Worker logs:

```sh
npx cf observability tail --worker syndicord
```

The first successful poll records current entries and sends nothing. Confirm
`feed_checked` and `relay_complete` events, then wait for a new commit to the
configured repository's default branch. That entry should produce one Discord
message. Further polls should leave it unchanged. Check CPU time and invocation
errors in Cloudflare's Worker metrics during the trial; local tests cannot prove
that a particular feed fits the hosted runtime budget.

Inspect delivery counts without reading message payloads:

```sh
npx cf d1 raw "$SYNDICORD_DATABASE_ID" --sql 'SELECT destination, state, COUNT(*) AS count FROM relay_deliveries GROUP BY destination, state'
```

This is a hosted read. Add `--local` to inspect local development state.

## Failures and recovery

`feed_failed` identifies the feed by its zero-based index in `feeds.json` and a
sanitized reason. Fetch and parse errors leave pending deliveries available.
`relay_busy` means another invocation owns the lease. A terminated invocation's
lease expires after two minutes.

`delivery_deferred` identifies the destination and status. Retries use
exponential backoff from one minute to six hours. A longer Discord retry delay
takes precedence. Discord rate limits apply to the whole destination, or every
destination when Discord reports a global limit.

HTTP 401, 403, or 404 suspends a destination and produces
`destination_suspended`. Correct or replace its webhook. A changed webhook URL
clears suspension and its destination cooldown on the next poll; pending
deliveries retain their retry times. If permissions were repaired without
changing the URL, resume that destination with this SQL against the appropriate
database, replacing `updates` with its name:

```sql
UPDATE relay_destinations
SET suspended = 0, cooldown_until_ms = 0
WHERE destination = 'updates';

UPDATE relay_deliveries
SET next_attempt_ms = 0
WHERE destination = 'updates' AND state = 'pending';
```

Do not delete baseline or sent identity rows to retry a delivery: forgetting
those identities can cause old entries to be sent again. Pending deliveries
already retain the content needed to retry.

## References

- [Cloudflare deployment and secrets files](https://developers.cloudflare.com/cf/projects/#deploy)
- [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Workers limits and CPU metrics](https://developers.cloudflare.com/workers/platform/limits/)
