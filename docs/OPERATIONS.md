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

## First deployment from the CLI

Use Node.js 26.13.0 and npm 11.20.0, as recorded in `.node-version` and
`package.json`. See [development](DEVELOPMENT.md) for the supported versions.
Clone the repository you control (fork syndicord first if needed), then install
and validate the checkout **before creating or changing cloud resources**:

```sh
git clone YOUR_REPOSITORY_URL syndicord
cd syndicord
npm ci
npm run check
```

The full check runs without Cloudflare or Discord credentials. Stop and fix any
failure before continuing. Review `feeds.json`; its initial feed sends this
repository's commit updates to the destination named `updates`. Replace the
feed URL if you want to follow a different repository or feed.

The following steps create or change metered Cloudflare resources, including
when expected usage fits the free plan. An existing syndicord installation
uses its current Worker and database; skip creation and reuse its database ID.
Do not recreate the delivery ledger.

1. Create a Discord webhook in the destination channel under **Edit Channel →
   Integrations → Webhooks**. Save the complete destination mapping in the
   shared password-manager item. For the initial feed, the JSON is:

   ```json
   { "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN" }
   ```

   Replace the placeholders with the copied URL. Keep this mapping available
   to the operators; it is the authoritative copy for later additions and
   rotation. Every name used in `feeds.json` needs a matching entry.

2. Sign in and select the Cloudflare account that owns the installation:

   ```sh
   npx cf auth login
   npx cf auth whoami
   export CLOUDFLARE_ACCOUNT_ID='your-account-id'
   ```

   Copy the intended account ID from the `whoami` output into the export.

3. Create the D1 database and export the ID returned by the command:

   ```sh
   npx cf d1 create --name syndicord
   export SYNDICORD_DATABASE_ID='the-returned-database-uuid'
   npx cf d1 migrations apply "$SYNDICORD_DATABASE_ID" --dir migrations
   ```

   Migrations target the hosted database. Local development uses `--local`
   instead. Keep the database ID for subsequent deployments and GitHub setup.

4. Deploy the project and its initial secret together. Run this block from the
   repository; it explicitly starts **Bash**, so it also works when your usual
   shell is zsh. At the hidden prompt, paste the complete mapping from the
   shared password-manager item **on one line**, then press Enter:

   ```sh
   bash <<'BASH'
   set +x
   set -euo pipefail
   read -r -s -p 'Paste the WEBHOOKS JSON on one line: ' syndicord_webhooks </dev/tty
   printf '\n' >/dev/tty
   syndicord_secrets="$(printf '%s' "$syndicord_webhooks" | node --input-type=module -e '
     import feeds from "./feeds.json" with { type: "json" };
     import { loadConfig } from "./src/config.ts";
     try {
       let value = "";
       for await (const chunk of process.stdin) value += chunk;
       JSON.parse(value);
       loadConfig(feeds, value);
       process.stdout.write(JSON.stringify({ WEBHOOKS: value }));
     } catch {
       console.error("Invalid WEBHOOKS JSON or destination configuration.");
       process.exitCode = 1;
     }
   ')"
   printf '%s' "$syndicord_secrets" | npm run deploy -- --secrets-file /dev/stdin
   BASH
   ```

   The prompt does not echo the value or put it in shell history. The wrapper
   validates the mapping before starting deployment and sends the CLI its
   required outer secrets JSON through standard input. The secret passes
   through process memory and the pipe; no production secret file is created.

   `cf deploy` creates the Worker named `syndicord`, uploads `WEBHOOKS` with
   its code, binds the existing D1 database, and installs the cron schedule.
   There is no dashboard Worker-creation step. The secret is present when the
   schedule starts. `--no-provision` prevents creation of missing bindings;
   public and preview URLs are disabled.

5. [Verify the first baseline and a new delivery](#verify-the-first-deployment)
   before enabling automatic deployment. For later manual code deployments,
   run `npm ci` after pulling dependency changes, `npm run check`, apply any
   outstanding migrations, and run `npm run deploy` with the same exported
   IDs. Existing hosted secrets are preserved; the initial secret-input block
   is needed only when creating the Worker or intentionally replacing its map.

## Enable automatic deployment

Complete and verify the CLI installation first. Then configure GitHub so
future changes use the hosted secret and no operator's local secret file.

1. Create a Cloudflare API token scoped to the deployment account with
   **Account → Workers Scripts → Edit** and **Account → D1 → Edit**. The token
   needs Worker deployment, settings, secret-name reads, and D1 migration
   access. This application has no domain routes and needs no zone permissions.
   Store the token in GitHub, not in the repository or a production dotenv file.

2. In GitHub, open **Settings → Environments**, create `production`, and restrict
   its deployment branches to `main`. Add secret `CLOUDFLARE_API_TOKEN` and
   variables `CLOUDFLARE_ACCOUNT_ID` and `SYNDICORD_DATABASE_ID`, using the IDs
   from the working installation. Required reviewers pause each deployment for
   approval; omit that rule when pushes to `main` should deploy automatically.

3. Once the workflow is on `main`, open **Actions → CI → Run workflow**, select
   `main`, and run it to check the setup. Every push to `main` then checks,
   applies outstanding schema migrations, and deploys automatically.

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

## Verify the first deployment

Start a live tail and leave it running while the cron polls:

```sh
npx cf observability tail --worker syndicord
```

1. Wait for `feed_checked` followed by `relay_complete`. Each new
   feed/destination pair starts with a silent baseline: entries already in the
   feed should **not** produce Discord messages. A failed fetch or parse does
   not establish that baseline.
2. After that baseline, publish a new entry in a feed you control. For the
   configured GitHub commit feed, push or merge a new commit to that
   repository's default branch. Wait for its next scheduled check; with N
   configured feeds, each is checked approximately every N minutes.
3. Confirm a `delivery_sent` event and exactly one message in every configured
   destination. Check that its feed name, title, link, and excerpt are correct.
4. Wait through further checks of the same feed. The entry should not be sent
   again. If delivery fails, use the recovery guidance below and inspect the
   pending records rather than deleting deduplication state.

A successful cron invocation alone does not prove successful feed polling or
Discord delivery. Check CPU time and invocation errors in Cloudflare's Worker
metrics; local checks cannot prove that the actual feeds fit the hosted runtime
budget.

To inspect delivery counts without reading message payloads, use the database
ID retained from setup (and recorded in the GitHub environment after enabling
automatic deployment):

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
