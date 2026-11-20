# Web interface

Open **`/admin`** on your Worker's HTTPS address to manage feeds, Discord
webhooks, and routing. Sign in with username **`admin`** and your shared
password. Each change takes effect on the next scheduled poll, without a code
deployment.

## Enable the interface

For an existing installation, deploy this version through your normal
[deployment workflow](DEPLOYMENT.md) or `npm run deploy`. Deployment applies the
D1 migrations and enables the Worker's `workers.dev` address. Preview URLs stay
disabled. The interface stays closed until its secrets are configured.

In Cloudflare, open **Workers & Pages → your Worker → Settings → Variables and
Secrets** and add these as **Secret** values:

| Secret                  | Value                                                                           |
| ----------------------- | ------------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`        | A strong shared password, stored in your password manager                       |
| `CONFIG_ENCRYPTION_KEY` | A random 32-byte key encoded as base64, also backed up in your password manager |

Generate the encryption key locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Save the secrets, then open the Worker's HTTPS address followed by `/admin`. The
Worker overview shows its address. Use the existing
[first installation guide](SETUP.md) if you have not created a Worker yet; `[]`
is a valid initial feed list and `{}` is a valid initial `WEBHOOKS` map. These
steps change your hosted installation and use its existing Cloudflare resources
and plan.

## Add feeds and routing

1. Add a webhook with a short destination name and the URL copied from **Discord
   → Edit Channel → Integrations → Webhooks**.
2. Add a feed URL and select the destinations that should receive its posts.
3. Save. Repeat for other feeds, or edit a feed to change its destinations.

A feed can send to several destinations, and a destination can receive several
feeds. At most 20 feed/destination pairs are supported. Each feed needs at least
one destination. Remove a feed to stop its routes; remove all feeds to pause
polling. New routes silently establish a baseline before delivering new posts. A
poll already in progress may finish using its earlier configuration.

Saved webhook URLs are never displayed again. To rotate one, replace its URL
under the same destination name. Remove its routes before deleting the webhook.
Deleting it here does not delete the webhook in Discord.

If another tab or operator changes the configuration, the editor rejects a stale
save. Reload the latest configuration and reapply your change. Avoid
simultaneous CLI secret changes and first-time web saves.

## Configuration and password changes

Feed routes remain in D1's `relay_configuration` record. On the first web save,
the Worker copies the current `WEBHOOKS` map, applies your changes, and encrypts
the complete map in D1 with AES-GCM. Subsequent polls and web edits use that
map. Webhook URLs are decrypted only inside the Worker and never returned to the
browser.

The old `WEBHOOKS` secret is retained for deployment compatibility but no longer
controls destinations after the first web save. The CLI rejects `webhooks set`
and `deploy --webhooks-file` in that state. Use the web interface for webhook
changes. `feeds get`, `feeds set`, and `status` still use the same D1
configuration; CLI feed writes must reference existing destinations. Normal code
deployments preserve the stored map and Worker secrets.

Change `ADMIN_PASSWORD` to change the shared login. Browsers may cache HTTP
Basic credentials; close the browser session or use a fresh private window to
sign in again. Remove `ADMIN_PASSWORD` to disable web access without stopping
the relay.

Keep `CONFIG_ENCRYPTION_KEY` stable and backed up: changing or losing it makes
saved webhooks unreadable and stops delivery until the correct key is restored.
It is separate from the login password, so password changes do not require
reencrypting webhooks. Back up D1 and the key together for recovery.

This version uses one shared password over HTTPS, with no per-user accounts or
roles. Broader authentication and security controls are deferred.

## Local preview

Follow [local development setup](DEVELOPMENT.md#run-locally), and set
`ADMIN_PASSWORD` and `CONFIG_ENCRYPTION_KEY` in the ignored `.dev.vars` file.
Then visit `http://localhost:8787/admin` and sign in as `admin`. The same web
interface edits only the local D1 database. Saving configuration does not send a
Discord message; manually triggering a scheduled poll can.
