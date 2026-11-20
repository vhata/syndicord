# First deployment

A syndicord installation consists of a Worker, its D1 database, and its
encrypted `WEBHOOKS` secret. Feeds and routing live in D1. No Git checkout or
GitHub repository is required to run or configure it.

## Run from the repository

Use Node.js 26.12 or newer in the 26.x line and npm 11:

```sh
git clone https://github.com/vhata/syndicord.git
cd syndicord
npm ci
npm run check
npm run syndicord -- --help
```

Run the commands below from this checkout. `npm run syndicord --` invokes the
CLI directly from source, and `npm run deploy` builds the current Worker before
applying migrations and deploying. No global CLI installation is required. These
installation and validation steps do not create Cloudflare resources.

### Optional npm installation

To use the CLI without a source checkout, install it through npm from GitHub.
Run this in a directory of your choice outside the syndicord repository:

```sh
npm install github:vhata/syndicord
npx --no-install syndicord --help
```

This uses npm's Git package support and requires Git during installation. npm
builds the CLI and Worker during installation. Run the installed CLI from that
directory with `npx --no-install syndicord`; it needs no retained source
checkout.

The same operations are available through either entry point:

| From the checkout                                  | npm-installed CLI                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run syndicord -- feeds get`                   | `npx --no-install syndicord feeds get`                             |
| `npm run deploy -- --webhooks-file .webhooks.json` | `npx --no-install syndicord deploy --webhooks-file .webhooks.json` |
| `npm run deploy`                                   | `npx --no-install syndicord deploy`                                |

The examples below use the checkout commands. The repository's `.npmrc`
suppresses npm's script banners so JSON output can be piped directly to `jq`.

## Select an installation

Sign in and select the account ID shown by `whoami`:

```sh
npm run syndicord -- cf auth login
npm run syndicord -- cf auth whoami
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
```

Use a different Worker name for another installation in the same account. Each
independent installation needs its own D1 database. Account, Worker, and
database selection are operational settings; they contain no feed or destination
configuration.

## Create the database and configure feeds

The following steps create metered Cloudflare resources; usage may fit the free
plan. For an existing installation, reuse its database ID and skip creation.

```sh
npm run syndicord -- cf d1 create --name "$SYNDICORD_WORKER_NAME"
export SYNDICORD_DATABASE_ID='the-returned-database-uuid'
npm run syndicord -- migrate
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
npm run syndicord -- feeds set --file .feeds.json
```

This stores the configuration in D1. The local file is just input; the service
never reads it. An explicit `[]` configures an installation with polling
disabled.

## Configure webhooks and deploy

For an existing Worker,
[update webhooks without deploying](OPERATIONS.md#update-webhooks-without-deploying).
The steps below create the Worker with its initial webhook secret.

Create a webhook in Discord under the channel's **Edit Channel → Integrations →
Webhooks**. Create `.webhooks.json` with the complete destination mapping:

```json
{
  "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN"
}
```

Every destination used by a feed needs an entry. Deploy the Worker:

```sh
npm run deploy -- --webhooks-file .webhooks.json
```

From a checkout, deployment first builds the current source. The npm-installed
CLI uses the Worker built during npm installation. Both apply outstanding
migrations and check that feed configuration exists. It creates the Worker,
uploads its secret, binds D1, and installs the cron schedule. Public and preview
URLs are disabled. The secret is present before polling starts.

Cloudflare is the authority for live configuration. Keep a backup of the
complete webhook mapping in a shared password manager: Cloudflare does not
return encrypted secret values. Delete the temporary files when finished. Keep
the three installation identifiers for future CLI use.

## Verify delivery

Start a live tail:

```sh
npm run syndicord -- cf observability tail --worker "$SYNDICORD_WORKER_NAME"
```

1. Wait for `feed_checked` and `relay_complete`. Existing entries should produce
   **no messages**: the first successful poll establishes a silent baseline.
2. Publish a new entry in the feed you control.
3. Wait for `delivery_sent` and one message in each configured destination.
   Check the feed name, title, link, and excerpt.
4. Let the same feed be checked again and confirm the entry is not resent.

Run `npm run syndicord -- status` to inspect the installation's recorded health
and backlog. One feed is checked each minute, rotating through the stored list.
A successful cron invocation alone does not prove delivery; also inspect CPU
time and errors in Cloudflare's Worker metrics. Local tests do not establish
hosted CPU headroom.

Use [operations](OPERATIONS.md) for configuration changes and
[recovery](RECOVERY.md) for failures. To update code, pull the desired revision,
run `npm ci` and `npm run check`, then run `npm run deploy` with the same
identifiers. Stored feeds and webhook secrets are preserved. For an npm CLI
installation, repeat the npm installation command to update it, then run
`npx --no-install syndicord deploy`.
[Automatic deployment from GitHub](DEPLOYMENT.md) is optional.
