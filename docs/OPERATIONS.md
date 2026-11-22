# Manage feeds and channels

Use this guide for an **existing installation**. Ask its operator for the
`/admin` address and the Discord role you need. Hosting a new installation?
Start with [setup](SETUP.md).

A feed supplies articles; a webhook posts to a Discord channel; a subscription
(or route) connects them. The browser and CLI edit the same saved configuration.
Changes take effect on the next scheduled poll, without a deployment.

## Sign in

**Web:** Open the installation's `/admin` address and choose **Sign in with
Discord**. Your Discord roles determine which controls you can use. No local
software or Cloudflare account is needed.

**CLI:** [Install the CLI](SETUP.md#run-from-the-repository), then select the
same installation as below. Examples use a source checkout; for an
[npm installation](SETUP.md#optional-npm-installation), replace
`npm run syndicord --` with `npx --no-install syndicord`.

### Select an installation

```sh
export SYNDICORD_ADMIN_URL='https://WORKER.ACCOUNT-SUBDOMAIN.workers.dev'
npm run syndicord -- login
```

Use the origin without `/admin`. Approve the browser request only when its code
matches the terminal. Configuration commands need no Cloudflare credentials. Use
`login --no-browser` if you want to open the printed URL yourself, and
`npm run syndicord -- logout` to sign out. Expired sessions require another
login; see [session details](WEB.md#cli-login).

For local development use `http://localhost:8787`; configuration commands do not
accept `--local`. Other addresses must use HTTPS.

## Choose the section matching your editor

| The editor shows…                                               | Your mode                                              | Follow                                    |
| --------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| **Feed catalog**, **Your destinations**, **Your subscriptions** | Scoped access: feed and channel roles can be different | [Scoped access](#scoped-access)           |
| **Feeds** and **Webhooks**, with **Add webhook**                | Single role: authorized members manage all routes      | [Single-role access](#single-role-access) |

The operator chooses the mode. If you see **Verify and initialize catalog**,
finish the operator's [catalog setup](PERMISSIONS.md#configure-access) first.

## Scoped access

You can see all feed labels and only the destinations your roles allow you to
manage. Adding feeds and managing channels are separate permissions; you may
have either or both. Source URLs stay private, so keep a backup and use labels
without secrets. Adding a feed makes its content available for other channel
administrators to subscribe to.

### 1. Choose or add a feed

**Web:** Look in **Feed catalog**. To add a source, choose **Add feed**, enter a
label and RSS/Atom URL, and save. If that control is unavailable, ask a feed
administrator to add it.

**CLI:** List the catalog; if you have feed permission, save the JSON below as
`.new-feed.json` and add it:

```sh
npm run syndicord -- catalog list
```

```json
{ "label": "Example updates", "url": "https://example.com/feed.xml" }
```

```sh
npm run syndicord -- catalog add --file .new-feed.json
npm run syndicord -- catalog list
```

An unrouted feed is kept in the catalog but is not polled. Source URLs cannot be
edited: add a replacement feed and explicitly change each destination's
subscription. Renaming a label keeps the source and subscriptions intact.

### 2. Register a destination

In Discord, open **Edit Channel → Integrations → Webhooks**, create a webhook,
and copy its URL. You need permission to manage webhooks in that channel. Keep
the URL in your password manager; syndicord never reveals saved webhook URLs.
Discord has no supported setup CLI in this project; advanced bot-based creation
is an [optional API recipe](API.md#create-a-discord-webhook).

**Web:** Under **Your destinations**, choose **Register webhook**, enter a label
and the URL, and save.

**CLI:** Save this as `.new-destination.json`, then register it:

```json
{
  "label": "Community updates",
  "webhookUrl": "https://discord.com/api/webhooks/ID/TOKEN"
}
```

```sh
npm run syndicord -- destinations register --file .new-destination.json
npm run syndicord -- destinations list
```

Registration verifies the webhook's actual server and channel against your
permissions without sending a message. Scoped access supports channel webhooks;
thread routing and forum/media channels requiring `thread_id` are unsupported.

### 3. Subscribe the channel

**Web:** Under **Your subscriptions**, choose **Subscribe**, select the feed and
destination, and save.

**CLI:** Copy the IDs from `catalog list` and `destinations list`:

```sh
npm run syndicord -- subscriptions add FEED_ID DESTINATION_ID
npm run syndicord -- subscriptions list
```

The first successful poll quietly records existing entries. Only new entries
after that baseline are sent. With N subscribed feeds, each is normally checked
about every N minutes. See [what to expect](#what-to-expect-after-saving).

### Change or remove something

The CLI commands below follow `npm run syndicord --` (or your installed entry
point). Replace the IDs with those from the list commands; quote labels with
spaces.

| Task                         | Web editor                                | CLI command                                                   |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Rename a feed                | **Rename** beside the feed                | `catalog rename FEED_ID 'New label'`                          |
| Rename a destination         | **Rename** beside the destination         | `destinations rename DESTINATION_ID 'New label'`              |
| Stop one subscription        | **Unsubscribe** beside the subscription   | `subscriptions remove FEED_ID DESTINATION_ID`                 |
| Delete an unused feed        | **Delete** beside the feed                | `catalog remove FEED_ID`                                      |
| Delete an unused destination | **Delete** beside the destination         | `destinations remove DESTINATION_ID`                          |
| Replace webhook credentials  | **Rotate webhook** beside the destination | `destinations rotate DESTINATION_ID --file .replacement.json` |

For rotation, `.replacement.json` contains
`{"webhookUrl":"https://discord.com/api/webhooks/ID/NEW_TOKEN"}`. The
replacement must point to the same server and channel. To move channels,
register a new destination and explicitly subscribe feeds there.

Remove all subscriptions before deleting a feed or destination; a feed may be
used by channels you cannot administer. Deleting a destination in syndicord does
not delete its webhook in Discord. Removing all subscriptions pauses polling and
delivery, but a run already in progress may finish. Restoring the same
subscription resumes pending entries; label changes preserve delivery history.
See [permissions and verification](PERMISSIONS.md) for the exact rules.

## Single-role access

Everyone with the configured role can edit the whole configuration. Add a
webhook first, then select it when adding a feed. Each feed needs at least one
destination. Use only this section's `feeds` / `webhooks` commands in this mode;
scoped installations reject them.

### Add or change webhooks

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

To remove a destination, first remove its routes from the feed list, then choose
**Remove** beside the webhook in the editor, or run:

```sh
npm run syndicord -- webhooks remove security
```

Removal is refused while any feed still uses the destination. Removing it in
syndicord does not delete the webhook in Discord.

Destination names start with a letter and contain letters, digits, underscores,
or hyphens. Each needs a distinct webhook URL. A numeric `thread_id` query
parameter selects an existing thread; forum/media channels require one.

### Add or change a feed

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
resumes pending entries. Renaming a destination creates a new baseline. In the
editor, **Remove** deletes a feed and its routes. To pause polling and delivery,
remove all feeds or save a CLI feed file containing `[]`. A run already in
progress may finish using the configuration it read at its start.

## What to expect after saving

- A new route starts with a **silent baseline**, then sends new entries. Saving
  a form does not itself send a message. An existing poll may finish using its
  earlier configuration.
- Configuration and encrypted webhook changes are saved together in D1. If a
  save conflicts, reload and reapply it. After an uncertain result, inspect the
  saved state before retrying; neither client automatically retries an ambiguous
  save. For bulk feed files, export a fresh copy before editing.
- Keep source URLs and webhook URLs private. Save backups in your password
  manager and delete temporary JSON files after use. File-based input also
  accepts `--file -` for stdin.

For a first real message, follow [verify delivery](SETUP.md#verify-delivery).
For missing messages, ask the operator to check [status](STATUS.md) and
[troubleshooting](RECOVERY.md).

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

| Setting                                                          | Authoritative location   |
| ---------------------------------------------------------------- | ------------------------ |
| Feed URLs, routing, encrypted webhook URLs                       | D1 `relay_configuration` |
| Discord OAuth settings, authorization policy, and encryption key | Worker secrets           |
| Baselines, pending deliveries, and health                        | D1 delivery ledger       |

## Polling limits

By default, one feed is checked and up to five deliveries are attempted each
minute. Larger feed lists take longer to revisit. See
[capacity and limits](BEHAVIOR.md#polling-limits) for request/configuration
sizes, feed bounds, timeouts, and storage behavior.
