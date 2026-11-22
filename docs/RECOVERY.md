# Troubleshooting and recovery

**For installation operators.** Start with [status](STATUS.md), then follow the
row that matches the symptom. Everyday feed edits are in
[manage feeds and channels](OPERATIONS.md).

| Symptom or task                          | Start here                                                            |
| ---------------------------------------- | --------------------------------------------------------------------- |
| No messages just after adding a feed     | [Verify delivery](SETUP.md#verify-delivery): the first poll is silent |
| Sign-in or access denied                 | [Sign-in troubleshooting](WEB.md#troubleshooting-and-acceptance)      |
| Feed errors, delays, or missing messages | [Inspect a run](#inspect-a-run)                                       |
| Destination suspended                    | [Resume a destination](#resume-a-suspended-destination)               |
| Deploy failed or its outcome is unclear  | [Failed deployment](#failed-deployment)                               |
| Stop sends or return to earlier code     | [Pause and roll back](#pause-and-roll-back)                           |
| Recover lost or damaged data             | [Restore D1](#restore-d1)                                             |

Select the installation as described in
[Cloudflare operations](OPERATIONS.md#select-a-cloudflare-installation). Feed
and webhook commands also need the
[configuration API selection](OPERATIONS.md#select-an-installation). For
optional GitHub deployment commands, select its repository:

```sh
export GH_REPO='YOUR_OWNER/YOUR_REPOSITORY'
```

## Inspect a run

**Cloudflare Dashboard:** Open **Workers & Pages → your Worker → Logs → Live**.
Use **Metrics** to check invocation failures and CPU time.
[Cloudflare live-log reference](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)

**CLI:** Stream events from the same Worker:

```sh
npm run syndicord -- cf observability tail --worker "$SYNDICORD_WORKER_NAME"
```

| Event                   | Meaning / action                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `feed_failed`           | Fetch or parse failed. The log gives the relay feed index and a sanitized reason; the baseline is unchanged. |
| `relay_busy`            | Another invocation owns the lease. After a terminated run, the lease expires within two minutes.             |
| `delivery_deferred`     | Delivery will retry with backoff, from one minute to six hours, or a longer delay requested by Discord.      |
| `destination_suspended` | Discord returned 401, 403, or 404. Repair or replace the webhook.                                            |

Discord rate limits affect the destination, or all destinations for a global
limit. Pending deliveries remain available after fetch or delivery failures.

Feed indices refer to the zero-based active route list, not catalog IDs. In
single-role mode, inspect it with `npm run syndicord -- feeds get`. In scoped
mode, an operator can inspect `relay_configuration` in **Cloudflare → Storage &
databases → D1 → your database → Console**: `feeds` contains the active route
list; `catalog` maps source URLs and each destination's `deliveryKey` to catalog
IDs and labels. These fields can contain private feed URLs; do not share their
raw contents. Scoped list commands intentionally hide source URLs and do not
expose delivery keys.

To inspect hosted delivery counts without reading message payloads, run this SQL
in that D1 console, or use the CLI command below:

```sql
SELECT destination, state, COUNT(*) AS count
FROM relay_deliveries GROUP BY destination, state;
```

```sh
export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
npm run syndicord -- cf d1 raw "$SYNDICORD_DATABASE_ID" --sql 'SELECT destination, state, COUNT(*) AS count FROM relay_deliveries GROUP BY destination, state'
```

Add `--local` to inspect local development state instead.

## Resume a suspended destination

[Rotate the webhook](OPERATIONS.md#change-or-remove-something) in scoped mode,
or [replace its URL](OPERATIONS.md#add-or-change-webhooks) in single-role mode,
and update its backup. A changed URL clears suspension and its destination
cooldown on the next poll; pending entries retain their retry times.

If you repaired permissions without changing the URL, save this as `resume.sql`,
replacing `updates` with the exact **Destination** key printed by `status`. For
scoped catalogs this is a delivery key, not necessarily its label or ID:

```sql
UPDATE relay_destinations
SET suspended = 0, cooldown_until_ms = 0
WHERE destination = 'updates';

UPDATE relay_deliveries
SET next_attempt_ms = 0
WHERE destination = 'updates' AND state = 'pending';
```

**Cloudflare Dashboard:** Run the two statements under **Storage & databases →
D1 → your database → Console**. **CLI:** Apply the same file to that database:

```sh
npm run syndicord -- cf d1 raw "$SYNDICORD_DATABASE_ID" --sql @resume.sql
```

Do not delete baseline or sent identity rows to retry delivery: that can send
old entries again. Pending records already retain the content needed to retry.

## Failed deployment

After uploading, both the CLI and CI check the active version up to six times,
waiting two seconds between checks while Cloudflare's metadata catches up. These
checks only read metadata; they never repeat the upload or migrations. If
verification still fails, the error includes the last observed version ID when
available, without printing remote annotations or secret values.

If an upload or readback was ambiguous, inspect the active deployment before
retrying; uploading can succeed before a later step fails. In the Cloudflare
dashboard, open **Workers & Pages → your Worker → Deployments** and inspect the
active version and traffic allocation. In the CLI:

```sh
npm run syndicord -- cf workers deployments list --worker "$SYNDICORD_WORKER_NAME"
```

Take the `version_id` from the latest deployment, then inspect its annotation:

```sh
npm run syndicord -- cf workers versions get VERSION_ID --worker "$SYNDICORD_WORKER_NAME"
```

For CI, `annotations["workers/message"]` should be `syndicord commit` followed
by the run's full commit SHA. The latest deployment must route 100% of traffic
to that version. A successful upload followed by failed verification does not
mean the previous code is still running.

Check the reported error. Applied migrations stay in place after an upload
failure, and deployments preserve the stored configuration. Once the cause is
resolved, retry from your checkout:

```sh
npm run deploy
```

A conflict with dashboard-managed Worker settings stops deployment. Inspect and
reconcile it before retrying; `cf workers versions get` above shows the active
version's configuration. Do not suppress an unexplained conflict with `--force`.
Operators using a custom source build keep their intended runtime settings in
`cloudflare.config.ts`. Hosted feeds and secrets are preserved.

For optional GitHub deployment, inspect the failed run in **GitHub → Actions →
CI → failed run → failed job**, or use the CLI below with its numeric ID. Repair
and rerun that workflow instead of uploading a local checkout:

```sh
gh run view FAILED_RUN_ID --log-failed
```

After checking the active deployment and addressing the failure, start CI for
current `main`: in **Actions → CI → Run workflow**, select **main**, or run:

```sh
gh workflow run check.yml --ref main
gh run list --workflow check.yml --branch main --event workflow_dispatch --limit 5
```

Use the new run's numeric ID to follow it and inspect the deployment summary:

```sh
gh run watch NEW_RUN_ID --exit-status
gh run view NEW_RUN_ID --log
```

Use `gh run view NEW_RUN_ID --web` if you prefer the browser summary.

## Pause and roll back

For scoped catalogs, save `subscriptions list` and remove the relevant
subscriptions through the editor or
`subscriptions remove FEED_ID DESTINATION_ID`. Restore them with
`subscriptions add FEED_ID DESTINATION_ID`. Each destination requires its own
authorized administrator; removing all subscriptions pauses relay work.
Operators can also pause the Worker cron in Cloudflare’s dashboard. Do not use
the whole-configuration commands below for scoped catalogs.

For single-role installations, save the current feed configuration first:

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
to finish before a manual rollback. In **Actions → CI**, use the **…** menu's
**Disable workflow**, then inspect the run list; or run:

```sh
gh workflow disable check.yml
gh run list --workflow check.yml --limit 5
```

For a code rollback, check out the intended revision, run `npm ci`, and run
`npm run deploy`. For the npm-installed CLI, prepare the intended Git ref using
`npm pack github:vhata/syndicord#COMMIT_OR_TAG`, install the resulting `.tgz`
with `npm install --global ./FILENAME.tgz`, then run `npx syndicord deploy`.
Cloudflare's **Deployments → Rollback** also selects an earlier Worker version.
A Worker rollback reverses neither D1 migrations, stored routing, nor Discord
messages. Check that the selected version can read the current database schema.

Prefer reverting the faulty code commit and deploying the revert. Resume CI when
`main` contains the code you intend to deploy: choose **Enable workflow**, then
**Run workflow** on **main** in Actions, or run:

```sh
gh workflow enable check.yml
gh workflow run check.yml --ref main
```

## Restore D1

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
retains seven days on Workers Free and thirty days on Workers Paid. A restore
overwrites the database. First, in Cloudflare open **Workers & Pages → your
Worker → Settings → Triggers → Cron Triggers**. Record the current schedule,
then remove it temporarily. Prevent concurrent deployments and allow up to 15
minutes for trigger changes to propagate, plus time for running invocations to
finish. The pinned CLI has no direct cron-management command. A pause stored as
`[]` is insufficient: restoring D1 also restores the old feed configuration.

Record the current bookmark, then look up the intended restore point:

```sh
npm run syndicord -- cf d1 time-travel get-bookmark "$SYNDICORD_DATABASE_ID"
npm run syndicord -- cf d1 time-travel get-bookmark "$SYNDICORD_DATABASE_ID" \
  --timestamp 'YYYY-MM-DDTHH:MM:SSZ'
```

Save the first bookmark for undo. Review the selected historical bookmark, then
restore it:

```sh
npm run syndicord -- cf d1 time-travel restore "$SYNDICORD_DATABASE_ID" \
  --bookmark 'THE_HISTORICAL_BOOKMARK'
```

Keep the encryption key matching the restored webhook data. Inspect the restored
configuration and ledger before adding the recorded cron schedule back on the
Worker's **Cron Triggers** page. Restoring an older ledger can forget successful
sends and produce duplicate Discord messages. Inspect pending deliveries before
resuming; practise recovery on an isolated database before relying on it. CI
never restores or resets D1 automatically.

[Worker rollback reference](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
