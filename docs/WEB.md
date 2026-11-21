# Web interface

Open **`/admin`** on your Worker's HTTPS address to manage feeds, Discord
webhooks, and routing. Sign in with username **`admin`** and your shared
password. The [syndicord CLI](OPERATIONS.md) edits the same configuration
through the same API. Changes from either client apply on the next scheduled
poll.

## Enable administration

[Select the Cloudflare installation](OPERATIONS.md#select-a-cloudflare-installation),
then deploy code and migrations with `npm run deploy` or your
[deployment workflow](DEPLOYMENT.md). A fresh installation starts empty, with
polling paused. The Worker enables its `workers.dev` address; preview URLs stay
disabled. Administration stays closed until its secrets are configured.

Generate a key once, and save it in your password manager:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set these Worker secrets using the CLI. Run this snippet in Bash; paste the
saved key at the first hidden prompt and your chosen password at the second:

```bash
(
  set -e
  for secret_name in CONFIG_ENCRYPTION_KEY ADMIN_PASSWORD; do
    IFS= read -r -s -p "$secret_name: " secret_value
    printf '\n'
    test -n "$secret_value"
    printf '%s' "$secret_value" |
      npm run syndicord -- cf workers secrets update "$secret_name" \
        --worker "$SYNDICORD_WORKER_NAME" --type secret_text --text @/dev/stdin
  done
)
```

The commands update the hosted Worker. `printf` sends the exact value without a
trailing newline; the value stays out of command arguments and shell history.
For the [npm-installed CLI](SETUP.md#optional-npm-installation), substitute
`npx --no-install syndicord` for `npm run syndicord --`.

Alternatively, in Cloudflare open **Workers & Pages → your Worker → Settings →
Variables and Secrets** and add both values as **Secret**:

| Secret                  | Value                                 |
| ----------------------- | ------------------------------------- |
| `ADMIN_PASSWORD`        | Your shared login password            |
| `CONFIG_ENCRYPTION_KEY` | Your saved base64-encoded 32-byte key |

Visit `https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev/admin`. To find the account
subdomain from the terminal, use the
[address lookup](API.md#find-the-worker-address); the Cloudflare Worker overview
also shows the address. For a new installation, start with
[first deployment](SETUP.md).

## Add feeds and routing

1. [Create a Discord webhook](API.md#create-a-discord-webhook), using the API or
   Discord's **Edit Channel → Integrations → Webhooks** page.
2. In syndicord, add that webhook with a short destination name.
3. Add a feed URL, choose its destinations, and save.

For the same operations from the terminal, use
[`webhooks set` and `feeds set`](OPERATIONS.md). You can switch between the CLI
and web interface at any time.

A feed can send to several destinations, and a destination can receive several
feeds. At most 20 feed/destination pairs are supported. Each feed needs at least
one destination. Remove a feed to stop its routes; remove all feeds to pause
polling. New routes silently establish a baseline before delivering new posts. A
poll already in progress may finish using its earlier configuration.

Saved webhook URLs stay hidden. To rotate one, replace its URL under the same
destination name. Remove its routes before deleting the webhook. Deleting it in
syndicord does not delete it in Discord.

If another client changes the configuration while a browser form is open, the
editor rejects its stale save. Reload the latest configuration and reapply your
change. CLI writes also reject changes that race with the command; exported feed
files still need to be kept current.

## Configuration and password changes

Feed routes and encrypted webhook URLs live in D1's `relay_configuration`
record. Both clients use the Worker's configuration API; a save updates feeds
and webhooks atomically. Code deployments preserve this data and Worker secrets.

To change the login password, repeat the CLI secret update above for
`ADMIN_PASSWORD` only, or edit that secret in the dashboard. Browsers may cache
HTTP Basic credentials; close the browser session or use a fresh private window
to sign in again. To disable web and configuration-CLI access without stopping
the relay:

```sh
npm run syndicord -- cf workers secrets delete ADMIN_PASSWORD \
  --worker "$SYNDICORD_WORKER_NAME"
```

Keep `CONFIG_ENCRYPTION_KEY` stable and backed up: changing or losing it makes
saved webhooks unreadable and stops delivery until the correct key is restored.
It is separate from the login password, so password changes do not require
reencrypting webhooks. Back up D1 and the key together for recovery.

This version uses a shared password as its temporary authentication gate.
Discord OAuth is separate follow-up work.

## Local preview

Follow [local development setup](DEVELOPMENT.md#run-locally), then visit
`http://localhost:8787/admin` and sign in as `admin`. For terminal editing, set
`SYNDICORD_ADMIN_URL=http://localhost:8787` and use the
[same CLI commands](OPERATIONS.md). Both clients edit only that local Worker's
D1 database. Saving configuration does not send a Discord message; manually
triggering a scheduled poll can.
