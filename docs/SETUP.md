# Set up an installation

**For the installation owner setting up a new installation.** If someone has
already set it up, ask them for a link to the web editor and start with
[Manage feeds and channels](USAGE.md).

You need a Cloudflare account, permission to manage roles and webhooks in your
Discord server, and Node.js 26.12 or newer in the 26.x line with npm 11. An
installation is one **Worker** (the running service) and one **D1 database**
(feeds, encrypted webhook URLs, routing, and delivery history).

Discord delivery uses channel webhooks, so you do not invite or authorize a bot
on your server. [Discord sign-in](DISCORD_SIGN_IN.md) uses an OAuth application
to check members' roles. You choose which roles can edit feeds and channels,
then grant or revoke people's access by managing those roles in Discord.

Follow the steps below in order. GitHub automatic deployment is optional; you do
not need your own repository to host syndicord.

## Run from the repository

```sh
git clone https://github.com/vhata/syndicord.git
cd syndicord
npm ci
npm run syndicord -- --help
```

These commands install and build the CLI and Worker locally; they do not create
Cloudflare resources. The examples below use `npm run syndicord --` from this
checkout. For local checks and code contributions, see
[development](DEVELOPMENT.md).

### Optional npm installation

To use syndicord from any directory without a retained source checkout, first
build its installable package:

```sh
npm pack github:vhata/syndicord
```

Install the `.tgz` file named in the output, replacing `FILENAME.tgz` below:

```sh
npm install --global ./FILENAME.tgz
npx syndicord --help
```

npm's Git package support requires Git. Packing builds the CLI and Worker in
npm's temporary checkout before the global install. This avoids npm 11's
[global Git preparation bug](https://github.com/npm/cli/issues/8440). After a
successful installation, you can delete the `.tgz` file. Substitute these
commands throughout the guides:

| From the checkout                | npm-installed CLI         |
| -------------------------------- | ------------------------- |
| `npm run syndicord -- feeds get` | `npx syndicord feeds get` |
| `npm run deploy`                 | `npx syndicord deploy`    |

`npx syndicord` uses the installed CLI. Files supplied with `--file` are
resolved from your current directory. The checkout's `.npmrc` suppresses npm
script banners so command output remains usable as JSON.

## Select an installation

Sign in to Cloudflare:

```sh
npm run syndicord -- cf auth login
npm run syndicord -- cf auth whoami
```

Copy the account ID from `whoami`, or open the
[Cloudflare Dashboard](https://dash.cloudflare.com/), select your account, and
use **Search → Copy account ID**
([account-ID help](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)).
Choose a Worker name and keep these values in your terminal:

```sh
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
```

Use a distinct Worker name and database for each independent installation. These
identifiers select infrastructure; they do not contain feed configuration.

## Create the database and deploy

**This creates metered Cloudflare resources; usage may fit the free plan.** For
an existing installation, reuse its database ID and skip creation.

The dashboard links below open Cloudflare for your signed-in account. If
prompted, sign in and choose the account for this installation.

Choose one way to create the database
([Cloudflare's D1 guide](https://developers.cloudflare.com/d1/get-started/) has
more detail):

- **Cloudflare Dashboard:** Open
  [**D1 SQL database**](https://dash.cloudflare.com/?to=/:account/workers/d1),
  then choose **Create Database**. Name it `syndicord` (or your chosen Worker
  name), and copy its UUID from the database's page.
- **CLI:** Run:

  ```sh
  npm run syndicord -- cf d1 create --name "$SYNDICORD_WORKER_NAME"
  ```

Then set the database ID and deploy from your terminal:

```sh
export SYNDICORD_DATABASE_ID='your-database-uuid'
npm run deploy
```

Deployment applies migrations, binds the database, and installs the polling
schedule. It builds current source in a checkout or uses the bundled Worker in
an npm installation. The dashboard can create the database, but syndicord's CLI
handles its code, migrations, and bindings together.

The fresh service has no feeds and stays idle until you configure it. Before
continuing, open
[**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages),
select your Worker, then open **Domains** and copy its HTTPS `workers.dev`
address. Save it as **Worker URL** in a password-manager entry for this
installation, alongside the account ID, Worker name, and database ID. You will
use this address next to register Discord sign-in and open the feed editor. The
[sign-in guide](DISCORD_SIGN_IN.md#find-and-keep-your-worker-address) shows how
to find it again, including a CLI option.

## Enable configuration access

Next, follow [Discord sign-in and access](DISCORD_SIGN_IN.md). It walks you
through collecting the Discord application credentials, choosing who can edit,
and saving the settings on your Worker. Keep using the same password-manager
entry for those values and the encryption key generated there.

That guide ends by sending you to [Manage feeds and channels](USAGE.md) to
create a destination webhook and add your first feed in the browser or CLI. For
the delivery check below, use a feed you can publish to, such as your own
repository's commit feed. Save the webhook URL in your password manager too;
saved URLs are never returned by either client.

**After adding your feed and destination, return here to verify delivery.**

## Verify delivery

Watch the Worker using either method:

- **Cloudflare Dashboard:** Open
  [**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages),
  select your Worker, then open **Logs → Live**
  ([real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)).
- **CLI:** Start a live tail:

  ```sh
  npm run syndicord -- cf observability tail --worker "$SYNDICORD_WORKER_NAME"
  ```

1. Wait for `feed_checked` and `relay_complete`. Existing entries should produce
   **no messages**: the first successful poll establishes a silent baseline.
2. Publish a new entry in your feed.
3. Wait for `delivery_sent` and one message per destination. Check its feed
   name, title, link, and excerpt.
4. Let that feed be checked again and confirm the entry is not resent.

One feed is checked per minute, rotating through the list. Inspect recorded
health with `npm run syndicord -- status`; [status](STATUS.md) explains the
report. A successful cron invocation alone does not prove delivery.

For invocation outcomes and CPU time, use **your Worker → Metrics**, or the live
tail's `$workers` fields (`outcome`, `cpuTimeMs`, `wallTimeMs`). Missing or
sampled logs do not prove health, and local tests do not establish hosted CPU
headroom. If something fails, use [Troubleshooting and recovery](RECOVERY.md).

## Update the installation

For a checkout, pull the desired revision, then:

```sh
npm ci
npm run check
npm run deploy
```

For an npm installation, repeat the
[packing and global-install steps](#optional-npm-installation), then run
`npx syndicord deploy`. Keep the same account, Worker, and database identifiers.
Deployments preserve feeds, webhook URLs, and Worker secrets. You can also
enable [Automatic deployment from GitHub](GITHUB_DEPLOYMENT.md).
