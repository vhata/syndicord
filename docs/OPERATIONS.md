# Feeds and webhooks

[First deployment](SETUP.md) · [Web interface](WEB.md) · [Status](STATUS.md) ·
[Automatic deployment](DEPLOYMENT.md) · [Troubleshooting](RECOVERY.md)

## Select an installation

The CLI and web interface use the same Worker API. Set its origin, without an
`/admin` suffix, then sign in with Discord:

```sh
export SYNDICORD_ADMIN_URL='https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev'
npm run syndicord -- login
```

Approve the browser request only when its code matches the terminal. Your
account must belong to the configured server and have its required role. See
[Discord setup and CLI login](WEB.md#cli-login) for details. Run
`npm run syndicord -- logout` when finished; expired sessions require `login`
again.

Configuration commands need no Cloudflare credentials. For local development,
use `http://localhost:8787` with the local OAuth settings; `--local` is not a
configuration-command option. HTTPS is required except for loopback addresses.

Run commands from your checkout. For the
[npm-installed CLI](SETUP.md#optional-npm-installation), use
`npx --no-install syndicord` instead of `npm run syndicord --`.

## Add or change webhooks

Create a webhook in Discord under **Edit Channel → Integrations → Webhooks** and
copy its URL.

- **Web interface:** Choose **Add webhook**, enter a name and URL, and save. To
  update one, choose **Change URL** beside its name and save the new URL.
- **CLI:** Put the destinations you want to add or update in `.webhooks.json`:

  ```json
  {
    "updates": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
    "security": "https://discord.com/api/webhooks/OTHER_ID/OTHER_TOKEN"
  }
  ```

  Save them and list the configured destination names:

  ```sh
  npm run syndicord -- webhooks set --file .webhooks.json
  npm run syndicord -- webhooks list
  ```

`webhooks set` adds or updates only the supplied names; other destinations stay
unchanged. Use the same name with a new URL to rotate a webhook. URLs are stored
encrypted in D1 and never returned by the API. Keep a backup in your password
manager and delete `.webhooks.json` when finished.

To remove a destination, first remove its routes from the feed list, then run:

```sh
npm run syndicord -- webhooks remove security
```

Removal is refused while any feed still uses the destination. Removing it in
syndicord does not delete the webhook in Discord.

Destination names start with a letter and contain letters, digits, underscores,
or hyphens. Each needs a distinct webhook URL. A numeric `thread_id` query
parameter selects an existing thread; forum/media channels require one.

## Add or change a feed

- **Web interface:** Choose **Add feed**, enter its URL, select its
  destinations, and save. Use **Edit** on an existing feed to change and save
  its routing.
- **CLI:** Read the current routes into a temporary file:

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
  ```

The command validates the routes against the configured webhooks and saves
through the same API as the web interface. The next scheduled run reads the
result; no commit or deployment is needed. It rejects a configuration change
that occurs during the command. This does not detect an old exported file: read
a fresh copy before editing and coordinate with other operators before replacing
the list. If a save conflicts or its outcome is uncertain, inspect current
configuration before trying again.

Delete `.feeds.json` afterwards. Feed URLs may contain private query parameters,
so treat exported configuration accordingly. `--file -` reads JSON from stdin.

New feed/destination pairs silently record their current entries, then send new
ones. Removing a route stops future delivery attempts; restoring the same route
resumes pending entries. Renaming a destination creates a new baseline. Store
`[]` to pause polling and delivery. A run already in progress may finish using
the configuration it read at its start.

## Select a Cloudflare installation

Deployment, migrations, and operational status use Cloudflare access separately
from the configuration API. Set the account, Worker, and D1 identifiers:

```sh
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export SYNDICORD_WORKER_NAME='syndicord'
export SYNDICORD_DATABASE_ID='your-database-uuid'
npm run syndicord -- cf auth login
npm run syndicord -- status
```

Each independent installation has its own Worker and D1 database. Check that the
admin URL and Cloudflare identifiers refer to the intended installation when
switching between configuration and infrastructure commands.

| Setting                                    | Authoritative location   |
| ------------------------------------------ | ------------------------ |
| Feed URLs, routing, encrypted webhook URLs | D1 `relay_configuration` |
| Discord OAuth settings and encryption key  | Worker secrets           |
| Baselines, pending deliveries, and health  | D1 delivery ledger       |

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
