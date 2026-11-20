# Relay behavior

Each configured RSS or Atom feed has one or more named Discord destinations.
Webhook URLs are secrets. Each new entry produces one message per destination,
containing the original title, link, and a short description.

Messages show the feed name above a linked entry title, with a teal accent and a
source footer. A missing feed name falls back to the feed's hostname. The
feed-name link uses only the site's origin, keeping the configured feed path and
query private. Entry titles keep their supplied HTTP(S) links; missing or unsafe
links, and links matching the configured feed URL, use the same origin. Polling
and delivery identity still use the complete configured feed URL. The
description preserves paragraph breaks and shows up to three paragraphs within a
700-character excerpt. A repeated opening title is removed when it forms a
complete paragraph; ordinary prose beginning with the same words is preserved.
Long excerpts end with an ellipsis. The entry's publication time appears when
the feed provides a valid date.

Feed HTML is reduced to text and message mentions are disabled. Feed names are
stored with pending entries so retries retain their source attribution.

The first successful poll of a feed/destination pair records its existing
entries without sending them. A successful empty feed also establishes this
baseline. Fetch and parse failures do not establish a baseline. A newly added
destination gets its own baseline.

Entry identity uses the feed's stable ID, then its link, then a deterministic
fingerprint of its content. Identity is scoped to the full feed URL and the
destination name. Dates do not determine whether an entry is new. Changes to an
entry with the same identity do not send another message.

Pending deliveries retain their message data even after entries disappear from a
feed. Destinations succeed and retry independently. Removed feeds and
destinations stop receiving deliveries; restoring the same configuration resumes
their pending deliveries. A renamed destination starts a new baseline.

Invalid or inaccessible webhooks (HTTP 401, 403, or 404) suspend their
destination. Replacing its webhook or explicitly resuming it restores delivery;
pending entries retain their retry times. Rate limits postpone the affected
destination, or all destinations when Discord reports a global limit.

A durable lease prevents ordinary overlapping polling runs. Delivery records
change only while the run owns that lease. Failed or ambiguous webhook requests
remain retryable. A successful Discord send followed by a lost response or
failed database acknowledgement can produce a duplicate on retry.

Polling and delivery work are bounded. Feeds rotate between invocations so a
slow or broken feed does not block the others. No public HTTP endpoint triggers
polling. Logs identify feeds and destination names without webhook URLs or
response bodies.
