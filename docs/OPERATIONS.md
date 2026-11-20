# Feeds and webhooks

[First deployment](SETUP.md) · [Automatic deployment](DEPLOYMENT.md) ·
[Troubleshooting](RECOVERY.md)

## Where configuration lives

| Setting                         | Authoritative location                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| Feed URLs and destination names | `feeds.json` in Git                                                               |
| Complete webhook mapping        | Shared password-manager item                                                      |
| Runtime webhook URLs            | Cloudflare's encrypted `WEBHOOKS` secret                                          |
| Deployment token                | GitHub `production` secret `CLOUDFLARE_API_TOKEN`                                 |
| Account and database IDs        | GitHub `production` variables `CLOUDFLARE_ACCOUNT_ID` and `SYNDICORD_DATABASE_ID` |

CI preserves the hosted secret. Cloudflare does not return its value, so keep
all destinations together in the shared password-manager item; another
operator should be able to replace the mapping without your checkout.

## Add or change a feed

Edit `feeds.json`. Each feed appears once and lists its destination names:

```json
[
  {
    "url": "https://github.com/vhata/syndicord/commits.atom",
    "destinations": ["updates"]
  },
  {
    "url": "https://example.com/feed.xml",
    "destinations": ["updates", "security"]
  }
]
```

Add any new webhook destinations first, then open a PR with the feed change.
After checks pass and you merge, CI applies migrations and deploys the routing.
CI cannot read hosted webhook values: every destination must already exist in
`WEBHOOKS`.

A new feed/destination pair silently records its current entries, then sends
new ones. Removing a route stops delivery; restoring the same route resumes
pending entries. Renaming a destination creates a new baseline. An empty array
pauses polling and delivery.

## Manage webhook destinations

Create or select a Discord webhook under the channel's **Edit Channel →
Integrations → Webhooks**. Update the complete mapping in the shared password
manager, then copy it into a temporary `.webhooks.json` file (ignored by Git):

```json
{
  "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
  "security": "https://discord.com/api/webhooks/OTHER_ID/OTHER_TOKEN"
}
```

Replace the example URLs and retain every destination still used by
`feeds.json`. Upload the secret while no GitHub deployment is running:

```sh
npx cf auth login
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
npx cf workers secrets update WEBHOOKS --worker syndicord --type secret_text --text @.webhooks.json
```

The command replaces the entire `WEBHOOKS` value and activates it immediately;
no code deployment or CI run is needed. Delete the temporary file afterwards.
This file contains the JSON map itself; the initial deployment uses a dotenv
file because its secrets-file option accepts several named secrets. For a new
Worker, use the [initial deployment](SETUP.md) instead.

| Change               | Order                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a destination    | Add it to the shared mapping and hosted secret, then merge the feed change. Unused map entries are allowed.                                                      |
| Rotate a webhook     | Replace its URL under the same destination name in both places. Pending deliveries keep their identities; the next poll clears suspension caused by the old URL. |
| Remove a destination | Deploy its removal from `feeds.json`, then remove the mapping entry and retire the Discord webhook.                                                              |

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
