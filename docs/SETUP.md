# Set up an installation

This guide is for the person hosting syndicord. If someone has already set it
up, ask them for its `/admin` address and start with
[managing feeds](OPERATIONS.md).

You need a Cloudflare account, permission to manage roles and webhooks in your
Discord server, and Node.js 26.12 or newer in the 26.x line with npm 11. An
installation is one **Worker** (the running service) and one **D1 database**
(feeds, encrypted webhook URLs, routing, and delivery history).

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

Copy the account ID from `whoami`, or use
[**Cloudflare Dashboard → Search → Copy account ID**](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/).
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

Choose one way to create the database:

- **Cloudflare Dashboard:** Open **Storage & databases → D1 SQL database →
  Create Database**, name it `syndicord` (or your chosen Worker name), and copy
  its UUID from the database's page.
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

Open **Cloudflare Dashboard → Workers & Pages → your Worker** and save its HTTPS
address. The `workers.dev` address is enabled; preview URLs are disabled. The
fresh service has no feeds and stays idle until you configure it.

## Enable configuration access

Complete [Discord sign-in setup](WEB.md#enable-administration): register the
Discord application and callback, save the encryption key and OAuth settings,
and choose who can edit:

| Access model       | Use it when                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **One admin role** | Everyone with one Discord role may manage all feeds and destinations.                            |
| **Scoped roles**   | Different roles should manage the feed catalog or particular channels, including across servers. |

For scoped roles,
[configure the policy and initialize the catalog](PERMISSIONS.md#configure-access).
For either model, open `/admin`, sign in, and follow
[managing feeds](OPERATIONS.md) to add a destination and feed using the web
interface or CLI.

In Discord, create the destination webhook under **Edit Channel → Integrations →
Webhooks**. Use a feed you can publish to for the delivery check, such as your
own repository's commit feed.

Keep the account/database IDs, Worker address, Discord application credentials,
encryption key, and webhook URLs in your password manager. Saved webhook URLs
are never returned by either client; the encryption key is needed to read their
stored values.

## Verify delivery

Watch the Worker using either method:

- **Cloudflare Dashboard:** Open **Workers & Pages → your Worker → Logs → Live**
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
headroom. If something fails, use [troubleshooting](RECOVERY.md).

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
enable [automatic deployment from GitHub](DEPLOYMENT.md).

[Documentation index](README.md) · [Manage feeds](OPERATIONS.md) ·
[Cloudflare database setup](https://developers.cloudflare.com/d1/get-started/)
