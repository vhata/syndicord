# Set up an installation

**For the installation owner setting up a new installation.** If someone has
already set it up, ask them for a link to the web editor and start with
[Manage feeds and channels](FEEDS.md).

You need a Cloudflare account, permission to manage roles and webhooks in your
Discord server, and Node.js 26.12 or newer in the 26.x line with npm 11. An
installation is one **Worker** (the running service) and one **D1 database**
(feeds, encrypted webhook URLs, routing, and delivery history).

Discord delivery uses channel webhooks, so you do not invite or authorize a bot
on your server. Discord sign-in uses an OAuth application to check members'
roles. You choose which roles can edit feeds and channels, then grant or revoke
people's access by managing those roles in Discord.

## Steps

Follow these in order. Steps 4 and 5 happen in other guides, which send you back
here when they are done.

1. [Install the CLI](#install-the-cli)
2. [Choose the Cloudflare account](#choose-the-cloudflare-account)
3. [Create the database and deploy](#create-the-database-and-deploy)
4. [Configure Discord sign-in](#configure-discord-sign-in), in
   [Discord sign-in and access](DISCORD_SIGN_IN.md)
5. [Add a first feed and destination](#add-a-first-feed-and-destination), in
   [Manage feeds and channels](FEEDS.md)
6. [Verify delivery](#verify-delivery)

Keep a password-manager entry for this installation open throughout. Each step
says what to save in it. GitHub automatic deployment is optional; you do not
need your own repository to host syndicord.

## Install the CLI

Follow [Install the CLI](CLI.md). The commands below use the checkout form,
`npm run syndicord --`; that page lists the npm-installed equivalents.

## Choose the Cloudflare account

Sign in to Cloudflare:

```sh
npm run syndicord -- cf auth login
npm run syndicord -- cf auth whoami
```

Copy the account ID from `whoami`, or open the
[Cloudflare Dashboard](https://dash.cloudflare.com/), select your account, and
use **Search → Copy account ID**
([account-ID help](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)).
Choose a Worker name, save both in your password-manager entry, and keep them in
your terminal:

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

Save the database UUID in your password-manager entry. Then set it and deploy
from your terminal:

```sh
export SYNDICORD_DATABASE_ID='your-database-uuid'
npm run deploy
```

Deployment applies migrations, binds the database, and installs the polling
schedule. It builds current source in a checkout or uses the bundled Worker in
an npm installation. The dashboard can create the database, but syndicord's CLI
handles its code, migrations, and bindings together.

The fresh service has no feeds and stays idle until you configure it.

## Configure Discord sign-in

Follow [Discord sign-in and access](DISCORD_SIGN_IN.md). It starts by finding
your Worker's address, then walks you through the Discord application, choosing
who can edit, and saving the settings on your Worker. If you choose separate
feed and channel permissions, it sends you on to
[Feed and channel permissions](PERMISSIONS.md#configure-access) to write the
policy. Both guides end by sending you back here.

## Add a first feed and destination

In [Manage feeds and channels](FEEDS.md), follow the section that matches the
editor you see after signing in. Create a destination webhook and add one feed,
in the browser or CLI. For the delivery check below, use a feed you can publish
to, such as your own repository's commit feed. Save the webhook URL in your
password-manager entry; saved URLs are never returned by either client.

Then continue with the next step.

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
health with `npm run syndicord -- status`; [Operational status](STATUS.md)
explains the report. A successful cron invocation alone does not prove delivery.

For invocation outcomes and CPU time, use **your Worker → Metrics**, or the live
tail's `$workers` fields (`outcome`, `cpuTimeMs`, `wallTimeMs`). Missing or
sampled logs do not prove health, and local tests do not establish hosted CPU
headroom. If something fails, use [Troubleshooting and recovery](RECOVERY.md).

## After setup

Setup is complete. From here:

- Share the web-editor link with other editors and assign them the configured
  roles; see
  [Grant and revoke access](DISCORD_SIGN_IN.md#grant-and-revoke-access).
- Keep the code current with
  [Update the installation](OPERATIONS.md#update-the-installation), or set up
  [Automatic deployment from GitHub](GITHUB_DEPLOYMENT.md).
- [Run an installation](OPERATIONS.md) covers the rest of day-to-day operation.
