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

## Development

See the [development guide](docs/DEVELOPMENT.md) for local setup, project
layout, and checks.

## License

[MIT](LICENSE) © 2026 Jonathan Hitchcock.
