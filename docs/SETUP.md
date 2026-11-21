# First deployment

A syndicord installation consists of a Worker and its D1 database. Feeds,
routing, and encrypted webhook URLs live in D1. The web interface and CLI manage
the same configuration through the Worker API. No Git checkout or GitHub
repository is required to run or configure it.

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

| From the checkout                | npm-installed CLI                      |
| -------------------------------- | -------------------------------------- |
| `npm run syndicord -- feeds get` | `npx --no-install syndicord feeds get` |
| `npm run deploy`                 | `npx --no-install syndicord deploy`    |

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

## Create the database and deploy

The following steps create metered Cloudflare resources; usage may fit the free
plan. For an existing installation, reuse its database ID and skip creation.

```sh
npm run syndicord -- cf d1 create --name "$SYNDICORD_WORKER_NAME"
export SYNDICORD_DATABASE_ID='the-returned-database-uuid'
npm run deploy
```

From a checkout, deployment builds the current source. The npm-installed CLI
uses its bundled Worker. Both apply outstanding migrations, bind D1, and install
the cron schedule. The workers.dev URL is enabled; preview URLs are disabled. A
fresh installation has no feeds, so polling remains idle until configured.

## Enable configuration access

Follow [administration setup](WEB.md#enable-administration) to set the temporary
shared password and encryption key. Choose the Cloudflare dashboard steps or CLI
commands in that guide. Keep the key in your password manager; it is needed to
read the encrypted webhook URLs in D1.

Use either client, or switch between them at any time:

- **Web interface:** open the Worker's `/admin` address, sign in with username
  `admin`, add webhook destinations and feeds, then save.
- **CLI:** [select the installation](OPERATIONS.md#select-an-installation),
  [add webhook destinations](OPERATIONS.md#add-or-change-webhooks), then
  [save the feed list](OPERATIONS.md#add-or-change-a-feed).

Create a webhook in Discord under **Edit Channel → Integrations → Webhooks** and
copy its URL. For the first-delivery check, choose a feed you can publish to,
such as your own repository's commit feed.

Save webhook URLs in your password manager before adding them. Both clients show
destination names but never return stored URLs. Keep the installation
identifiers, Worker address, password, and encryption key for future use.

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
A successful cron invocation alone does not prove delivery. Check invocation
outcomes and CPU time using either method:

- **Cloudflare Dashboard:** Open **Workers & Pages → your Worker → Metrics**.
- **CLI:** The live tail above includes invocation events with `outcome`,
  `cpuTimeMs`, and `wallTimeMs` fields under `$workers`.

Absent or sampled logs are not proof of health. Local tests do not establish
hosted CPU headroom.

Use [operations](OPERATIONS.md) for configuration changes and
[recovery](RECOVERY.md) for failures. To update code, pull the desired revision,
run `npm ci` and `npm run check`, then run `npm run deploy` with the same
identifiers. Stored feeds, webhook URLs, and Worker secrets are preserved. For
an npm CLI installation, repeat the npm installation command to update it, then
run `npx --no-install syndicord deploy`.
[Automatic deployment from GitHub](DEPLOYMENT.md) is optional.
