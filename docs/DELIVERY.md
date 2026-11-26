# How delivery works

**For anyone who wants the exact rules for when and how messages are sent.**
Day-to-day editing is in [Manage feeds and channels](FEEDS.md); health checks
are in [Operational status](STATUS.md).

Each subscribed RSS or Atom feed has one or more Discord destinations. A
**destination** is a saved webhook that posts to a channel; a **subscription**
connects a feed to that destination. Webhook URLs are secrets. Each new entry
produces one message per destination, containing the original title, link, and a
short description.

## Editing access and the shared catalog

Some configuration behavior depends on how the installation grants editing
access:

| Access model                              | Who can edit what                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **One admin role**                        | Members of one Discord role can manage every feed, webhook, and route.                                                        |
| **Separate feed and channel permissions** | Discord roles can manage the shared feed catalog, specified destination channels, or both. A person's matching roles combine. |

The **feed catalog** is the shared list of sources used with separate feed and
channel permissions. Everyone granted access can see its feed labels; channel
administrators can subscribe their channels to any catalog feed. A catalog feed
without subscriptions is saved but not polled. Saved source URLs stay hidden,
even from feed administrators. With one admin role, every saved feed must have
at least one destination and authorized editors can read its URL.

These are permissions to edit syndicord, not to manage its Cloudflare hosting.
See [access models and permissions](PERMISSIONS.md#access-models) for setup and
examples. The delivery rules below apply to both models unless stated otherwise.

## Messages

Messages show the feed name above a linked entry title, with a teal accent and a
source footer. A missing feed name falls back to the feed's hostname. The
feed-name link uses only the site's origin, keeping the configured feed path and
query private. Entry titles keep supplied HTTP(S) links that resolve without
inheriting the feed URL's path or query. Absolute links, root-relative links,
and links using an explicit public XML base retain their targets. Links that
need the private feed base, missing or unsafe links, and links matching the
configured feed URL (with or without a fragment) use the source origin. Queued
entries without presentation-link metadata also use the origin because their
original link base, including any redirect, is unknown. Polling and delivery
identity still use the complete configured feed URL and original resolved entry
link. The description preserves paragraph breaks and shows up to three
paragraphs within a 700-character excerpt. A repeated opening title is removed
when it forms a complete paragraph; ordinary prose beginning with the same words
is preserved. Long excerpts end with an ellipsis. The entry's publication time
appears when the feed provides a valid date.

Feed HTML is reduced to text and message mentions are disabled. Feed names are
stored with pending entries so retries retain their source attribution.

## Baselines and entry identity

The first successful poll of a feed/destination pair records its existing
entries without sending them. A successful empty feed also establishes this
baseline. Fetch and parse failures do not establish a baseline. A newly added
destination gets its own baseline.

An entry's identity uses its stable ID, then its link, then a deterministic
fingerprint of its content. Each entry is tracked separately for each full feed
URL and destination. Dates do not determine whether an entry is new. Changes to
an entry with the same identity do not send another message.

## Retries and configuration changes

Pending deliveries retain their message data even after entries disappear from a
feed. Destinations succeed and retry independently. Removed feeds and
destinations stop receiving deliveries; restoring the same configuration resumes
their pending deliveries. The access model affects how edits change delivery
history:

- **One admin role:** renaming a destination starts a new baseline.
- **Separate feed and channel permissions:** destination labels can change
  without affecting the fixed identifiers used to track delivery. Catalog feed
  URLs cannot change; a replacement source needs a new catalog entry and
  explicit subscription changes.

Invalid or inaccessible webhooks (HTTP 401, 403, or 404) suspend their
destination. Replacing its webhook or explicitly resuming it restores delivery;
pending entries retain their retry times. Rate limits postpone the affected
destination, or all destinations when Discord reports a global limit.

With separate feed and channel permissions, each delivery verifies that the
webhook still belongs to its registered server and channel. Lookup failures or
changed bindings defer pending messages without sending them. See
[destination verification](PERMISSIONS.md#destinations-and-webhook-rotation) for
the separate-request race and recovery behavior.

A durable lease prevents ordinary overlapping polling runs. Delivery records
change only while the run owns that lease. Failed or ambiguous webhook requests
remain retryable. A successful Discord send followed by a lost response or
failed database acknowledgement can produce a duplicate on retry.

Polling and delivery work are bounded. Feeds rotate between invocations so a
slow or broken feed does not block the others. No public HTTP endpoint triggers
polling. Logs identify feeds and destination names without webhook URLs or
response bodies.

## Polling limits

The default one-minute cron checks one feed and attempts at most five deliveries
per run across the whole installation, including retries. These small batches
bound network, parsing, and database work per invocation and spread delivery
bursts across runs. They are application limits, not Cloudflare or Discord
quotas, and do not guarantee five successful sends per minute. Sending one entry
to two destinations takes two deliveries.

With N subscribed feeds, each is checked about every N minutes. There is no
fixed limit on the number of feeds or feed/destination pairs; a feed sent to two
destinations uses two pairs. Larger installations take longer to revisit each
feed, and delivery backlogs grow when arrivals outpace successful sends. Entries
must remain in the source feed until its next poll to be observed; longer
rotations can miss entries removed between polls.

Each save is limited to 96 KiB of normalized JSON for the complete feed list and
webhook map, including unused saved destinations. With separate feed and channel
permissions, this bound also includes the shared catalog's metadata and feeds
without subscriptions. Only subscribed feeds enter the polling rotation. Remove
unused destinations or catalog feeds if a save reaches the 96 KiB limit.
Existing larger configurations remain readable so they can be reduced.

API requests are limited to 128 KiB. The CLI accepts responses up to 128 KiB
when one admin role manages everything, or 256 KiB with separate feed and
channel permissions because those responses also describe the caller's allowed
channels. These byte bounds limit configuration parsing and storage work; the 96
KiB save limit leaves room for revisions and metadata in the API envelope.

Installation capacity also depends on
[Cloudflare Workers CPU limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 database quotas](https://developers.cloudflare.com/d1/platform/limits/), and
Discord rate limits.

Runs use a 30-second delivery budget and stop starting deliveries early enough
to reserve time for a send, plus webhook verification when the installation uses
separate feed and channel permissions. This is not a hard timeout for the whole
run. Feed fetches, webhook verification, and sends have six-second deadlines so
a slow remote server cannot hold each request open indefinitely. A feed fetch's
deadline includes redirects and reading the body. Leases, retries, and Discord
cooldowns can delay work further.

Feeds must be UTF-8 XML, at most 256 KiB and 200 entries. These bounds limit
untrusted parsing and database ingestion work; oversized feeds are rejected, not
truncated to a subset of entries. At most three redirects are followed to bound
redirect chains, and HTTPS downgrades are rejected to preserve encrypted
transport. Malformed or unsupported XML does not change a baseline.

D1 retains entry identities indefinitely and clears pending payloads after
successful delivery. Keeping identities prevents old entries from being sent
again if they reappear in a feed; keeping pending payloads allows retries after
an entry leaves the source feed. Both can grow the database for busy feeds.
Monitor database growth and use [Operational status](STATUS.md) to inspect
pending delivery counts and ages.
