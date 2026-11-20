# Troubleshooting and recovery

See [setup](SETUP.md) for the first-delivery check, [operations](OPERATIONS.md)
for feeds and webhooks, and [deployment](DEPLOYMENT.md) for CI configuration.

Select the installation as described in
[operations](OPERATIONS.md#select-an-installation). For optional GitHub
deployment commands, also select its repository:

```sh
export GH_REPO='YOUR_OWNER/YOUR_REPOSITORY'
```

## Inspect a run

```sh
npm run syndicord -- cf observability tail --worker "$SYNDICORD_WORKER_NAME"
```

| Event                   | Meaning / action                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `feed_failed`           | Fetch or parse failed. The log gives the zero-based index in `npm run syndicord -- feeds get` and a sanitized reason; the baseline is unchanged. |
| `relay_busy`            | Another invocation owns the lease. After a terminated run, the lease expires within two minutes.                                                 |
| `delivery_deferred`     | Delivery will retry with backoff, from one minute to six hours, or a longer delay requested by Discord.                                          |
| `destination_suspended` | Discord returned 401, 403, or 404. Repair or replace the webhook.                                                                                |

Discord rate limits affect the destination, or all destinations for a global
limit. Pending deliveries remain available after fetch or delivery failures.

To inspect hosted delivery counts without reading message payloads:

```sh
export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
npm run syndicord -- cf d1 raw "$SYNDICORD_DATABASE_ID" --sql 'SELECT destination, state, COUNT(*) AS count FROM relay_deliveries GROUP BY destination, state'
```

Add `--local` to inspect local development state instead.

## Resume a suspended destination

[Replace its webhook](OPERATIONS.md#update-webhooks-without-deploying) in the
hosted secret and update its backup. A changed URL clears suspension and its
destination cooldown on the next poll; pending entries retain their retry times.

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
npm run syndicord -- cf d1 raw "$SYNDICORD_DATABASE_ID" --sql @resume.sql
```

Do not delete baseline or sent identity rows to retry delivery: that can send
old entries again. Pending records already retain the content needed to retry.

## Failed deployment

If an upload or readback was ambiguous, inspect the active deployment before
retrying; uploading can succeed before a later step fails:

```sh
npm run syndicord -- cf workers deployments list --worker "$SYNDICORD_WORKER_NAME"
```

Check the reported error and `npm run syndicord -- feeds get`. Missing
configuration must be supplied before upload; see [upgrading](UPGRADING.md) for
bundled-feed installations. Applied migrations stay in place after an upload
failure. Once the cause is resolved, retry from your checkout:

```sh
npm run deploy
```

A conflict with dashboard-managed Worker settings stops deployment. Inspect and
reconcile it before retrying; do not suppress an unexplained conflict with
`--force`. Operators using a custom source build keep their intended runtime
settings in `cloudflare.config.ts`. Hosted feeds and secrets are preserved.

For optional GitHub deployment, inspect the failed run instead of uploading a
local checkout, replacing `FAILED_RUN_ID` with its numeric ID:

```sh
gh run view FAILED_RUN_ID --log-failed
```

After checking the active deployment and addressing the failure, start CI for
current `main`:

```sh
gh workflow run check.yml --ref main
gh run list --workflow check.yml --branch main --event workflow_dispatch --limit 5
```

Use the new run's numeric ID to follow it and inspect the deployment summary:

```sh
gh run watch NEW_RUN_ID --exit-status
gh run view NEW_RUN_ID --web
```

## Pause and roll back

Save the current feed configuration first:

```sh
npm run syndicord -- feeds get > .feeds.json
```

Create `.feeds-paused.json` containing `[]`, then pause polling and delivery:

```sh
npm run syndicord -- feeds set --file .feeds-paused.json
```

Allow any running invocation to finish. No code deployment is needed. Restore
the saved list when ready:

```sh
npm run syndicord -- feeds set --file .feeds.json
```

If GitHub manages deployments, disable the workflow and wait for any active run
to finish before a manual rollback:

```sh
gh workflow disable check.yml
gh run list --workflow check.yml --limit 5
```

For a code rollback, check out the intended revision, run `npm ci`, and run
`npm run deploy`. For the npm-installed CLI, install the intended Git ref using
`npm install github:vhata/syndicord#COMMIT_OR_TAG` in its installation
directory, then run `npx --no-install syndicord deploy`. Cloudflare's
**Deployments → Rollback** also selects an earlier Worker version. A Worker
rollback reverses neither D1 migrations, stored routing, nor Discord messages. A
version that bundles feeds uses its own historical configuration; inspect that
list before rolling back to it.

Prefer reverting the faulty code commit and deploying the revert. Resume CI when
`main` contains the code you intend to deploy:

```sh
gh workflow enable check.yml
gh workflow run check.yml --ref main
```

## Restore D1

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
retains seven days on Workers Free. A restore overwrites the database. Disable
the Worker's cron trigger in Cloudflare, prevent concurrent code deployments,
and allow running invocations to finish before recording the current restore
point and restoring D1. A pause stored as `[]` is insufficient: restoring D1
also restores the old feed configuration. Inspect the restored configuration and
ledger before restoring the cron trigger. Restoring an older ledger can forget
successful sends and produce duplicate Discord messages. Inspect pending
deliveries before resuming; practise recovery on an isolated database before
relying on it. CI never restores or resets D1 automatically.

[Worker rollback reference](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
