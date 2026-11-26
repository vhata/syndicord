# Feed and channel permissions

**For the installation owner.** This guide explains the two access models and
configures separate feed and channel permissions. To add feeds, destinations, or
subscriptions, use [Manage feeds and channels](FEEDS.md).

## Access models

Editing access follows Discord server roles. The installation owner chooses
which roles grant which permissions; after setup, grant or revoke a person's
access by assigning or removing those roles in Discord. There are no separate
syndicord accounts or per-person access lists to maintain.

Choose an access model:

| Model                                                     | Permissions                                                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One admin role** (single-role access)                   | Members of one configured Discord role can manage every feed, webhook, and route.                                                                                      |
| **Separate feed and channel permissions** (scoped access) | Each role can manage the shared feed catalog, specified destination channels, or both. Roles may come from different servers; a person's matching permissions combine. |

Here, **scoped** means limited to the configured tasks and channels. It does not
mean a private catalog for each role: everyone granted access can see the shared
feed labels, and channel administrators can subscribe to any catalog feed. In
this model, saved source URLs remain hidden even from feed administrators.

For example, a **Feed curators** role could manage sources while an
**Announcements editors** role manages subscriptions only for `#announcements`.
Someone with both roles could do both jobs. One role can also hold both kinds of
permission; the distinction is what it permits, not how many roles exist.

The browser and CLI enforce the same permissions. Neither model grants access to
Cloudflare Worker secrets or the authorization policy. To configure one admin
role, follow
[Discord sign-in and access](DISCORD_SIGN_IN.md#enable-administration). The
remaining sections explain separate feed and channel permissions.

## Configure access

Follow this section if you chose **separate feed and channel permissions**.
First save the four common settings in
[Configure the Worker](DISCORD_SIGN_IN.md#configure-the-worker): the encryption
key, client ID, client secret, and callback URL. If you came here from that
guide, those settings are already in place.

You will now save a JSON document as the `DISCORD_AUTH_POLICY` Worker secret.
Each entry (a **grant**) names a Discord server and role, then says whether that
role may manage feeds, particular channels, or both. This replaces the
`DISCORD_GUILD_ID` / `DISCORD_ROLE_ID` settings used for one unrestricted admin
role.

### 1. Collect the Discord IDs

Use the IDs saved during sign-in setup. For any you still need, open your
**Discord client** and enable **User Settings → Advanced → Developer Mode**.
Right-click each server where you want to deliver feeds and choose **Copy Server
ID**. Copy role IDs from **Server Settings → Roles**, and channel IDs from each
channel's context menu. Save them in your installation's password-manager entry,
labelled by server, role, and channel name.

Assign the relevant roles to yourself under **Server Settings → Members** so you
can test the permissions. For full setup, your account needs feed permission and
permission for at least one destination channel; one role or several can supply
them.

### 2. Build the policy

Copy this example into your installation's password-manager entry as
`DISCORD_AUTH_POLICY`, then replace the example IDs with your own. This example
gives one role control of feeds and another role control of two channels in the
same server:

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
      "guildId": "100000000000000001",
      "roleId": "100000000000000003",
      "channelIds": ["100000000000000004", "100000000000000005"]
    }
  ]
}
```

| Field        | What to put there                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | Keep `1`.                                                                                                                                                     |
| `grants`     | One entry for each server/role pair you want to authorize.                                                                                                    |
| `guildId`    | The numeric server ID (Discord calls servers "guilds").                                                                                                       |
| `roleId`     | The numeric role ID within that server.                                                                                                                       |
| `addFeeds`   | `true` to let the role add, rename, and delete unused feeds. Omit it for a role that only manages channels.                                                   |
| `channelIds` | An array of numeric channel IDs in that server where the role may register destinations and manage subscriptions. Omit it for a role that only manages feeds. |

A grant may have both `addFeeds` and `channelIds`. If one role should do both,
put both fields in a single grant with that role ID. For roles from other
servers, add grants with those servers' IDs. Keep IDs quoted as strings; names
and wildcards do not grant permissions.

Each server/role pair appears once. The policy supports up to 32 grants, 16
servers, and 64 channels per grant within 16 KiB of JSON. An empty `grants`
array denies all administration access.

### 3. Save the policy on the Worker

Choose one method:

- **Cloudflare Dashboard:** Open
  [**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages),
  select your Worker, then open **Settings → Variables and Secrets**. Add
  `DISCORD_AUTH_POLICY` as a **Secret**, paste your complete JSON document, and
  deploy the setting.
- **CLI:** In the terminal where you selected your Cloudflare installation, run
  the command below and paste the JSON as a single line at its hidden prompt:

  ```sh
  npm run syndicord -- cf workers secrets update DISCORD_AUTH_POLICY \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text
  ```

  If you prefer to keep the formatting, save the JSON as `policy.json` and pass
  it through the same command's native file input:

  ```sh
  npm run syndicord -- cf workers secrets update DISCORD_AUTH_POLICY \
    --worker "$SYNDICORD_WORKER_NAME" --type secret_text < policy.json
  ```

### 4. Initialize the catalog

Open your Worker URL with `/admin` appended and sign in with an account that has
one of the policy's roles. Choose **Verify and initialize catalog**. This is
required even for a new installation: it creates an empty catalog ready for
feeds and destinations. For an existing installation, it verifies and imports
saved configuration; read
[initialization details](#initialize-an-existing-installation) first.
Initialization sends no Discord messages.

For the CLI alternative,
[sign in from the terminal](FEEDS.md#select-an-installation), then run:

```sh
npm run syndicord -- catalog initialize
```

After initialization, the installation uses the catalog editor. Removing the
policy does not switch it back to the one-admin-role editor; restore a valid
policy to regain editing access.

**Next:** access setup is complete. For a new installation, return to
[Add a first feed and destination](SETUP.md#add-a-first-feed-and-destination).

### Policy changes and sessions

Configuring this secret requires access to the installation’s Cloudflare
account. A present policy replaces the single-server gate; it never adds that
gate's broad permissions. Invalid policy JSON disables administration. Policy
changes invalidate existing sessions immediately. Removing a Discord role or
server membership revokes its grants after the session's current permission
window expires, at most two minutes after its last successful check. Reads and
writes can reuse those verified permissions during that fixed window; use does
not extend it.

Every request validates the local session. Writes check authorization after
uploads and scoped webhook lookups, refreshing expired permissions through
Discord. Once the window expires, outages, rate limits, or malformed responses
block access until verification succeeds; stale grants are never a fallback.
Local logout and known session expiry remain immediate. See
[Grant and revoke access](DISCORD_SIGN_IN.md#grant-and-revoke-access) for the
browser, CLI, and token-revocation behavior. Existing routes continue after
management access is revoked.

## Initialize an existing installation

Apply the packaged migrations through the normal
[deployment](OPERATIONS.md#update-the-installation) flow before enabling the
policy. Keep the existing encryption key and a database backup. Enabling policy
blocks the old whole-configuration write API immediately; it does not change
existing deliveries.

**Verify and initialize catalog** verifies every saved webhook with Discord and
imports all existing feeds, destinations, and subscriptions in one atomic save.
This reads webhook metadata without sending messages. The initializer cannot
supply new URLs, target claims, or replacement routes. Any signed-in account
with a policy grant can perform this copy; enabling the policy itself requires
Cloudflare access.

If any webhook is unavailable, invalid, or uses `thread_id`, initialization
fails without changing the saved configuration. Repair that configuration before
activation; the installation owner may remove the policy to use the original
editor while no catalog has been initialized. Existing relay delivery continues
in that state. After successful initialization, removing the policy disables
catalog administration; it never restores unrestricted access through the old
API. Restore a valid policy to manage the catalog again.

Import preserves the delivery keys, baselines, pending messages, and sent
history. Subsequent label changes also preserve those identities. Catalog
storage, routing, and encrypted webhook credentials are updated together with
optimistic concurrency checks. The complete normalized configuration is bounded
to 96 KiB, including unrouted feeds and unused destinations. Requests are
limited to 128 KiB; the CLI accepts catalog API responses up to 256 KiB to
include the caller's channel permissions.

## Feeds and subscriptions

Everyone with a grant can see catalog labels and feed IDs. Saved source URLs are
never returned by the catalog API, including to feed administrators: a URL may
contain credentials. Use descriptive labels that do not contain secrets. Channel
administrators can route any catalog feed into their authorized channels, so
adding a feed makes its content available to those administrators.

A feed administrator can add a feed without routes, rename its label, or delete
it when it has no subscriptions anywhere. The source URL is immutable, including
when unused. To replace a source, create a new feed, then have each
destination's administrator explicitly select the new feed and remove its old
subscription. Renames, deletion, and the old bulk-save API cannot transfer
subscriptions.

The catalog editor shows the actions your grants permit. Choose a catalog feed
and one of your destinations to add or remove a subscription. Newly subscribed
pairs silently establish a baseline before sending new posts. An unrouted feed
is kept in the catalog without being polled. Removing all subscriptions pauses
polling and delivery; a run already in progress may finish using its snapshot.

For the browser steps, JSON input examples, and CLI commands, see
[manage feeds and channels](FEEDS.md#separate-feed-and-channel-permissions).
Both clients offer adding, renaming, deleting unused feeds, and adding/removing
subscriptions. Secret-bearing input files accept `--file -`; back up URLs
privately and delete temporary files after use.

## Destinations and webhook rotation

Follow [register a destination](FEEDS.md#2-register-a-destination) for browser
and CLI steps, and
[change or remove something](FEEDS.md#change-or-remove-something) for rotation,
renaming, and deletion. The guarantees below explain those rules.

Syndicord uses Discord's
[webhook-token lookup](https://docs.discord.com/developers/resources/webhook#get-webhook-with-token)
to verify the actual server/channel. Registration succeeds only inside your
granted channel scope. It does not send a message or require separate approval
from the installation owner. Saved credentials remain encrypted and are never
returned.

Destinations have immutable IDs and server/channel bindings; labels are
editable. Rotation verifies that the target is unchanged. To route to a
different channel, register a new destination and explicitly subscribe feeds
there. Remove subscriptions before deleting a destination. Removal in syndicord
does not delete a Discord webhook.

Destinations registered with channel permissions support channel webhooks
without `thread_id`. The lookup verifies the webhook's parent channel, not a
supplied thread target, so thread routing and forum/media destinations requiring
a thread are unsupported here.

Before sending to a registered channel destination, syndicord checks that the
webhook still belongs to its saved server/channel. A mismatch or failed lookup
defers the delivery without sending its content. Restore the binding or rotate
to a valid same-channel credential. Discord lookup and execution are separate
requests; a webhook owner could move it between those requests. The checks
detect observed moves but cannot make Discord's two operations atomic.

## Conflicts and verification

A stale revision rejects the entire operation. Reload, inspect the current
catalog, and reapply the intended change. Neither client automatically retries
an ambiguous save. The catalog API accepts a single named operation, not an
editable whole-document export or client-provided grants.

Automated coverage uses local D1 and synthetic Discord responses. Hosted
acceptance needs real accounts with different grants: verify combined roles,
unrelated-channel denials, role removal, registration and rotation, explicit
source adoption, and a moved webhook. Deployment, real webhook messages, and
Cloudflare changes remain tasks for the installation owner.
