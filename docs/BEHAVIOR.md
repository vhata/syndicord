# Relay behavior

Each configured RSS or Atom feed has one or more named Discord destinations.
Webhook URLs are secrets. Each new entry produces one message per destination,
containing the original title, link, and a short description.

The first successful poll of a feed/destination pair records its existing
entries without sending them. A successful empty feed also establishes this
baseline. Fetch and parse failures do not establish a baseline. A newly added
destination gets its own baseline.

Entry identity uses the feed's stable ID, then its link, then a deterministic
fingerprint of its content. Identity is scoped to the full feed URL and the
destination name. Dates do not determine whether an entry is new. Changes to
an entry with the same identity do not send another message.

Pending deliveries retain their message data even after entries disappear
from a feed. Destinations succeed and retry independently. Removed feeds and
destinations stop receiving deliveries; restoring the same configuration
resumes their pending deliveries. A renamed destination starts a new baseline.

A durable lease prevents ordinary overlapping polling runs. Delivery records
change only while the run owns that lease. Failed or ambiguous webhook requests
remain retryable. A successful Discord send followed by a lost response or
failed database acknowledgement can produce a duplicate on retry.

Polling and delivery work are bounded. Feeds rotate between invocations so a
slow or broken feed does not block the others. No public HTTP endpoint triggers
polling. Logs identify feeds and destination names without webhook URLs or
response bodies.
