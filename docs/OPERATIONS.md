# Configuration and operations

## Where production configuration lives

| Setting                              | Location                                                         |
| ------------------------------------ | ---------------------------------------------------------------- |
| Feed URLs and destination names      | `feeds.json` in Git                                              |
| Discord webhook URLs                 | The Worker's encrypted `WEBHOOKS` secret in Cloudflare           |
| Copy of the complete webhook mapping | A shared password-manager item accessible to the operators       |
| Cloudflare deployment token          | GitHub `production` environment secret `CLOUDFLARE_API_TOKEN`    |
| Cloudflare account ID                | GitHub `production` environment variable `CLOUDFLARE_ACCOUNT_ID` |
| D1 database ID                       | GitHub `production` environment variable `SYNDICORD_DATABASE_ID` |

Production deployment runs in GitHub Actions. It preserves the existing hosted
`WEBHOOKS` secret and does not upload a local secrets file. `.dev.vars` is only
for [local development](DEVELOPMENT.md#run-locally).

Cloudflare hides secret values after saving them. Keep the complete `WEBHOOKS`
JSON in the shared password-manager item so another operator can replace the
mapping without reconstructing it from somebody's computer. Store real webhook
URLs there and in Cloudflare, never in Git, issues, logs, or command arguments.

## One-time production setup

Provisioning the Worker and D1 database creates metered Cloudflare resources;
deployments and migrations change those resources. Confirm that setup before
running it, including when expected usage fits the free plan. An existing
syndicord installation uses its current Worker and database; do not recreate
its delivery ledger.

1. Create a D1 database named `syndicord` in the Cloudflare dashboard and record
   its database ID. For a CLI setup, install this checkout's dependencies with
   `npm ci`, sign in with `npx cf auth login`, and run:

   ```sh
   npx cf d1 create --name syndicord
   ```

2. Ensure a Worker named `syndicord` exists in the same account. For a fresh
   installation, create it through **Workers & Pages → Create application**
   using the initial Worker template. An already deployed syndicord Worker
   needs no replacement.

3. Set its `WEBHOOKS` secret as described below. Use the destination names in
   the committed `feeds.json`; the initial destination is `updates`.

4. For a fresh installation only, bootstrap the Worker once from an interactive
   terminal. Use the [project's Node/npm versions](DEVELOPMENT.md), then run:

   ```sh
   npm ci
   npm run check
   npx cf auth login
   export CLOUDFLARE_ACCOUNT_ID='your-account-id'
   export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
   npx cf d1 migrations apply "$SYNDICORD_DATABASE_ID" --dir migrations
   npm run deploy
   ```

   Review and accept the expected replacement of the initial dashboard
   template's configuration. This installs syndicord, binds D1, installs the
   schedule, and disables public and preview URLs. The hosted `WEBHOOKS` value
   is preserved; no local secret file is needed. This interactive step is
   necessary because CI refuses conflicting dashboard configuration. Do not
   add `--force` to the regular deployment workflow. Existing installations
   already deployed with this configuration skip this step.

5. Create a Cloudflare API token scoped to the deployment account with
   **Account → Workers Scripts → Edit** and **Account → D1 → Edit**. The token
   needs Worker deployment, settings, secret-name reads, and D1 migration
   access. This application has no domain routes and needs no zone permissions.
   Store the token in GitHub, not in the repository or a production dotenv file.

6. In GitHub, open **Settings → Environments**, create `production`, and restrict
   its deployment branches to `main`. Add the secret and two variables from
   the table above. Required reviewers pause each deployment for approval;
   omit that rule when pushes to `main` should deploy automatically.

7. Merge the workflow and configuration into `main`. Every subsequent push to
   `main` checks and deploys automatically. To deploy the current `main` without
   a code change, open **Actions → CI → Run workflow**, select `main`, and run it.
   Each run applies outstanding schema migrations before deploying.

Configure the environment before merging the deployment workflow. A missing
credential or ID makes the deployment job fail with setup guidance. Pull
requests run the full checks without access to production credentials and do
not deploy.

## Manage webhook destinations

A destination name is a stable routing label such as `updates` or `security`.
In Discord, open the destination channel's **Edit Channel → Integrations →
Webhooks**, create or select a webhook, and copy its URL. Each destination must
have a distinct webhook URL.

In Cloudflare, open **Workers & Pages → syndicord → Settings → Variables and
Secrets**. Add or edit a binding with type **Secret**, name `WEBHOOKS`, and this
kind of value:

```json
{
  "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
  "security": "https://discord.com/api/webhooks/OTHER_ID/OTHER_TOKEN"
}
```

Paste the JSON object itself, without `WEBHOOKS=` or surrounding shell quotes.
Replace the placeholders with real values from the shared password-manager
item. Saving replaces the **entire mapping**; retain every destination still
used by `feeds.json`. Select **Deploy** to activate the change. This creates a
new deployed Worker version with the secret change; no Git commit or CI rerun
is required. Make dashboard changes while the GitHub deployment job is idle.

Webhook URLs use `https://discord.com/api/webhooks/ID/TOKEN`. A numeric
`thread_id` query parameter selects an existing thread; forum and media
channels need that existing thread ID. Names start with a letter and contain
letters, digits, underscores, or hyphens.

- **Add a destination:** update the shared mapping and hosted `WEBHOOKS` first,
  then merge the feed routing change. Extra unused mapping entries are allowed.
- **Rotate a webhook:** replace its value under the same destination name in
  both places and deploy the secret change. Pending deliveries retain their
  identities; the next poll clears any suspension caused by the old webhook.
- **Remove a destination:** first remove it from `feeds.json` and let that change
  deploy. Then remove its mapping entry and retire the Discord webhook.
- **Rename a destination:** treat it as a new destination. It starts a new
  baseline; use the same name when the intention is only to replace a webhook.

## Add and change feeds

Edit `feeds.json`, which is bundled into the Worker. Each feed appears once and
lists the destinations that should receive its entries:

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

Replace the example URL with an RSS or Atom feed. Add any new destination to
the hosted mapping first, then open a PR with the `feeds.json` change. After
checks pass and the PR is merged, the push to `main` applies migrations and
deploys the updated routing automatically. CI cannot read hosted webhook
values, so confirm that every destination name exists in the hosted mapping.

Each new feed/destination pair records current entries silently on its first
successful poll. It sends entries that appear after that baseline. Removing a
route stops its polling/delivery work; restoring the same route resumes its
pending deliveries. An empty feed array disables polling and delivery.
The limit is 20 feed/destination pairs, so a feed sent to two destinations
uses two pairs.

Each cron invocation checks one feed and attempts at most five deliveries.
Feeds rotate, including after fetch failures. With the default one-minute cron,
N feeds are each checked about every N minutes. A run stops starting deliveries
after its 30-second work budget; individual HTTP requests have six-second
deadlines. Leases and per-destination cooldowns can delay work further.

Feed responses are UTF-8 XML, at most 256 KiB and 200 entries. Redirects are
limited to three and HTTPS downgrades are rejected. Malformed XML, unsupported
document declarations, and oversized responses fail without changing a baseline.
Identity records remain in D1 indefinitely; pending payloads are cleared after
delivery. Monitor database growth for busy feeds. See
[relay behavior](BEHAVIOR.md) for identity and retry semantics.

## Deployment and migrations

The `Deploy production` job starts only after the full `Check` job succeeds for
the same commit on `main`. It builds with the configured production database
ID and validates the build without uploading. Only the final deployment step
receives Cloudflare credentials.

One concurrency group covers migration and deployment. A new push does not
cancel a deployment already running. Superseded pending jobs may be replaced;
a stale commit is skipped before migrations and checked again before upload.
A push arriving during an upload is handled by the next serialized deployment.

The job applies outstanding files from `migrations/`, verifies that none remain,
then deploys that build with `--no-provision`. It never creates missing database
bindings. Existing hosted secrets are preserved. The job reads back the active
Worker version and checks that its commit annotation matches the expected SHA;
the GitHub run summary records both the commit and Worker version.

Migrations must be additive and compatible with the currently running Worker:
that version continues serving cron invocations until upload succeeds. Do not
edit migrations that have already run. Add a new numbered SQL file and test it
against an existing schema as well as a fresh database. An unsuccessful migration
stops the upload. A later upload failure leaves successful migrations in place;
the next run applies only migrations still outstanding. The workflow never
restores or resets D1 automatically.

If deployment fails, inspect the failed job before rerunning **CI** on `main`.
A conflict with dashboard changes fails closed; bring intended configuration
changes into `cloudflare.config.ts` before retrying. Routine secret-value edits
are preserved and are excluded from that configuration comparison. Do not add
`--force` to suppress an unexplained conflict.

If an upload or verification result is ambiguous, inspect **Cloudflare →
syndicord → Deployments** before retrying. A Worker upload may have succeeded
even if later trigger configuration or verification failed.

## Verify operation

Watch Worker logs using an authenticated Cloudflare CLI:

```sh
npx cf observability tail --worker syndicord
```

Confirm `feed_checked` and `relay_complete` events. After the first baseline,
a new entry should produce a `delivery_sent` event and one Discord message.
Check CPU time and invocation errors in Cloudflare's Worker metrics; local
checks cannot prove that the actual feeds fit the hosted runtime budget.

To inspect delivery counts without reading message payloads, export the same
non-secret database ID recorded in the GitHub environment and run:

```sh
export SYNDICORD_DATABASE_ID='your-existing-database-uuid'
npx cf d1 raw "$SYNDICORD_DATABASE_ID" --sql 'SELECT destination, state, COUNT(*) AS count FROM relay_deliveries GROUP BY destination, state'
```

This is a hosted read. Add `--local` for local development state.

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
`destination_suspended`. Correct or replace its webhook in the shared mapping
and hosted secret. A changed webhook URL clears suspension and its destination
cooldown on the next poll; pending deliveries retain their retry times. If
permissions were repaired without changing the URL, resume that destination
with this SQL against the appropriate database, replacing `updates` with its
name:

```sql
UPDATE relay_destinations
SET suspended = 0, cooldown_until_ms = 0
WHERE destination = 'updates';

UPDATE relay_deliveries
SET next_attempt_ms = 0
WHERE destination = 'updates' AND state = 'pending';
```

To pause the relay through Git, deploy an empty `feeds.json`. For urgent
maintenance, disable the GitHub **CI** workflow's automatic runs and remove the
Worker cron trigger in Cloudflare; allow any running invocation to finish.
Re-enable the workflow and restore the committed configuration through a
checked deployment when ready. If CI reports the intentionally changed cron
as a dashboard conflict, restore that cron in the dashboard before retrying.

Prefer reverting a faulty change on `main` and letting CI deploy the revert.
Cloudflare also supports selecting a previous Worker version under
**Deployments → Rollback**. Suspend automatic deployment while performing a
manual rollback so another push cannot immediately replace it. A Worker
rollback does not reverse D1 migrations or Discord messages.

D1 Time Travel is automatic, with a seven-day history on Workers Free. A
restore overwrites the database, so pause the relay first and record the
current restore point. Restoring an older ledger can forget successful sends
and produce duplicate Discord messages. Inspect pending deliveries before
resuming. Exercise recovery on an isolated database before relying on it;
restoration is not part of automatic deployment.

Do not delete baseline or sent identity rows to retry a delivery: forgetting
those identities can cause old entries to be sent again. Pending deliveries
already retain the content needed to retry.

## References

- [Cloudflare CLI in CI](https://developers.cloudflare.com/cf/ci/)
- [Cloudflare deployment](https://developers.cloudflare.com/cf/projects/#deploy)
- [Hosted Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Workers limits and CPU metrics](https://developers.cloudflare.com/workers/platform/limits/)
