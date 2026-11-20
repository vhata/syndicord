# First deployment

A syndicord installation consists of a Worker, its D1 database, and its encrypted
`WEBHOOKS` secret. Feeds and routing live in D1. No Git checkout or GitHub
repository is required to run or configure it.

## Install the CLI

Use Node.js 26.12 or newer in the 26.x line and npm 11. Install a syndicord
package tarball:

```sh
npm install --global /path/to/syndicord-0.0.0.tgz
syndicord --help
```

To build a tarball from source, see [package development](DEVELOPMENT.md#build-a-package).
Installing the package does not create any Cloudflare resources.

## Select an installation

Sign in and select the account ID shown by `whoami`:

```sh
syndicord cf auth login
syndicord cf auth whoami
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
```

Use a different Worker name for another installation in the same account.
Each independent installation needs its own D1 database. Account, Worker, and
database selection are operational settings; they contain no feed or destination
configuration.

## Create the database and configure feeds

The following steps create metered Cloudflare resources; usage may fit the free
plan. For an existing installation, reuse its database ID and skip creation.

```sh
syndicord cf d1 create --name "$SYNDICORD_WORKER_NAME"
export SYNDICORD_DATABASE_ID='the-returned-database-uuid'
syndicord migrate
```

Create `.feeds.json` with the feeds and destination names for this installation:

```json
[
  {
    "url": "https://example.com/feed.xml",
    "destinations": ["updates"]
  }
]
```

For the first-delivery check, choose a feed you can publish to, such as your own
repository's commit feed. Upload the configuration:

```sh
syndicord feeds set --file .feeds.json
```

This stores the configuration in D1. The local file is just input; the service
never reads it. An explicit `[]` configures an installation with polling disabled.

## Configure webhooks and deploy

Create a webhook in Discord under the channel's **Edit Channel → Integrations →
Webhooks**. Create `.webhooks.json` with the complete destination mapping:

```json
{
  "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN"
}
```

Every destination used by a feed needs an entry. Deploy the packaged Worker:

```sh
syndicord deploy --webhooks-file .webhooks.json
```

Deployment applies outstanding migrations, checks that feed configuration exists,
creates the Worker, uploads its secret, binds D1, and installs the cron schedule.
Public and preview URLs are disabled. The secret is present before polling starts.

Cloudflare is the authority for live configuration. Keep a backup of the complete
webhook mapping in a shared password manager: Cloudflare does not return encrypted
secret values. Delete the temporary files when finished. Keep the three
installation identifiers for future CLI use.

## Verify delivery

Start a live tail:

```sh
syndicord cf observability tail --worker "$SYNDICORD_WORKER_NAME"
```

1. Wait for `feed_checked` and `relay_complete`. Existing entries should produce
   **no messages**: the first successful poll establishes a silent baseline.
2. Publish a new entry in the feed you control.
3. Wait for `delivery_sent` and one message in each configured destination.
   Check the feed name, title, link, and excerpt.
4. Let the same feed be checked again and confirm the entry is not resent.

Run `syndicord status` to inspect the installation's recorded health and backlog.
One feed is checked each minute, rotating through the stored list. A successful
cron invocation alone does not prove delivery; also inspect CPU time and errors
in Cloudflare's Worker metrics. Local tests do not establish hosted CPU headroom.

Use [operations](OPERATIONS.md) for configuration changes and
[recovery](RECOVERY.md) for failures. To update code, install the new package and
run `syndicord deploy` with the same identifiers; stored feeds and webhook secrets
are preserved. [Automatic deployment from GitHub](DEPLOYMENT.md) is optional.
