# Feeds and webhooks

[First deployment](SETUP.md) · [Status](STATUS.md) ·
[Automatic deployment](DEPLOYMENT.md) · [Troubleshooting](RECOVERY.md)

## Select an installation

Run commands from your checkout. For the [npm-installed CLI](SETUP.md#optional-npm-installation),
use `npx --no-install syndicord` from its installation directory instead of
`npm run syndicord --`:

```sh
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
export SYNDICORD_DATABASE_ID='your-database-uuid'
```

Each independent installation has its own Worker and D1 database. Switching these
identifiers selects another installation without changing the codebase.

| Setting                                   | Authoritative location               |
| ----------------------------------------- | ------------------------------------ |
| Feed URLs, destination names, and routing | D1 `relay_configuration`             |
| Destination webhook URLs                  | Worker's encrypted `WEBHOOKS` secret |
| Baselines, pending deliveries, and health | D1 delivery ledger                   |

Code deployments preserve this configuration. GitHub deployment credentials and
resource identifiers only control where code is uploaded; GitHub is not required
for the service to function.

## Add or change a feed

Read the current configuration into a temporary file:

```sh
npm run syndicord -- feeds get > .feeds.json
```

Edit the file. Each feed appears once and lists its destination names:

```json
[
  {
    "url": "https://example.com/feed.xml",
    "destinations": ["updates", "security"]
  }
]
```

Add any new webhook destinations first, then upload the complete feed list:

```sh
npm run syndicord -- feeds set --file .feeds.json
npm run syndicord -- status
```

The command validates and atomically replaces D1 configuration. The next scheduled
run reads it; no commit or deployment is needed. Coordinate edits with other
operators: replacement uses the last submitted complete list. Delete the temporary
file afterwards. Feed URLs may contain private query parameters, so treat exported
configuration accordingly.

New feed/destination pairs silently record their current entries, then send new
ones. Removing a route stops future delivery attempts; restoring the same route
resumes pending entries. Renaming a destination creates a new baseline. Store `[]`
to pause polling and delivery. A run already in progress may finish using the
configuration it read at its start.

## Manage webhook destinations

Create or select a Discord webhook under the channel's **Edit Channel →
Integrations → Webhooks**. Put the complete mapping in `.webhooks.json`:

```json
{
  "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
  "security": "https://discord.com/api/webhooks/OTHER_ID/OTHER_TOKEN"
}
```

Keep a backup in a shared password manager. Cloudflare does not return secret
values, so include every destination still in use when replacing the map. Upload
it while no code deployment is running:

```sh
npm run syndicord -- webhooks set --file .webhooks.json
```

This replaces the complete hosted secret and activates it immediately. No code
deployment is required. Delete the temporary file afterwards. For a new Worker,
use [first deployment](SETUP.md#configure-webhooks-and-deploy).

| Change               | Order                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a destination    | Add its webhook to the hosted map, then update the feed list.                                                                                     |
| Rotate a webhook     | Replace its URL under the same destination name. Pending deliveries keep their identities; the next poll clears suspension caused by the old URL. |
| Remove a destination | Remove its routes from the feed list, allow any current run to finish, then remove the webhook from the map and retire it in Discord.             |

Destination names start with a letter and contain letters, digits, underscores,
or hyphens. Each needs a distinct webhook URL. A numeric `thread_id` query
parameter selects an existing thread; forum/media channels require one.

## Polling limits

The default one-minute cron checks one feed and attempts at most five deliveries
per run. With N feeds, each is checked about every N minutes. The limit is 20
feed/destination pairs; a feed sent to two destinations uses two pairs.

Runs stop starting deliveries after 30 seconds; HTTP requests have six-second
deadlines. Leases, retries, and Discord cooldowns can delay work further. Feeds
must be UTF-8 XML, at most 256 KiB and 200 entries, with at most three redirects
and no HTTPS downgrade. Malformed or unsupported XML does not change a baseline.

D1 retains entry identities indefinitely and clears pending payloads after
successful delivery. Monitor database growth for busy feeds. See
[relay behavior](BEHAVIOR.md) for identity and retry semantics.
