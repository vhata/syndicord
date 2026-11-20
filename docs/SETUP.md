# First deployment

This guide takes a fresh checkout through its first Discord delivery. Already
running? See [feeds and webhooks](OPERATIONS.md) or
[automatic deployment](DEPLOYMENT.md).

## Install and check

Use Node.js 26.13.0 and npm 11.20.0, as recorded in `.node-version` and
`package.json`. Clone your repository (fork syndicord first if needed):

```sh
git clone YOUR_REPOSITORY_URL syndicord
cd syndicord
npm ci
npm run check
```

These checks need no Cloudflare or Discord credentials. Fix any failures before
continuing. Edit `feeds.json` to choose your feeds; the default follows this
project's upstream `vhata/syndicord` commits and sends them to `updates`.
For the first-delivery check, use a feed you control, such as your own fork's
commit feed: `https://github.com/YOUR_OWNER/YOUR_REPOSITORY/commits.atom`.

## Create the database

Sign in and select the account ID shown by `whoami`:

```sh
npx cf auth login
npx cf auth whoami
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
```

The following steps create metered Cloudflare resources; usage may fit the free
plan. For an existing installation, reuse its database ID and skip creation.

```sh
npx cf d1 create --name syndicord
export SYNDICORD_DATABASE_ID='the-returned-database-uuid'
npx cf d1 migrations apply "$SYNDICORD_DATABASE_ID" --dir migrations
```

Keep both IDs for [GitHub setup](DEPLOYMENT.md). These migrations apply to the
hosted database; [local development](DEVELOPMENT.md#run-locally) uses separate
state.

## Configure webhooks and deploy

Create a webhook in Discord under the channel's **Edit Channel → Integrations →
Webhooks**. Keep the complete destination mapping in a shared password-manager
item accessible to the operators.

Create `.env.production` in the repository (Git ignores it):

```dotenv
WEBHOOKS='{"updates":"https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN"}'
```

Replace the example URL with the real webhook. Every destination in
`feeds.json` needs a matching name in this JSON object. Then deploy:

```sh
npm run deploy -- --secrets-file .env.production
```

The command creates the Worker, uploads its initial secret, binds D1, and sets
the cron schedule. Public and preview URLs are disabled. The secret is present
before polling starts. Delete `.env.production` when finished; the shared
password manager holds the authoritative copy, and Cloudflare stores the
encrypted runtime secret. CI preserves that hosted secret.

## Verify delivery

Start a live tail:

```sh
npx cf observability tail --worker syndicord
```

1. Wait for `feed_checked` and `relay_complete`. Existing entries should produce
   **no messages**: the first successful poll establishes a silent baseline.
2. Publish a new entry in a feed you control. For a GitHub commit feed, push or
   merge a commit to that repository's default branch.
3. Wait for `delivery_sent` and one message in each configured destination.
   Check the feed name, title, link, and excerpt.
4. Let the same feed be checked again and confirm the entry is not resent.

With the default schedule, one feed is checked each minute, rotating through
the list. A successful cron invocation alone does not prove delivery. Check
CPU time and invocation errors in Cloudflare's Worker metrics too; local tests
cannot establish hosted CPU headroom. See [troubleshooting](RECOVERY.md) if
polling or delivery fails.

Once this works, [enable automatic deployment](DEPLOYMENT.md). Future changes
to `main` then apply migrations and deploy without a local secrets file.

For a manual update, run `npm ci` after dependency changes, `npm run check`,
apply outstanding migrations with the command above, and run `npm run deploy`
with the same exported IDs. Omit `--secrets-file` to preserve hosted secrets.

[Cloudflare deployment reference](https://developers.cloudflare.com/cf/projects/#deploy)
