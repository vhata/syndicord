# syndicord

syndicord is an RSS-to-Discord relay that runs on Cloudflare Workers. It polls
feeds on a schedule and posts new entries to Discord through one or more
webhooks.

Each feed is mapped to its destinations: send a feed to a single channel,
share it across several channels, or bring multiple feeds together in one
channel. syndicord tracks delivered entries for each feed and destination
to pick up new posts on the next poll.

Messages carry titles, links, and descriptions from the feeds themselves,
so readers can follow updates in Discord and open the original posts for
the full story.

The first poll records a baseline without posting a backlog. Delivery state
is stored in D1, so destinations can retry independently. Each scheduled run
checks one feed and sends a bounded batch of pending entries.

Configure feeds in `feeds.json` and keep Discord webhook URLs in the
`WEBHOOKS` secret. See [configuration and operations](docs/OPERATIONS.md)
for setup and deployment, and [relay behavior](docs/BEHAVIOR.md) for delivery
semantics.

Use the [operational status command](docs/STATUS.md) to inspect feed health,
pending deliveries, and suspended destinations.

## Development

See the [development guide](docs/DEVELOPMENT.md) for local setup, project
layout, and checks.

## License

[MIT](LICENSE) © 2026 Jonathan Hitchcock.
