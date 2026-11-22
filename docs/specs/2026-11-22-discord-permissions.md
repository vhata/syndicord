# Discord permissions for feeds and destinations

This specification records the permission boundaries agreed on 2026-11-22. See
[scoped permissions](../PERMISSIONS.md) for configuration and operation.

## Agreed authority boundaries

Instance operators control Cloudflare Worker secrets, deployment, and the
authorization policy. The administration interface and its Discord roles do not
grant access to those settings. Operators decide which server/role pairs grant
which capabilities and which destination channels those capabilities cover.

A person signs in once with Discord. Their effective permissions combine the
grants from all configured server/role pairs they match. Role IDs and server IDs
identify grants; display names do not determine authority.

| Capability        | Scope                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Add feeds         | Create entries in the shared feed catalog without also creating a route. Any matching feed-admin grant is sufficient.     |
| Manage routes     | Subscribe any existing catalog feed to an authorized destination, or remove a subscription from that destination.         |
| Register webhooks | Activate a webhook immediately within an operator-authorized server/channel scope, without per-webhook operator approval. |

Routing authority does not confer feed-creation authority or permission to
change the operator's policy. A routing role can register webhooks within its
authorized channel scope; registration does not broaden that scope.

For example, feed-admin roles in either server A or server B may add feeds. The
`comic-updates` role in server Z may select existing feeds for Z's
`#comic-updates` and `#memes` channels and register webhooks for those channels.
That role alone does not authorize other channels or creation of new feeds.

## Agreed protection for shared feed URLs

Changing the source URL of a subscribed feed creates a new feed with a separate
identity. Existing subscriptions remain attached to the original feed. Each
destination administrator explicitly chooses whether to switch that destination
to the replacement.

Feed administration must not provide an indirect way to change what other
destinations receive. A rename, import, delete-and-recreate operation, or bulk
save must not bypass the source protection or silently transfer subscriptions.
Creating a replacement feed does not itself authorize any route changes.

## Destination identity and webhook verification

A destination has a stable identity, an actual Discord server/channel binding,
and an encrypted webhook credential. Its name is a label. Routes connect feed
identities to destination identities, and inherit the destination's routing
permissions rather than requiring an independent permission list on every
feed/destination combination.

Before activation, verify a submitted webhook's actual server/channel against
the caller's operator-defined scope. A name or a user-supplied server/channel
claim is insufficient. Discord's
[webhook-token lookup](https://docs.discord.com/developers/resources/webhook#get-webhook-with-token)
returns webhook metadata without sending a message.

Webhook replacement must not redirect existing subscriptions outside their
authorized destination. Credential replacement for the same target and moving to
a different target need distinct treatment; registration authority alone must
not permit taking over an existing destination.

## Implementation requirements

- Separate feed catalog entries, destinations, and subscriptions so a feed can
  exist without a route. The current configuration requires at least one
  destination per feed.
- Enforce permissions in the shared server API for both browser and CLI clients.
  The current whole-configuration save needs scoped operations or authorization
  of every individual change, including deletions implied by omitted entries.
- Derive grants on the server and check them at the mutation boundary. Neither
  client-provided grant IDs nor hidden UI controls establish authorization.
- Verify membership in configured servers without treating unavailable checks as
  granted permissions. Removing a role or changing operator policy must remove
  the corresponding management authority.
- Preserve optimistic concurrency checks and bound catalog, destination, and
  subscription sizes. Adding unrouted feeds must not create unbounded storage.
- Cover mixed server/role grants, unauthorized channels, verified webhook
  activation, webhook replacement, source replacement without subscription
  transfer, bulk-save isolation, and role revocation with synthetic tests.

## Maintenance and upgrade decisions

- Feed administrators can rename feed labels and delete only unsubscribed feeds.
  Source URLs are immutable even when unused; replacements get separate IDs.
- Removing a management role leaves existing routes running.
- Catalog responses expose labels and opaque IDs, never raw source URLs. Channel
  administrators can route any catalog feed into their approved channels.
- Scoped destinations bind to exact servers/channels and reject thread targets.
  Rotation verifies the same binding. Delivery rechecks it before sending;
  Discord lookup and execution cannot be made atomic.
- Operators configure versioned JSON in `DISCORD_AUTH_POLICY`. Its absence keeps
  the single-role mode only while no catalog exists. Policy changes revoke
  sessions; malformed policies fail closed.
- Explicit catalog initialization verifies saved webhooks and atomically copies
  the existing routes, preserving delivery keys and ledger state. Failures leave
  the configuration unchanged. After initialization the old bulk API stays
  closed.
- A single-operation API checks fresh grants after uploads and provider
  requests, applies optimistic concurrency, and bounds the full stored
  configuration to 96 KiB, including unused catalog entries and webhook
  credentials.
