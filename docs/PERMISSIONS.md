# Scoped Discord permissions

An operator can delegate the shared feed catalog and individual Discord channels
to different roles. Sign in once; syndicord combines the grants for every
configured server/role pair you match. The browser and CLI use the same server
checks. Discord roles cannot edit Worker secrets or the authorization policy.

## Configure access

First configure
[Discord sign-in and the encryption key](WEB.md#enable-administration). Instead
of the single `DISCORD_GUILD_ID` / `DISCORD_ROLE_ID` gate, set the
`DISCORD_AUTH_POLICY` Worker secret to JSON like this, replacing every example
ID with the corresponding Discord ID:

```json
{
  "version": 1,
  "grants": [
    {
      "guildId": "100000000000000001",
      "roleId": "100000000000000002",
      "addFeeds": true
    },
    {
      "guildId": "200000000000000001",
      "roleId": "200000000000000002",
      "addFeeds": true
    },
    {
      "guildId": "300000000000000001",
      "roleId": "300000000000000002",
      "channelIds": ["300000000000000003", "300000000000000004"]
    }
  ]
}
```

The first two roles administer the shared feed catalog. The third can register
webhooks and manage subscriptions for the two listed channels in its own server.
A grant may have both capabilities. There are no wildcards; names confer no
permissions. Each server/role pair appears once. The policy supports up to 32
grants, 16 servers, and 64 channels per grant within 16 KiB of JSON. An empty
`grants` array denies all administration access.

1. In Discord, enable **User Settings → Advanced → Developer Mode**. Copy server
   IDs from each server's context menu, role IDs from **Server Settings →
   Roles**, and channel IDs from each channel's context menu.
2. In **Cloudflare Dashboard → Workers & Pages → your Worker → Settings →
   Variables and Secrets**, add `DISCORD_AUTH_POLICY` as a **Secret**, paste the
   JSON, and deploy the setting.
3. Sign in to `/admin` again and choose **Verify and initialize catalog**, or
   use the CLI:

   ```sh
   npm run syndicord -- login
   npm run syndicord -- catalog initialize
   ```

For step 2, the CLI offers the same secret-value prompt:

```sh
npm run syndicord -- cf workers secrets update DISCORD_AUTH_POLICY \
  --worker "$SYNDICORD_WORKER_NAME" --type secret_text
```

Only operators with Cloudflare access configure this secret. A present policy
replaces the single-server gate; it never adds that gate's broad permissions.
Invalid policy JSON disables administration. Policy changes invalidate existing
sessions. Remove roles or server membership to revoke their grants: every read
and mutation checks Discord, and mutations check again after uploads and webhook
lookups. Discord outages, rate limits, or malformed membership responses block
access until verification succeeds. Existing routes continue after management
access is revoked.

## Initialize an existing installation

Apply the packaged migrations through the normal [deployment](DEPLOYMENT.md)
flow before enabling the policy. Keep the existing encryption key and a database
backup. Enabling policy blocks the old whole-configuration write API
immediately; it does not change existing deliveries.

**Verify and initialize catalog** verifies every saved webhook with Discord and
imports all existing feeds, destinations, and subscriptions in one atomic save.
This reads webhook metadata without sending messages. The initializer cannot
supply new URLs, target claims, or replacement routes. Any signed-in account
with a policy grant can perform this copy; only the operator can enable the
policy itself.

If any webhook is unavailable, invalid, or uses `thread_id`, initialization
fails without changing the saved configuration. Repair that configuration before
activation; an operator may remove the policy to use the original editor while
no catalog has been initialized. Existing relay delivery continues in that
state. After successful initialization, removing the policy disables catalog
administration; it never restores unrestricted access through the old API.
Restore a valid policy to manage the catalog again.

Import preserves the delivery keys, baselines, pending messages, and sent
history. Subsequent label changes also preserve those identities. Catalog
storage, routing, and encrypted webhook credentials are updated together with
optimistic concurrency checks. The complete normalized configuration is bounded
to 96 KiB, including unrouted feeds and unused destinations. Requests are
limited to 128 KiB; scoped responses allow 256 KiB to include the caller’s
channel grants.

## Feeds and subscriptions

Everyone with a grant can see catalog labels and feed IDs. Saved source URLs are
never returned by the scoped API, including to feed administrators: a URL may
contain credentials. Use descriptive labels that do not contain secrets. Channel
administrators can route any catalog feed into their authorized channels, so
adding a feed makes its content available to those administrators.

A feed administrator can add a feed without routes, rename its label, or delete
it when it has no subscriptions anywhere. The source URL is immutable, including
when unused. To replace a source, create a new feed, then have each
destination's administrator explicitly select the new feed and remove its old
subscription. Renames, deletion, and the old bulk-save API cannot transfer
subscriptions.

The scoped editor shows the actions your grants permit. Choose a catalog feed
and one of your destinations to add or remove a subscription. Newly subscribed
pairs silently establish a baseline before sending new posts. An unrouted feed
is kept in the catalog without being polled. Removing all subscriptions pauses
polling and delivery; a run already in progress may finish using its snapshot.

CLI examples:

```sh
npm run syndicord -- catalog list
npm run syndicord -- catalog add --file .new-feed.json
npm run syndicord -- destinations list
npm run syndicord -- subscriptions list
npm run syndicord -- subscriptions add FEED_ID DESTINATION_ID
npm run syndicord -- subscriptions remove FEED_ID DESTINATION_ID
```

`.new-feed.json` contains a label and source URL:

```json
{ "label": "Example updates", "url": "https://example.com/feed.xml" }
```

Use `catalog rename FEED_ID LABEL` to change a label and
`catalog remove FEED_ID` to delete an unused feed. Secret-bearing input files
also accept `--file -` for stdin. Keep URL backups privately and remove
temporary files when finished.

## Destinations and webhook rotation

Create a webhook in Discord under **Edit Channel → Integrations → Webhooks**. In
the scoped editor, register its URL and a label. Or save this input privately:

```json
{
  "label": "Comic updates",
  "webhookUrl": "https://discord.com/api/webhooks/ID/TOKEN"
}
```

```sh
npm run syndicord -- destinations register --file .new-destination.json
```

Syndicord uses Discord's
[webhook-token lookup](https://docs.discord.com/developers/resources/webhook#get-webhook-with-token)
to verify the actual server/channel. Registration succeeds only inside your
granted channel scope. It does not send a message or require separate operator
approval. Saved credentials remain encrypted and are never returned.

Destinations have immutable IDs and server/channel bindings; labels are
editable. `destinations rotate DESTINATION_ID --file .replacement.json` accepts
`{"webhookUrl":"https://discord.com/api/webhooks/ID/NEW_TOKEN"}` and verifies
that the target is unchanged. To route to a different channel, register a new
destination and explicitly subscribe feeds there. Remove subscriptions before
`destinations remove DESTINATION_ID`. Use
`destinations rename DESTINATION_ID LABEL` to change only the label. Removal in
syndicord does not delete a Discord webhook.

Scoped destinations support channel webhooks without `thread_id`. The lookup
verifies the webhook's parent channel, not a supplied thread target, so thread
routing and forum/media destinations requiring a thread are unsupported here.

Before each scoped delivery, syndicord checks that the webhook still belongs to
its saved server/channel. A mismatch or failed lookup defers the delivery
without sending its content. Restore the binding or rotate to a valid
same-channel credential. Discord lookup and execution are separate requests; a
webhook owner could move it between those requests. The checks detect observed
moves but cannot make Discord's two operations atomic.

## Conflicts and verification

A stale revision rejects the entire operation. Reload, inspect the current
catalog, and reapply the intended change. Neither client automatically retries
an ambiguous save. The scoped API accepts a single named operation, not an
editable whole-document export or client-provided grants.

Automated coverage uses local D1 and synthetic Discord responses. Hosted
acceptance needs real accounts with different grants: verify combined roles,
unrelated-channel denials, role removal, registration and rotation, explicit
source adoption, and a moved webhook. Deployment, real webhook messages, and
Cloudflare changes remain operator actions.
