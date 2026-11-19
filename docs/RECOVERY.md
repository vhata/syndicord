# Troubleshooting and recovery

See [setup](SETUP.md) for the first-delivery check,
[operations](OPERATIONS.md) for feeds and webhooks, and
[deployment](DEPLOYMENT.md) for CI configuration.

## Inspect a run

```sh
npx cf observability tail --worker syndicord
```

| Event                   | Meaning / action                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `feed_failed`           | Fetch or parse failed. The log gives the zero-based index in `feeds.json` and a sanitized reason; the baseline is unchanged. |
| `relay_busy`            | Another invocation owns the lease. After a terminated run, the lease expires within two minutes.                             |
| `delivery_deferred`     | Delivery will retry with backoff, from one minute to six hours, or a longer delay requested by Discord.                      |
| `destination_suspended` | Discord returned 401, 403, or 404. Repair or replace the webhook.                                                            |

Discord rate limits affect the destination, or all destinations for a global
limit. Pending deliveries remain available after fetch or delivery failures.

To inspect hosted delivery counts without reading message payloads:

```sh
export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
npx cf d1 raw "$SYNDICORD_DATABASE_ID" --sql 'SELECT destination, state, COUNT(*) AS count FROM relay_deliveries GROUP BY destination, state'
```

Add `--local` to inspect local development state instead.

## Resume a suspended destination

[Replace its webhook](OPERATIONS.md#manage-webhook-destinations) in the shared
mapping and hosted secret. A changed URL clears suspension and its destination
cooldown on the next poll; pending entries retain their retry times.

If you repaired permissions without changing the URL, save this as `resume.sql`,
replacing `updates` with the destination name:

```sql
UPDATE relay_destinations
SET suspended = 0, cooldown_until_ms = 0
WHERE destination = 'updates';

UPDATE relay_deliveries
SET next_attempt_ms = 0
WHERE destination = 'updates' AND state = 'pending';
```

Apply it to the intended hosted database:

```sh
npx cf d1 raw "$SYNDICORD_DATABASE_ID" --sql @resume.sql
```

Do not delete baseline or sent identity rows to retry delivery: that can send
old entries again. Pending records already retain the content needed to retry.

## Failed deployment

Inspect the failed GitHub run, then start CI for the current `main`:

```sh
gh run view RUN_ID --log-failed
gh workflow run check.yml --ref main
gh run list --workflow check.yml --branch main --limit 5
gh run watch RUN_ID --exit-status
```

If an upload or readback was ambiguous, check the active deployment before
retrying; uploading can succeed before a later step fails:

```sh
npx cf workers deployments list --worker syndicord
```

Keep intended configuration changes in `cloudflare.config.ts`. A conflict with
dashboard configuration stops deployment; inspect and reconcile it before
retrying. Secret-value changes are preserved. Do not suppress an unexplained
conflict with `--force`.

## Pause and roll back

To pause through Git, deploy an empty `feeds.json`. For urgent maintenance,
disable future CI runs, wait for any active deployment to finish, then remove
the Worker's cron trigger in Cloudflare. Allow running invocations to finish.

```sh
gh workflow disable check.yml
gh run list --workflow check.yml --limit 5
```

Prefer reverting a faulty commit and deploying the revert. For an immediate
code rollback, Cloudflare's **Deployments → Rollback** selects an earlier
Worker version. Keep automatic deployment disabled during a manual rollback.
A Worker rollback reverses neither D1 migrations nor Discord messages.

Restore the cron to match `cloudflare.config.ts`, then resume checked deploys:

```sh
gh workflow enable check.yml
gh workflow run check.yml --ref main
```

## Restore D1

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
retains seven days on Workers Free. A restore overwrites the database: pause
the relay and record the current restore point first. Restoring an older
ledger can forget successful sends and produce duplicate Discord messages.
Inspect pending deliveries before resuming; practise recovery on an isolated
database before relying on it. CI never restores or resets D1 automatically.

[Worker rollback reference](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
